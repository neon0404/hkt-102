import { and, desc, eq, inArray } from 'drizzle-orm'
import { aiGenerateImage, type AiRun } from '../ai/ops'
import { db, schema } from '../db/client'
import type { TenantSettings } from '../db/schema'
import { readMedia, saveMedia } from '../media'
import type { CardPhoto } from './card-templates'

type Tenant = { id: string, name: string, settings: TenantSettings }

export interface PhotoPick { buf: Buffer, photo: CardPhoto }

const UA = 'ai-marketer/1.0 (card renderer)'
const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'into', 'no', 'text', 'people', 'logos', 'photo', 'photorealistic', 'image', 'style', 'soft', 'clean', 'subtle', 'warm', 'natural', 'light', 'composition', 'atmosphere', 'space', 'negative', 'generous', 'still', 'life', 'tones', 'scene', 'view', 'close', 'modern'])
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOP.has(w)).map(w => w.slice(0, 5))

async function fromLibrary(tenantId: string, query: string, seen: Set<string>, relevant = false): Promise<PhotoPick | null> {
  const rows = await db.select().from(schema.media)
    .where(and(eq(schema.media.tenantId, tenantId), eq(schema.media.kind, 'photo')))
    .orderBy(desc(schema.media.createdAt)).limit(200)
  const q = new Set(words(query))
  const ranked = rows
    .filter(r => !seen.has(`media:${r.id}`))
    .map((r, i) => ({ r, score: words(r.title ?? '').filter(w => q.has(w)).length * 10 - i * 0.01 }))
    .sort((a, b) => b.score - a.score)
    .filter(x => !relevant || x.score > 0)
  for (const { r } of ranked) {
    const buf = await readMedia(tenantId, r.id)
    if (buf) return { buf, photo: { media_id: r.id, source: 'library', ref: `media:${r.id}`, credit: null } }
  }
  return null
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

async function fromWeb(tenantId: string, query: string, seen: Set<string>): Promise<PhotoPick | null> {
  const q = query.trim().slice(0, 100)
  if (!q) return null
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  Object.entries({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '24',
    gsrsearch: `${q} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|Artist', iiurlwidth: '1280',
  }).forEach(([k, v]) => url.searchParams.set(k, v))
  let pages: any[] = []
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const json = await res.json() as any
    pages = Object.values(json?.query?.pages ?? {}).sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
  }
  catch { return null }
  for (const p of pages) {
    const info = p.imageinfo?.[0]
    if (!info?.thumburl || !/image\/(jpeg|png|webp)/.test(info.mime ?? '')) continue
    if ((info.width ?? 0) < 1000 || (info.height ?? 0) < 600 || info.width / info.height > 2.4) continue
    const ref = `web:commons:${p.pageid}`
    if (seen.has(ref)) continue
    try {
      const img = await fetch(info.thumburl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
      if (!img.ok) continue
      const mime = img.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
      const buf = Buffer.from(await img.arrayBuffer())
      if (buf.length < 20_000) continue
      const meta = info.extmetadata ?? {}
      const credit = [stripHtml(meta.Artist?.value ?? ''), meta.LicenseShortName?.value, 'Wikimedia Commons'].filter(Boolean).join(' · ').slice(0, 200)
      const media = await saveMedia(tenantId, 'web', buf, mime, { title: credit })
      return { buf, photo: { media_id: media.id, source: 'web', ref, credit } }
    }
    catch { continue }
  }
  return null
}

async function fromAi(run: AiRun, tenant: Tenant, prompt: string): Promise<PhotoPick | null> {
  const brand = tenant.settings.brand ?? {}
  const style = `brand colors ${brand.primary ?? '#196c7f'}, photorealistic, no text, no logos, no people, no alcohol`
  const img = await aiGenerateImage(run, prompt, style)
  if (!img) return null
  const media = await saveMedia(tenant.id, 'generated', img.png, 'image/png')
  return { buf: img.png, photo: { media_id: media.id, source: 'ai', ref: `media:${media.id}`, credit: img.provider } }
}

export interface FindPhotoInput {
  query: string
  prompt?: string | null
  seen?: string[]
  run?: AiRun | null
  generate?: boolean
  any?: boolean
}

export async function findPhoto(tenant: Tenant, input: FindPhotoInput): Promise<PhotoPick | null> {
  const seen = new Set(input.seen ?? [])
  if (input.generate) return input.run ? fromAi(input.run, tenant, input.prompt || input.query) : null
  const lib = await fromLibrary(tenant.id, input.query, seen, true)
  if (lib) return lib
  if (input.run && tenant.settings.image_mode === 'ai_background' && input.prompt) {
    const ai = await fromAi(input.run, tenant, input.prompt)
    if (ai) return ai
  }
  const web = await fromWeb(tenant.id, input.query, seen)
  if (web) return web
  if (!input.any) return null
  return await fromLibrary(tenant.id, input.query, seen) ?? fromLibrary(tenant.id, input.query, new Set())
}

export async function photoBuffer(tenantId: string, photo: CardPhoto | null | undefined): Promise<Buffer | null> {
  return photo?.media_id ? readMedia(tenantId, photo.media_id) : null
}

export async function libraryPhotos(tenantId: string) {
  return db.select({ id: schema.media.id, title: schema.media.title, created_at: schema.media.createdAt }).from(schema.media)
    .where(and(eq(schema.media.tenantId, tenantId), eq(schema.media.kind, 'photo'))).orderBy(desc(schema.media.createdAt))
}

export async function removeLibraryPhotos(tenantId: string, ids: string[]) {
  if (!ids.length) return
  await db.update(schema.media).set({ kind: 'uploaded' })
    .where(and(eq(schema.media.tenantId, tenantId), eq(schema.media.kind, 'photo'), inArray(schema.media.id, ids)))
}
