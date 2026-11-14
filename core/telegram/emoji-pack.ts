import type { MessageEntity } from 'grammy/types'
import { tg } from './api'

export type EmojiPack = Map<string, string>

const TTL = 6 * 3600 * 1000
const cache = new Map<string, { at: number, pack: EmojiPack | null }>()

export const normEmoji = (e: string) => e.replace(/️/g, '')

export function packName(value?: string | null): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  const m = v.match(/(?:addemoji|addstickers)\/([A-Za-z0-9_]{1,64})/) ?? v.match(/^([A-Za-z0-9_]{1,64})$/)
  return m ? m[1]! : null
}

export async function loadPack(value?: string | null): Promise<EmojiPack | null> {
  const name = packName(value)
  if (!name) return null
  const hit = cache.get(name)
  if (hit && Date.now() - hit.at < TTL) return hit.pack
  let pack: EmojiPack | null = null
  try {
    const set = await tg().getStickerSet(name)
    pack = new Map()
    for (const s of set.stickers) {
      if (s.type !== 'custom_emoji' || !s.custom_emoji_id || !s.emoji) continue
      const key = normEmoji(s.emoji)
      if (!pack.has(key)) pack.set(key, s.custom_emoji_id)
    }
    if (!pack.size) pack = null
  }
  catch (e) {
    console.warn('[emoji] набор не загружен', name, (e as Error).message)
    if (hit) return hit.pack
  }
  cache.set(name, { at: Date.now(), pack })
  return pack
}

const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}](?:[\u{1F3FB}-\u{1F3FF}])?|[☀-➿⌚-⏿⬅-⭕]️?|\p{Extended_Pictographic}️)(?:‍(?:[\u{1F000}-\u{1FAFF}]|\p{Extended_Pictographic})️?)*/gu

export function packPrompt(pack: EmojiPack): string {
  return `Эмодзи — только из фирменного набора компании, другие не используй: ${[...pack.keys()].join(' ')}`
}

export function keepPackEmoji(text: string, pack: EmojiPack): string {
  return text
    .replace(EMOJI_RE, e => (pack.has(normEmoji(e)) ? e : '\u0000'))
    .replace(/ ?\u0000 ?/g, (m) => (m.length === 3 ? ' ' : ''))
    .replace(/^(#{1,6}) {2,}/gm, '$1 ')
}

export function emojiMarkdown(md: string, pack: EmojiPack): string {
  return md.replace(EMOJI_RE, (e) => {
    const id = pack.get(normEmoji(e))
    return id ? `![](tg://emoji?id=${id})` : e
  })
}

export function emojiHtml(html: string, pack: EmojiPack): string {
  return html.split(/(<[^>]+>)/).map((part, i) => i % 2 ? part : part.replace(EMOJI_RE, (e) => {
    const id = pack.get(normEmoji(e))
    return id ? `<tg-emoji emoji-id="${id}">${e}</tg-emoji>` : e
  })).join('')
}

export function emojiEntities(text: string, pack: EmojiPack): MessageEntity[] {
  const out: MessageEntity[] = []
  for (const m of text.matchAll(EMOJI_RE)) {
    const id = pack.get(normEmoji(m[0]))
    if (id) out.push({ type: 'custom_emoji', offset: m.index!, length: m[0].length, custom_emoji_id: id })
  }
  return out
}
