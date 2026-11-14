process.env.TELEGRAM_BOT_TOKEN = ''
process.env.LLM_PROVIDER = 'mock'
process.env.PUBLIC_BASE_URL = 'https://marketer.test'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { parseHTML } from 'linkedom'

const { db, pg, schema } = await import('../core/db/client')
const { runMigrations } = await import('../core/db/migrate')
const { createTenant } = await import('../core/services/admin')
const a = await import('../core/analytics')
const posts = await import('../core/services/posts')
const { sceneDurations, renderVideo, W, H } = await import('../core/video/render')

await runMigrations()
const created: string[] = []
after(async () => {
  if (created.length) for (const id of created) await db.delete(schema.tenants).where(eq(schema.tenants.id, id))
  await pg.end()
})

test('числа просмотров с t.me разбираются', () => {
  assert.equal(a.parseCount('6'), 6)
  assert.equal(a.parseCount('1.2K'), 1200)
  assert.equal(a.parseCount('3,4M'), 3_400_000)
  assert.equal(a.parseCount('—'), null)
})

test('страница канала: номер поста, просмотры и реакции', () => {
  const html = `
    <div class="tgme_widget_message" data-post="chan/41"><span class="tgme_widget_message_views">1.5K</span>
      <span class="tgme_reaction"><i class="emoji">👍</i>12</span><span class="tgme_reaction"><i class="emoji">🔥</i>3</span></div>
    <div class="tgme_widget_message" data-post="chan/42"><span class="tgme_widget_message_views">87</span></div>`
  const m = a.parseChannelPage(parseHTML, html)
  assert.deepEqual(m.get(41), { views: 1500, reactions: 15 })
  assert.deepEqual(m.get(42), { views: 87, reactions: 0 })
})

test('UTM-метки добавляются, свои параметры ссылки сохраняются', () => {
  const u = new URL(a.withUtm('https://site.ru/catalog/?id=5&utm_source=mail', { id: '12345678-aaaa' }, 'product'))
  assert.equal(u.searchParams.get('id'), '5')
  assert.equal(u.searchParams.get('utm_source'), 'mail')
  assert.equal(u.searchParams.get('utm_medium'), 'social')
  assert.equal(u.searchParams.get('utm_content'), 'product_12345678')
})

test('ссылка в посте ведёт через счётчик, уникальный переход считается один раз, боты не считаются', async () => {
  const t = await createTenant({ name: `Аналитика ${Date.now()}`, settings: { provider: 'mock' } }, 'test')
  created.push(t.id)
  const { post } = await posts.createPost(t.id, {
    draft: { title: 'Тест', text: 'Текст. Подробнее: https://example.com/page', hashtags: [], facts: [], warnings: [] }, origin: 'operator',
  })
  const text = 'Текст. Подробнее: https://example.com/page'
  const entities = await a.trackLinks(t.id, post, '00000000-0000-0000-0000-000000000000', text, 'project')
  assert.equal(entities.length, 1)
  const e = entities[0]! as { type: string, offset: number, length: number, url: string }
  assert.equal(text.slice(e.offset, e.offset + e.length), 'https://example.com/page')
  assert.match(e.url, /^https:\/\/marketer\.test\/r\/[\w-]+$/)
  const again = await a.trackLinks(t.id, post, '00000000-0000-0000-0000-000000000000', text, 'project')
  assert.equal((again[0] as any).url, e.url)

  const code = e.url.split('/').pop()!
  const target = await a.registerClick(code, '10.0.0.1', 'Mozilla/5.0 (iPhone)')
  assert.match(target!, /utm_source=telegram/)
  await a.registerClick(code, '10.0.0.1', 'Mozilla/5.0 (iPhone)')
  await a.registerClick(code, '10.0.0.2', 'Mozilla/5.0 (Android)')
  await a.registerClick(code, '10.0.0.3', 'TelegramBot (like TwitterBot)')
  assert.equal(await a.registerClick('nope-nope', '1.1.1.1', 'x'), null)
  const clicks = await db.select().from(schema.linkClicks).where(eq(schema.linkClicks.tenantId, t.id))
  assert.equal(clicks.length, 2)
})

