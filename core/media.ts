import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { config } from './config'
import { sha256 } from './crypto'
import { db, schema } from './db/client'

type MediaKind = typeof schema.media.$inferInsert['kind']

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt',
  'text/markdown': 'md', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/woff': 'woff',
}

export function mediaAbsolutePath(relPath: string): string {
  const abs = resolve(config.mediaDir, relPath)
  if (!abs.startsWith(resolve(config.mediaDir) + sep)) throw new Error('Некорректный путь файла')
  return abs
}

export async function saveMedia(
  tenantId: string, kind: MediaKind, data: Buffer, mime: string,
  extra: { title?: string, width?: number, height?: number, ext?: string } = {},
) {
  const hash = sha256(data)
  const ext = extra.ext || EXT[mime] || 'bin'
  const rel = join(tenantId, `${hash}.${ext}`).replace(/\\/g, '/')
  const abs = mediaAbsolutePath(rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, data)
  const [row] = await db.insert(schema.media).values({
    tenantId, kind, path: rel, mime, sha256: hash, title: extra.title, width: extra.width, height: extra.height,
  }).returning()
  return row!
}

export async function getMedia(tenantId: string, mediaId: string) {
  const [row] = await db.select().from(schema.media)
    .where(and(eq(schema.media.tenantId, tenantId), eq(schema.media.id, mediaId)))
  return row ?? null
}

export async function readMedia(tenantId: string, mediaId: string | null | undefined): Promise<Buffer | null> {
  if (!mediaId) return null
  const row = await getMedia(tenantId, mediaId)
  if (!row) return null
  return readFile(mediaAbsolutePath(row.path)).catch(() => null)
}
