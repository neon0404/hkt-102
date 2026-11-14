import type { AiRun } from '../ai/ops'
import type { CardOut } from '../ai/schemas'
import type { TenantSettings } from '../db/schema'
import { saveMedia } from '../media'
import { completeCardFields, extractCardFields, guessTemplate } from './card-extract'
import { renderCard } from './card-render'
import { CARD_TEMPLATES, type CardTemplateId, isCardTemplate, normalizeCard, type PostCard } from './card-templates'
import { findPhoto, photoBuffer } from './photos'

type Tenant = { id: string, name: string, settings: TenantSettings }

export function modelFields(c: CardOut): Record<string, string> {
  const out: Record<string, string> = {
    tag: c.tag, title: c.title, question: c.question, value: c.value, period: c.period, detail: c.detail, answer: c.answer,
  }
  c.items.slice(0, 3).forEach((it, i) => { out[`key${i}`] = it.key; out[`item${i}`] = it.text })
  return out
}

export interface CardSource { title: string, text: string, rubric?: string | null, card?: CardOut | null }

export function cardFor(src: CardSource, prev?: PostCard | null, opts: { refresh?: boolean } = {}): { template: CardTemplateId, fields: Record<string, string> } {
  const body = `${src.title}\n${src.text}`
  if (src.card) {
    const template = isCardTemplate(src.card.template) ? src.card.template : prev?.template ?? guessTemplate(body)
    return { template, fields: completeCardFields(template, modelFields(src.card), body, { title: src.title, rubric: src.rubric }) }
  }
  if (prev && opts.refresh) return { template: prev.template, fields: completeCardFields(prev.template, { tag: prev.fields.tag ?? '' }, body, { title: src.title, rubric: src.rubric }) }
  if (prev) return { template: prev.template, fields: { ...prev.fields } }
  const guessed = guessTemplate(body)
  const fields = extractCardFields(guessed, body, { title: src.title, rubric: src.rubric })
  const empty = CARD_TEMPLATES[guessed].fields.filter(f => !f.optional && !fields[f.key]).length
  if (empty === 0 || guessed === 'project') return { template: guessed, fields }
  return { template: 'project', fields: extractCardFields('project', body, { title: src.title, rubric: src.rubric }) }
}

export function switchTemplate(card: PostCard, template: CardTemplateId, src: { title: string, text: string, rubric?: string | null }): Record<string, string> {
  const rules = extractCardFields(template, `${src.title}\n${src.text}`, { title: src.title, rubric: src.rubric })
  const keep: Record<string, string> = {}
  const head = card.fields.title || card.fields.question || ''
  keep.tag = card.fields.tag || rules.tag || ''
  if (CARD_TEMPLATES[template].fields.some(f => f.key === 'title')) keep.title = card.fields.title || (head.endsWith('?') ? '' : head) || rules.title || ''
  if (CARD_TEMPLATES[template].fields.some(f => f.key === 'question')) keep.question = card.fields.question || (head.endsWith('?') ? head : '') || rules.question || ''
  return normalizeCard({ template, fields: { ...rules, ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v)) } })
}

export interface DrawOptions {
  run?: AiRun | null
  newPhoto?: boolean
  upload?: { buf: Buffer, mime: string, title?: string } | null
  query?: string | null
  prompt?: string | null
  generate?: boolean
}

export interface DrawnCard {
  card: PostCard
  mediaId: string
  overflow: string[]
  missing: string[]
  imageMeta: { kind: 'template' | 'generated', provider?: string, source?: string }
}

export async function drawCard(tenant: Tenant, input: { template: CardTemplateId, fields: Record<string, string>, photo?: PostCard['photo'], seen?: string[] }, opts: DrawOptions = {}): Promise<DrawnCard> {
  const card: PostCard = { template: input.template, fields: normalizeCard(input), photo: input.photo ?? null, seen: [...(input.seen ?? [])] }
  const tpl = CARD_TEMPLATES[card.template]
  let photo: Buffer | null = null
  if (tpl.photo) {
    if (opts.upload) {
      const m = await saveMedia(tenant.id, 'uploaded', opts.upload.buf, opts.upload.mime, { title: opts.upload.title })
      card.photo = { media_id: m.id, source: 'upload', ref: `media:${m.id}`, credit: null }
      photo = opts.upload.buf
    }
    else if (opts.newPhoto || opts.generate || !card.photo) {
      const seen = [...(card.seen ?? []), ...(card.photo?.ref ? [card.photo.ref] : [])]
      const query = (opts.query || card.fields.title || card.fields.question || tenant.name).slice(0, 100)
      const pick = await findPhoto(tenant, { query, prompt: opts.prompt, seen, run: opts.run, generate: opts.generate, any: opts.newPhoto })
      if (pick) {
        card.photo = pick.photo
        photo = pick.buf
      }
      else if (!card.photo) card.photo = { media_id: null, source: 'none' }
      card.seen = [...new Set(seen)].slice(-40)
    }
    if (!photo) photo = await photoBuffer(tenant.id, card.photo)
  }
  const res = await renderCard({ tenantId: tenant.id, tenantName: tenant.name, brand: tenant.settings.brand, template: card.template, fields: card.fields, photo })
  const ai = tpl.photo && card.photo?.source === 'ai'
  const media = await saveMedia(tenant.id, ai ? 'generated' : 'template', res.png, 'image/png', { width: 1080, height: 1080 })
  return {
    card, mediaId: media.id, overflow: res.overflow, missing: res.missing,
    imageMeta: { kind: ai ? 'generated' : 'template', ...(ai && card.photo?.credit ? { provider: card.photo.credit } : {}), source: tpl.photo ? card.photo?.source ?? 'none' : 'none' },
  }
}

export function photoQuery(src: { card?: CardOut | null, image_prompt?: string | null, title: string }): string {
  if (src.card?.photo_query?.trim()) return src.card.photo_query.trim()
  const prompt = src.image_prompt?.trim()
  if (prompt && !/^abstract/i.test(prompt)) return prompt.split(/[,.;]/)[0]!.split(/\s+/).slice(0, 5).join(' ')
  return src.title
}
