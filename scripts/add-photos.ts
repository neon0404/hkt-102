import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { eq, or } from 'drizzle-orm'
import { db, schema } from '../core/db/client'
import { saveMedia } from '../core/media'

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

async function main() {
  const [who, dir] = process.argv.slice(2)
  if (!who || !dir) throw new Error('Использование: tsx scripts/add-photos.ts <slug|id> <папка>')
  const isId = /^[0-9a-f-]{36}$/i.test(who)
  const [tenant] = await db.select().from(schema.tenants).where(isId ? or(eq(schema.tenants.id, who), eq(schema.tenants.slug, who)) : eq(schema.tenants.slug, who))
  if (!tenant) throw new Error(`Компания «${who}» не найдена`)
  const existing = new Set((await db.select({ sha: schema.media.sha256 }).from(schema.media)
    .where(eq(schema.media.tenantId, tenant.id))).map(r => r.sha))
  let added = 0
  for (const name of (await readdir(dir)).sort()) {
    const mime = MIME[extname(name).toLowerCase()]
    if (!mime) continue
    const buf = await readFile(join(dir, name))
    const { sha256 } = await import('../core/crypto')
    if (existing.has(sha256(buf))) continue
    await saveMedia(tenant.id, 'photo', buf, mime, { title: name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') })
    added++
  }
  console.log(`«${tenant.name}»: добавлено фото — ${added}`)
  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
