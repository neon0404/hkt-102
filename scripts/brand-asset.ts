import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../core/db/client'
import { saveMedia } from '../core/media'
import { updateTenant } from '../core/services/admin'

const FIELDS = { logo: 'logo_media_id', logo_light: 'logo_light_media_id', pattern: 'pattern_media_id', font_regular: 'font_regular_media_id', font_bold: 'font_bold_media_id' } as const
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff' }

async function main() {
  const [slug, slot, file] = process.argv.slice(2) as [string, keyof typeof FIELDS, string]
  if (!slug || !FIELDS[slot] || !file) throw new Error(`Использование: tsx scripts/brand-asset.ts <slug> <${Object.keys(FIELDS).join('|')}> <файл>`)
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug))
  if (!tenant) throw new Error(`Компания «${slug}» не найдена`)
  const ext = extname(file).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new Error('Неподдерживаемый тип файла')
  const kind = slot.startsWith('font') ? 'font' : slot === 'pattern' ? 'background' : 'logo'
  const media = await saveMedia(tenant.id, kind, await readFile(file), mime, { title: basename(file, ext), ext: ext.slice(1) })
  await updateTenant(tenant.id, { settings: { brand: { [FIELDS[slot]]: media.id } } }, 'console')
  console.log(`«${tenant.name}»: ${slot} = ${media.id}`)
  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
