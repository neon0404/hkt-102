import { lookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { mediaAbsolutePath } from '../media'

export class IngestError extends Error {}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) }
  catch { throw new IngestError('Некорректный адрес страницы') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new IngestError('Поддерживаются только http и https')
  const host = url.hostname
  if (host === 'localhost' || host.endsWith('.local')) throw new IngestError('Адреса локальной сети не принимаются')
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
  if (!addrs.length) throw new IngestError('Сайт не найден')
  if (addrs.some(a => isPrivateAddress(a.address))) throw new IngestError('Адреса локальной сети не принимаются')
  return url
}

export async function fetchUrlText(raw: string): Promise<{ title: string, text: string }> {
  const url = await assertPublicUrl(raw)
  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(20_000), redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AIMarketerBot/1.0)', 'accept-language': 'ru,en;q=0.8' },
    })
  }
  catch (e) {
    throw new IngestError((e as Error).name === 'TimeoutError' ? 'Сайт не ответил за 20 секунд' : 'Сайт недоступен')
  }
  if (!res.ok) throw new IngestError(`Сайт ответил кодом ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  const buf = Buffer.from(await res.arrayBuffer())
  if (type.includes('pdf') || url.pathname.toLowerCase().endsWith('.pdf')) {
    return { title: decodeURIComponent(url.pathname.split('/').pop() || url.hostname), text: await pdfText(buf) }
  }
  return htmlText(buf.toString('utf8'), url.hostname)
}

export async function htmlText(html: string, fallbackTitle = ''): Promise<{ title: string, text: string }> {
  const { parseHTML } = await import('linkedom')
  const { Readability } = await import('@mozilla/readability')
  const { document } = parseHTML(html)
  const title = (document.querySelector('title')?.textContent || fallbackTitle).trim()
  for (const el of document.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,form,header')) el.remove()
  const full = normalize(blockText(document.body ?? document.documentElement))
  let article = ''
  try {
    const { document: doc2 } = parseHTML(html)
    article = normalize(new Readability(doc2 as any).parse()?.textContent ?? '')
  }
  catch {}
  const text = full.length >= article.length * 0.8 ? full : article
  return { title, text }
}

function blockText(root: any): string {
  const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'TR', 'BR', 'SECTION', 'ARTICLE', 'TD', 'UL', 'OL'])
  let out = ''
  const walk = (node: any) => {
    if (node.nodeType === 3) { out += node.textContent; return }
    if (node.nodeType !== 1) return
    for (const child of node.childNodes) walk(child)
    if (BLOCK.has(node.tagName)) out += '\n'
  }
  walk(root)
  return out
}

export async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: true })
  return normalize(Array.isArray(text) ? text.join('\n') : text)
}

export async function docxText(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: buf })
  return normalize(value)
}

export function normalize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F�]/g, '').replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function chunkText(text: string, target = 1000, overlap = 100): string[] {
  const units: string[] = []
  for (const para of text.split(/\n+/).map(p => p.trim()).filter(Boolean)) {
    if (para.length <= target) { units.push(para); continue }
    let buf = ''
    for (const sentence of para.split(/(?<=[.!?…])\s+/)) {
      if (buf && (buf.length + sentence.length + 1) > target) { units.push(buf); buf = '' }
      if (sentence.length > target) {
        for (let i = 0; i < sentence.length; i += target) units.push(sentence.slice(i, i + target))
      }
      else buf = buf ? `${buf} ${sentence}` : sentence
    }
    if (buf) units.push(buf)
  }
  const chunks: string[] = []
  let cur = ''
  for (const unit of units) {
    if (cur && cur.length + unit.length + 1 > target * 1.2) {
      chunks.push(cur)
      cur = cur.slice(-overlap).replace(/^\S*\s/, '')
    }
    cur = cur ? `${cur}\n${unit}` : unit
  }
  if (cur.trim()) chunks.push(cur)
  return chunks.filter(c => c.trim().length > 20)
}

export async function ingestSource(tenantId: string, sourceId: string): Promise<{ chunks: number }> {
  const [source] = await db.select().from(schema.sources)
    .where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.id, sourceId)))
  if (!source) throw new IngestError('Источник не найден')
  await db.update(schema.sources).set({ status: 'processing', error: null }).where(eq(schema.sources.id, sourceId))
  try {
    let text = ''
    let title = source.title
    if (source.kind === 'text') text = normalize(source.rawText ?? '')
    else if (source.kind === 'url') {
      const page = await fetchUrlText(source.uri!)
      text = page.text
      if (!title) title = page.title
    }
    else {
      const [file] = await db.select().from(schema.media)
        .where(and(eq(schema.media.tenantId, tenantId), eq(schema.media.id, source.mediaId!)))
      if (!file) throw new IngestError('Файл источника не найден')
      const buf = await readFile(mediaAbsolutePath(file.path))
      const name = (source.uri ?? '').toLowerCase()
      if (name.endsWith('.pdf') || file.mime.includes('pdf')) text = await pdfText(buf)
      else if (name.endsWith('.docx') || file.mime.includes('wordprocessingml')) text = await docxText(buf)
      else text = normalize(buf.toString('utf8'))
    }
    if (text.length < 40) throw new IngestError('В источнике не найден текст (пустая страница или скан без текстового слоя)')
    const chunks = chunkText(text)
    await db.transaction(async (tx) => {
      await tx.delete(schema.kbChunks).where(and(eq(schema.kbChunks.tenantId, tenantId), eq(schema.kbChunks.sourceId, sourceId)))
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.insert(schema.kbChunks).values(
          chunks.slice(i, i + 200).map((c, j) => ({ tenantId, sourceId, ord: i + j, text: c })),
        )
      }
      await tx.update(schema.sources)
        .set({ status: 'ready', chunksCount: chunks.length, title: title || source.uri || 'Источник', error: null })
        .where(eq(schema.sources.id, sourceId))
    })
    return { chunks: chunks.length }
  }
  catch (e) {
    const message = e instanceof IngestError ? e.message : `Ошибка обработки: ${(e as Error).message}`.slice(0, 300)
    await db.update(schema.sources).set({ status: 'failed', error: message }).where(eq(schema.sources.id, sourceId))
    throw new IngestError(message)
  }
}
