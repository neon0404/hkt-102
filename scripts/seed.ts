import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { and, eq } from 'drizzle-orm'
import { config } from '../core/config'
import { db, pg, schema } from '../core/db/client'
import { runMigrations } from '../core/db/migrate'
import { pdfText } from '../core/kb/ingest'
import { saveMedia } from '../core/media'
import {
  addSource, AppError, connectTelegramChannel, createInvite, createTenant, ensureAdmin, saveSchedule, updateTenant,
} from '../core/services/admin'

const BRAND = 'materials/brand/elements/Основные и дополнительные визуальные элементы бренда'

async function cropPng(path: string, box: [number, number, number, number]): Promise<Buffer> {
  const src = await readFile(path)
  const [x, y, w, h] = box
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}"><image width="1200" height="1200" href="data:image/png;base64,${src.toString('base64')}"/></svg>`
  return Buffer.from(new Resvg(svg).render().asPng())
}

const quiet = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
  try { const r = await fn(); console.log('  +', label); return r }
  catch (e) {
    if (e instanceof AppError && e.status === 409) { console.log('  =', label, '(уже есть)'); return null }
    console.log('  !', label, '—', (e as Error).message); return null
  }
}

await runMigrations()
await ensureAdmin()

let [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'salavatsteklo'))
if (!tenant) {
  tenant = await createTenant({
    name: 'Салаватстекло',
    settings: {
      description: 'Группа компаний «Салаватстекло» — производитель листового и архитектурного стекла. Канал рассказывает о продукции, проектах, технологиях и жизни компании.',
      tone: 'уверенно, профессионально и по-человечески; без канцелярита и без хвастовства',
      approval_rule: 'any_one', daily_call_limit: 120, image_mode: 'template',
      brand: { primary: '#196C7F', secondary: '#285055', text_on_primary: '#ffffff' },
    },
  }, 'seed')
  console.log('Компания создана:', tenant.id)
}
else console.log('Компания уже есть:', tenant.id)
const tenantId = tenant.id

if (existsSync(BRAND) && !tenant.settings.brand?.logo_light_media_id) {
  const logoWhite = await cropPng(join(BRAND, 'ЛОГОТИП/БЕЛЫЙ/RUS/.PNG/ЛОГОТИП.png'), [150, 320, 990, 560])
  const logoColor = await cropPng(join(BRAND, 'ЛОГОТИП/ОСНОВНОЙ ЦВЕТ/RUS/.PNG/Логотип.png'), [150, 320, 990, 560])
  const fonts = join(BRAND, 'ШРИФТЫ/ОСНОВНЫЕ/AVENIR NEXT CYR')
  const light = await saveMedia(tenantId, 'logo', logoWhite, 'image/png', { title: 'Логотип (белый)' })
  const color = await saveMedia(tenantId, 'logo', logoColor, 'image/png', { title: 'Логотип (основной цвет)' })
  const regular = await saveMedia(tenantId, 'font', await readFile(join(fonts, 'avenirnextcyr-medium.ttf')), 'font/ttf', { title: 'Avenir Next Cyr Medium' })
  const bold = await saveMedia(tenantId, 'font', await readFile(join(fonts, 'avenirnextcyr-bold.ttf')), 'font/ttf', { title: 'Avenir Next Cyr Bold' })
  await updateTenant(tenantId, { settings: { brand: { logo_light_media_id: light.id, logo_media_id: color.id, font_regular_media_id: regular.id, font_bold_media_id: bold.id } } }, 'seed')
  console.log('Фирменные материалы загружены')
}

console.log('Источники:')
const bb = 'materials/brand/brandbook-2023-11-15.pdf'
if (existsSync(bb)) {
  const text = (await pdfText(await readFile(bb))).slice(0, 49_000)
  await quiet('Брендбук 2023 (текст)', () => addSource(tenantId, { kind: 'text', title: 'Брендбук «Салаватстекло», 2023', text }, 'seed'))
}
for (const [title, uri] of [
  ['О компании — официальный сайт', 'https://salstek.ru/o-kompanii/'],
  ['Карьера — официальный сайт', 'https://salstek.ru/career/'],
  ['Экология — официальный сайт', 'https://salstek.ru/o-kompanii/ecology/'],
  ['Каталог продукции группы компаний (PDF)', 'https://salstek.ru/upload/iblock/830/0d8nj0wm2n7l1pfh2jk18z09b2lj8bzd/Katalog-produktsii-GK-_RU_.pdf'],
] as const) {
  await quiet(title, () => addSource(tenantId, { kind: 'url', title, uri }, 'seed'))
}

console.log('Канал:')
if (config.telegramChannelId) {
  await quiet(`Telegram ${config.telegramChannelId}`, () => connectTelegramChannel(tenantId, { channel: config.telegramChannelId }, 'seed'))
}
else console.log('  ! TELEGRAM_CHANNEL_ID не задан — подключите канал в админке')

console.log('Расписания:')
const existing = await db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.tenantId, tenantId))
const ensureSchedule = async (type: any, cron: string, title: string, params: Record<string, unknown> = {}, enabled = true) => {
  if (existing.some(s => s.type === type)) return console.log('  =', title, '(уже есть)')
  await quiet(title, () => saveSchedule(tenantId, { type, cron, title, params, enabled }, 'seed'))
}
await ensureSchedule('auto_draft', '0 9 * * 1-5', 'Черновик поста по будням в 9:00')
await ensureSchedule('weekly_plan', '30 9 * * 1', 'Контент-план по понедельникам в 9:30')
await ensureSchedule('weekly_report', '0 17 * * 5', 'Отчёт по пятницам в 17:00')
await ensureSchedule('site_monitor', '0 */3 * * *', 'Новости сайта каждые 3 часа', { url: 'https://salstek.ru/news/' })
await ensureSchedule('collect_metrics', '0 8 * * *', 'Метрики канала ежедневно в 8:00')

const members = await db.select().from(schema.tenantMembers).where(and(eq(schema.tenantMembers.tenantId, tenantId), eq(schema.tenantMembers.status, 'active')))
if (!members.length) {
  const invite = await createInvite(tenantId, ['client', 'approver'], 72, 'seed')
  console.log('\nПриглашение (клиент + согласующий), действует 72 часа:\n ', invite.link)
}
else console.log(`Участников: ${members.length}`)

console.log(`\nАдминка: ${config.publicBaseUrl}  ·  вход: ${config.adminEmail} (пароль в .env, ADMIN_PASSWORD)`)
await pg.end()
