import { AsyncLocalStorage } from 'node:async_hooks'
import { esc, sentListeners, tg } from './api'

export const mdEsc = (s: string) => s.replace(/([\\`*_~=|[\]#<>$])/g, '\\$1')

export const mdCell = (s: string) => mdEsc(s.replace(/\s*\n+\s*/g, ' ')).trim() || '—'

export function mdTable(head: string[], rows: string[][], align?: Array<'l' | 'c' | 'r'>): string {
  const sep = head.map((_, i) => ({ l: ':---', c: ':---:', r: '---:' })[align?.[i] ?? 'l'])
  return [`| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

export const mdDetails = (summary: string, body: string, open = false) =>
  `<details${open ? ' open' : ''}><summary>${summary}</summary>\n\n${body}\n\n</details>`

export function mdPlain(md: string): string {
  return md
    .replace(/<\/?(details|summary|u|ins|sub|sup|tg-[a-z-]+)[^>]*>/g, '')
    .replace(/^\|\s*:?-{3,}.*$/gm, '')
    .replace(/^\|\s*(.*?)\s*\|\s*$/gm, (_, row: string) => row.split(/\s*\|\s*/).filter(Boolean).join(' · '))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+\[[ x]\]\s+/gm, '$1• ')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/(\*\*|__|~~|==|\|\|)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\\([\\`*_~=|[\]#<>$])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface TgEntity { type: 'bold' | 'italic' | 'strikethrough' | 'spoiler' | 'code' | 'text_link' | 'blockquote', offset: number, length: number, url?: string }

const INLINE_RE = /\\([\\`*_~=|[\]#<>$-])|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:[^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|==(.+?)==|\|\|(.+?)\|\||(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])|(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g

function inlineEntities(s: string): { text: string, entities: TgEntity[] } {
  let text = ''
  const entities: TgEntity[] = []
  let last = 0
  for (const m of s.matchAll(INLINE_RE)) {
    text += s.slice(last, m.index)
    last = m.index! + m[0].length
    if (m[1] !== undefined) { text += m[1]; continue }
    if (m[2] !== undefined) { entities.push({ type: 'code', offset: text.length, length: m[2].length }); text += m[2]; continue }
    const [type, inner, url]: [TgEntity['type'], string, string?] = m[3] !== undefined
      ? ['text_link', m[3], m[4]]
      : m[5] !== undefined || m[6] !== undefined || m[8] !== undefined
        ? ['bold', (m[5] ?? m[6] ?? m[8])!]
        : m[7] !== undefined ? ['strikethrough', m[7]] : m[9] !== undefined ? ['spoiler', m[9]] : ['italic', (m[10] ?? m[11])!]
    const sub = inlineEntities(inner)
    if (sub.text) entities.push({ type, offset: text.length, length: sub.text.length, ...(url ? { url } : {}) })
    for (const e of sub.entities) entities.push({ ...e, offset: e.offset + text.length })
    text += sub.text
  }
  return { text: text + s.slice(last), entities }
}

export function mdEntities(md: string): { text: string, entities: TgEntity[] } {
  const lines = md.replace(/\r/g, '')
    .replace(/<summary>(.*?)<\/summary>/g, '\n**$1**\n')
    .replace(/<\/?(details|u|ins|sub|sup|tg-[a-z-]+)[^>]*>/g, '')
    .split('\n')
  let text = ''
  const entities: TgEntity[] = []
  let quoteStart = -1
  const push = (line: string, wrap?: TgEntity['type']) => {
    if (!line.trim() && (!text || text.endsWith('\n\n'))) return
    const { text: t, entities: ents } = inlineEntities(line)
    if (wrap && t.trim()) entities.push({ type: wrap, offset: text.length, length: t.length })
    for (const e of ents) entities.push({ ...e, offset: e.offset + text.length })
    text += `${t}\n`
  }
  const closeQuote = () => {
    if (quoteStart < 0) return
    const len = text.replace(/\n+$/, '').length - quoteStart
    if (len > 0) entities.push({ type: 'blockquote', offset: quoteStart, length: len })
    quoteStart = -1
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\s*>/.test(line)) {
      if (quoteStart < 0) quoteStart = text.length
      push(line.replace(/^\s*>\s?/, ''))
      continue
    }
    closeQuote()
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(line.trim())) continue
    if (/^\|\s*:?-{3,}/.test(line)) continue
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { push(''); continue }
    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) { push(h[1]!, 'bold'); continue }
    const row = line.match(/^\|\s*(.*?)\s*\|\s*$/)
    if (row) { push(row[1]!.split(/\s*(?<!\\)\|\s*/).filter(Boolean).join(' · ')); continue }
    push(line
      .replace(/^(\s*)[-*+]\s+\[x\]\s+/i, '$1✅ ')
      .replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ')
      .replace(/^(\s*)[-*+]\s+/, '$1• '))
  }
  closeQuote()
  const out = text.replace(/\s+$/, '')
  return { text: out, entities: entities.filter(e => e.length > 0 && e.offset < out.length).map(e => ({ ...e, length: Math.min(e.length, out.length - e.offset) })) }
}

export function mdToHtml(md: string): string {
  const inline = (s: string) => {
    const keep: string[] = []
    const out = s
      .replace(/\\([\\`*_~=|[\]#<>$])/g, (_, c: string) => `\u0000${keep.push(c) - 1}\u0000`)
      .replace(/`([^`]+)`/g, (_, c: string) => `\u0001${keep.push(`<code>${esc(c)}</code>`) - 1}\u0001`)
    return esc(out)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(\*\*|__)(.+?)\1/g, '<b>$2</b>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/==(.+?)==/g, '<u>$1</u>')
      .replace(/\|\|(.+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
      .replace(/(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])/g, '<i>$1</i>')
      .replace(/\u0000(\d+)\u0000/g, (_, i: string) => esc(keep[Number(i)]!))
      .replace(/\u0001(\d+)\u0001/g, (_, i: string) => keep[Number(i)]!)
  }
  const lines = md.replace(/<\/?(details|u|ins|sub|sup|tg-[a-z-]+)[^>]*>/g, '').replace(/<summary>(.*?)<\/summary>/g, '**$1**').split('\n')
  const out: string[] = []
  let quote: string[] = []
  const flush = () => { if (quote.length) { out.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = [] } }
  for (const line of lines) {
    if (/^>/.test(line)) { quote.push(inline(line.replace(/^>\s?/, ''))); continue }
    flush()
    if (/^\|\s*:?-{3,}/.test(line)) continue
    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) { out.push(`<b>${inline(h[1]!)}</b>`); continue }
    const row = line.match(/^\|\s*(.*?)\s*\|\s*$/)
    if (row) { out.push(row[1]!.split(/\s*\|\s*/).filter(Boolean).map(inline).join(' · ')); continue }
    if (/^---+$/.test(line.trim())) { out.push(''); continue }
    out.push(inline(line.replace(/^(\s*)[-*+]\s+\[x\]\s+/, '$1✅ ').replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ').replace(/^(\s*)[-*+]\s+/, '$1• ')))
  }
  flush()
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function sendRich(chatId: number | string, markdown: string, extra: Record<string, unknown> = {}) {
  const api = tg()
  try {
    return await (api.raw as any).sendRichMessage({ chat_id: chatId, rich_message: { markdown }, ...extra }) as { message_id: number }
  }
  catch (e) {
    console.warn('[tg] rich-сообщение не принято, отправляю обычным', chatId, (e as Error).message)
  }
  try {
    return await api.sendMessage(chatId, mdToHtml(markdown).slice(0, 4096), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra } as any)
  }
  catch (e) {
    console.warn('[tg] не удалось отправить сообщение', chatId, (e as Error).message)
    return null
  }
}

interface DraftState { chatId: number, draftId: number, text: string, timer?: ReturnType<typeof setInterval>, done: boolean, paused: boolean }
const store = new AsyncLocalStorage<DraftState>()
const active = new Set<DraftState>()
sentListeners.add((chatId) => { for (const s of active) if (String(s.chatId) === String(chatId)) s.paused = true })

function pushDraft(s: DraftState) {
  if (s.done || s.paused) return
  ;(tg().raw as any).sendRichMessageDraft({
    chat_id: s.chatId, draft_id: s.draftId,
    rich_message: { markdown: `<tg-thinking>${mdEsc(s.text)}</tg-thinking>` },
  }).catch(() => {})
}

export async function withThinking<T>(chatId: number | null | undefined, first: string, fn: () => Promise<T>): Promise<T> {
  if (!chatId || chatId < 0) return fn()
  const s: DraftState = { chatId, draftId: 1 + Math.floor(Math.random() * 2_000_000_000), text: first, done: false, paused: false }
  active.add(s)
  pushDraft(s)
  s.timer = setInterval(() => pushDraft(s), 20_000)
  try { return await store.run(s, fn) }
  finally { s.done = true; clearInterval(s.timer); active.delete(s) }
}

export function progress(text: string) {
  const s = store.getStore()
  if (!s || s.done || (s.text === text && !s.paused)) return
  s.text = text
  s.paused = false
  pushDraft(s)
}