test('сводка сравнивает макеты по средним просмотрам и считает переходы', async () => {
  const t = await createTenant({ name: `Форматы ${Date.now()}`, settings: { provider: 'mock' } }, 'test')
  created.push(t.id)
  const [integration] = await db.insert(schema.integrations).values({ tenantId: t.id, platform: 'telegram', externalId: `-100${Date.now()}`, username: 'test_chan' }).returning()
  const mk = async (template: string, views: number, rubric: string, hourUtc: number) => {
    const { post, version } = await posts.createPost(t.id, { draft: { title: template, text: 'Текст', hashtags: [], facts: [], warnings: [] }, origin: 'operator', rubric })
    await db.update(schema.postVersions).set({ card: { template: template as any, fields: {} } }).where(eq(schema.postVersions.id, version.id))
    const at = new Date(); at.setUTCHours(hourUtc, 0, 0, 0)
    const [pub] = await db.insert(schema.publications).values({
      tenantId: t.id, postId: post.id, versionId: version.id, integrationId: integration!.id, idempotencyKey: `${post.id}:x`,
      status: 'published', publishedAt: at, views, reactions: 1, externalPostId: '1',
    }).returning()
    return { post, pub: pub! }
  }
  await mk('plant', 900, 'История', 4)
  await mk('plant', 700, 'История', 4)
  const p3 = await mk('product', 200, 'Продукты', 12)
  const entities = await a.trackLinks(t.id, p3.post, p3.pub.id, 'https://example.com', 'product')
  await a.registerClick((entities[0] as any).url.split('/').pop(), '10.1.1.1', 'Mozilla/5.0')

  const perf = await a.postPerformance(t.id, 7, 'Asia/Yekaterinburg')
  assert.equal(perf.totals.views, 1800)
  assert.equal(perf.totals.clicks, 1)
  assert.equal(perf.byTemplate[0]!.key, 'plant')
  assert.equal(perf.byTemplate[0]!.avgViews, 800)
  assert.equal(perf.byTemplate.find(s => s.key === 'product')!.ctr, 0.5)
  assert.equal(perf.byRubric[0]!.label, 'История')
  assert.match(a.performanceText(perf), /Три вехи: постов 2, средние просмотры 800/)
})

test('текст для диктора: числа и проценты словами, латиница русскими буквами', async () => {
  const { speakable, numberToWords } = await import('../core/video/speech')
  assert.equal(numberToWords(2025), 'две тысячи двадцать пять')
  assert.equal(numberToWords(1), 'один')
  assert.equal(speakable('Clearview X2 пропускает 97% света, 4 мм'), 'клеарвью кс два пропускает девяносто семь процентов света, четыре миллиметра')
  assert.ok(!/[a-z0-9]/i.test(speakable('Ultraview R — 21 год, 3,5 м')))
})

test('длительность сцен: по разметке, но не короче времени чтения субтитра', () => {
  const d = sceneDurations([
    { time: '0–3 с', visual: '', voiceover: 'Коротко', on_screen: '', speech: '', photo_query: '' },
    { time: '3-9 с', visual: '', voiceover: 'Средний текст', on_screen: '', speech: '', photo_query: '' },
    { time: 'потом', visual: '', voiceover: 'x'.repeat(84), on_screen: '', speech: '', photo_query: '' },
  ], 30)
  assert.equal(d[0], 3)
  assert.equal(d[1], 6)
  assert.ok(d[2]! >= 7, `третья сцена ${d[2]}`)
})

const hasFfmpeg = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']).status === 0
test('ролик 9:16 собирается из сценария', { skip: !hasFfmpeg && 'ffmpeg не установлен' }, async () => {
  const r = await renderVideo({
    tenant: { id: '00000000-0000-0000-0000-000000000000', name: 'Компания', settings: { brand: { primary: '#2f6fb0' } } },
    script: {
      title: 'Тестовый ролик', duration_sec: 6, hook: 'Крючок',
      scenes: [
        { time: '0–2 с', visual: 'a', voiceover: 'Первая сцена', on_screen: 'Крючок', speech: '', photo_query: '' },
        { time: '2–4 с', visual: 'b', voiceover: 'Вторая сцена', on_screen: 'Суть', speech: '', photo_query: '' },
      ],
      shots_needed: [], caption: 'Подпись', notes: '',
    },
    offline: true,
  })
  assert.ok(r.mp4.length > 10_000)
  assert.equal(r.mp4.subarray(4, 8).toString(), 'ftyp')
  assert.equal(W / H, 9 / 16)
  assert.ok(r.durationSec >= 7)
})
