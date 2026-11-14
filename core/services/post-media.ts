import { and, desc, eq } from 'drizzle-orm'
import type { Api } from 'grammy'
import type { MessageEntity } from 'grammy/types'
import { db, schema } from '../db/client'
import type { PostFormat, PostGallery } from '../db/schema'
import { readMedia } from '../media'
import { GrammyError, InputFile } from '../telegram/api'
import { mdEntities } from '../telegram/rich'

export const GALLERY_MAX = 9

export function slidesOf(v: { imageMediaId: string | null, gallery: PostGallery | null }): string[] {
  return [v.imageMediaId, ...(v.gallery?.media_ids ?? [])].filter((x): x is string => !!x)
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3)

export async function pickGalleryPhotos(tenantId: string, query: string, exclude: string[], n: number): Promise<string[]> {
  if (n <= 0) return []
  const rows = await db.select({ id: schema.media.id, title: schema.media.title }).from(schema.media)
    .where(and(eq(schema.media.tenantId, tenantId), eq(schema.media.kind, 'photo')))
    .orderBy(desc(schema.media.createdAt)).limit(200)
  const q = new Set(words(query))
  const skip = new Set(exclude)
  return rows
    .filter(r => !skip.has(r.id))
    .map((r, i) => ({ id: r.id, score: words(r.title ?? '').filter(w => q.has(w)).length * 10 - i * 0.01 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(r => r.id)
}

const mdTags = (tags: string[]) => tags.map(t => `\\${t.startsWith('#') ? t : `#${t}`}`).join(' ')

export function richMarkdown(body: string, hashtags: string[], slideIds: string[], mode: PostGallery['mode'] = 'slideshow'): string {
  const imgs = slideIds.map(id => `![](tg://photo?id=${id})`)
  const media = imgs.length > 1 ? `<tg-${mode}>\n${imgs.join('\n')}\n</tg-${mode}>` : imgs[0] ?? ''
  return [media, body.trim(), hashtags.length ? mdTags(hashtags) : ''].filter(Boolean).join('\n\n')
}

export function classicText(_format: PostFormat, text: string): string {
  return mdEntities(text).text
}

const mediaRef = (id: string) => `m${id.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64)

export async function sendRichWithMedia(
  api: Api, chatId: number | string, markdown: string, mediaIds: string[], tenantId: string, extra: Record<string, unknown> = {},
): Promise<number> {
  const media: Array<{ id: string, media: { type: 'photo', media: InputFile } }> = []
  let md = markdown
  for (const id of mediaIds) {
    const buf = await readMedia(tenantId, id)
    const ref = mediaRef(id)
    if (!buf) { md = md.replace(`![](tg://photo?id=${id})`, ''); continue }
    md = md.replace(`tg://photo?id=${id}`, `tg://photo?id=${ref}`)
    media.push({ id: ref, media: { type: 'photo', media: new InputFile(buf, `${ref}.png`) } })
  }
  md = md.replace(/<tg-(slideshow|collage)>\s*<\/tg-\1>\n*/g, '')
  const res = await (api.raw as any).sendRichMessage({ chat_id: chatId, rich_message: { markdown: md, media, skip_entity_detection: false }, ...extra })
  return (res as { message_id: number }).message_id
}

export async function sendAlbum(
  api: Api, chatId: number | string, mediaIds: string[], tenantId: string,
  caption?: { text: string, entities?: MessageEntity[], parse_mode?: 'HTML' },
): Promise<number | null> {
  const items: Array<{ type: 'photo', media: InputFile, caption?: string, caption_entities?: MessageEntity[], parse_mode?: 'HTML' }> = []
  for (const id of mediaIds.slice(0, 10)) {
    const buf = await readMedia(tenantId, id)
    if (buf) items.push({ type: 'photo', media: new InputFile(buf, `${mediaRef(id)}.png`) })
  }
  if (!items.length) return null
  if (caption) Object.assign(items[0]!, { caption: caption.text, caption_entities: caption.entities, parse_mode: caption.parse_mode })
  if (items.length === 1) {
    const m = await api.sendPhoto(chatId, items[0]!.media, { caption: caption?.text, caption_entities: caption?.entities, parse_mode: caption?.parse_mode })
    return m.message_id
  }
  const sent = await api.sendMediaGroup(chatId, items)
  return sent[0]?.message_id ?? null
}

export const richRejected = (e: unknown) => e instanceof GrammyError && e.error_code === 400
