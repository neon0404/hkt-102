const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(src: string): string {
  const keep: string[] = []
  const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`
  const s = src
    .replace(/\\([\\`*_~=|[\]#<>$-])/g, (_, c: string) => hold(escHtml(c)))
    .replace(/`([^`]+)`/g, (_, c: string) => hold(`<code class="rounded bg-muted px-1 py-0.5 text-[0.9em]">${escHtml(c)}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_, t: string, u: string) => hold(`<a href="${escHtml(u)}" target="_blank" rel="noopener" class="text-primary underline underline-offset-2">${escHtml(t)}</a>`))
    .replace(/https?:\/\/[^\s<\u0000]+[^\s<\u0000.,;:!?)*_~|=]/g, (u: string) => hold(`<a href="${escHtml(u)}" target="_blank" rel="noopener" class="text-primary underline underline-offset-2 break-all">${escHtml(u)}</a>`))
  return escHtml(s)
    .replace(/(\*\*|__)(.+?)\1/g, '<strong class="font-semibold text-highlighted">$2</strong>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/==(.+?)==/g, '<mark class="rounded bg-amber-100 px-0.5 text-inherit">$1</mark>')
    .replace(/\|\|(.+?)\|\|/g, '<span class="rounded bg-glass-300 text-transparent hover:text-inherit">$1</span>')
    .replace(/(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])/g, '<em>$1</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => keep[Number(i)]!)
}

const cells = (row: string) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim())

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let i = 0
  const para: string[] = []
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para.length = 0 } }
  while (i < lines.length) {
    const line = lines[i]!
    const t = line.trim()
    if (!t) { flushPara(); i++; continue }
    if (/^<\/?tg-(slideshow|collage)>$/.test(t) || /^!\[[^\]]*\]\([^)]*\)$/.test(t)) { i++; continue }
    const det = t.match(/^<details( open)?><summary>(.*?)<\/summary>(.*)$/)
    if (det) { flushPara(); out.push(`<details class="rounded-tile-sm bg-muted px-4 py-3"${det[1] ?? ''}><summary class="cursor-pointer font-semibold text-highlighted">${inline(det[2]!)}</summary><div class="mt-2 space-y-2">`); if (det[3]) para.push(det[3]); i++; continue }
    if (t === '</details>') { flushPara(); out.push('</div></details>'); i++; continue }
    if (t.startsWith('```')) {
      flushPara()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i++]!)
      i++
      out.push(`<pre class="overflow-x-auto rounded-tile-sm bg-muted p-3 text-meta"><code>${escHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushPara()
      const size = h[1]!.length <= 2 ? 'text-title' : 'text-heading'
      out.push(`<p class="${size} pt-1 font-bold tracking-tight text-highlighted">${inline(h[2]!)}</p>`)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); out.push('<hr class="border-default">'); i++; continue }
    if (t.startsWith('>')) {
      flushPara()
      const q: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('>')) q.push(lines[i++]!.trim().replace(/^>\s?/, ''))
      out.push(`<blockquote class="border-l-4 border-primary pl-3 text-toned">${q.map(x => x ? inline(x) : '').join('<br>').replace(/(<br>){2,}/g, '<br><br>')}</blockquote>`)
      continue
    }
    if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      flushPara()
      const head = cells(t)
      const align = cells(lines[i + 1]!).map(c => c.endsWith(':') ? (c.startsWith(':') ? 'text-center' : 'text-right') : 'text-left')
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!.trim()))
      const th = head.map((c, k) => `<th class="px-3 py-2 font-semibold ${align[k] ?? ''}">${inline(c)}</th>`).join('')
      const tb = rows.map(r => `<tr class="border-t border-default">${r.map((c, k) => `<td class="px-3 py-2 ${align[k] ?? ''}">${inline(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<div class="overflow-x-auto rounded-tile-sm bg-muted"><table class="w-full text-meta"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`)
      continue
    }
    const li = t.match(/^([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      flushPara()
      const ordered = /\d/.test(li[1]!)
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i]!.trim().match(/^([-*+]|\d+[.)])\s+(.*)$/)
        if (!m || /\d/.test(m[1]!) !== ordered) break
        const task = m[2]!.match(/^\[([ x])\]\s+(.*)$/)
        items.push(task ? `<li class="list-none -ml-5">${task[1] === 'x' ? '☑' : '☐'} ${inline(task[2]!)}</li>` : `<li>${inline(m[2]!)}</li>`)
        i++
      }
      out.push(`<${ordered ? 'ol' : 'ul'} class="${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5 marker:text-primary">${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    para.push(t)
    i++
  }
  flushPara()
  return out.join('')
}

export function plainMarkdown(md: string): string {
  return md
    .replace(/<\/?(details|summary|u|ins|sub|sup|tg-[a-z-]+)[^>]*>/g, '')
    .replace(/^!\[[^\]]*\]\([^)]*\)$/gm, '')
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
    .replace(/\\([\\`*_~=|[\]#<>$-])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
