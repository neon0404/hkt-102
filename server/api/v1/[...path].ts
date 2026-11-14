import { readFile } from 'node:fs/promises'
import { decryptSecret } from '~~/core/crypto'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { callsToday, tenantProvider } from '~~/core/ai/ops'
import { getProvider, PROVIDER_LABELS, type ProviderName } from '~~/core/ai/provider'
import { codexLoginStatus } from '~~/core/ai/providers/codex'
import { toJsonSchema } from '~~/core/ai/schemas'
import { audit } from '~~/core/audit'
import { config } from '~~/core/config'
import { verifyPassword } from '~~/core/crypto'
import { db, schema } from '~~/core/db/client'
import { dashboard, postPerformance, refreshPostStats } from '~~/core/analytics'
import { metricsSummary } from '~~/core/jobs/handlers'
import { enqueue } from '~~/core/jobs/queue'
import { toolList } from '~~/core/mcp/server'
import { createApiToken, listApiTokens, revokeApiToken } from '~~/core/mcp/tokens'
import { chunksByIds } from '~~/core/kb/search'
import { getMedia, mediaAbsolutePath, saveMedia } from '~~/core/media'
import {
  addSource, AppError, brandProfileState, conflict, connectTelegramChannel, createInvite, createTenant, ensureAdmin, invalid,
  notFound, connectVkGroup, publicIntegration, runScheduleNow, saveSchedule, SCHEDULE_LABELS, tenantSetup, updateTenant,
} from '~~/core/services/admin'
import {
  addVersion, checkDraft, createPost, decideApproval, getPost, PostStateError, publishNow, reschedulePost, resendForApproval, sendForApproval, submitChangeRequest, updatePostCard, updatePostLayout,
} from '~~/core/services/posts'
import { CARD_TEMPLATES, cardFields, isCardTemplate } from '~~/core/image/card-templates'
import { libraryPhotos, removeLibraryPhotos } from '~~/core/image/photos'
import { listPosts, postDetail } from '~~/core/services/views'
import { getBotInfo, tg } from '~~/core/telegram/api'
import type { H3Event } from 'h3'
import { z } from 'zod'
import type { CardPatch, LayoutPatch } from '~~/core/services/posts'

async function sendMediaFile(event: H3Event, m: { mime: string, path: string }) {
  setHeader(event, 'content-type', m.mime)
  setHeader(event, 'cache-control', 'private, max-age=3600')
  const data = await readFile(mediaAbsolutePath(m.path))
  if (!m.mime.startsWith('video/')) return data
  setHeader(event, 'accept-ranges', 'bytes')
  const range = /^bytes=(\d*)-(\d*)$/.exec(getHeader(event, 'range') ?? '')
  if (!range) return data
  const size = data.length
  let start = range[1] ? Number(range[1]) : size - Number(range[2])
  let end = range[1] && range[2] ? Number(range[2]) : size - 1
  start = Math.max(0, start); end = Math.min(size - 1, end)
  if (start > end) { setResponseStatus(event, 416); setHeader(event, 'content-range', `bytes */${size}`); return '' }
  setResponseStatus(event, 206)
  setHeader(event, 'content-range', `bytes ${start}-${end}/${size}`)
  return data.subarray(start, end + 1)
}

const uuid = (v: string, what = 'Объект') => { if (!/^[0-9a-f-]{36}$/i.test(v)) throw notFound(what); return v }
const failures = new Map<string, { n: number, until: number }>()
let adminReady: Promise<void> | null = null

route('POST', '/auth/login', async ({ event, body }) => {
  await (adminReady ??= ensureAdmin())
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const f = failures.get(ip)
  if (f && f.until > Date.now()) throw new AppError(429, 'limit_exceeded', 'Слишком много попыток. Повторите через 30 секунд.')
  const [user] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, String(body.email ?? '').trim().toLowerCase()))
  if (!user || !verifyPassword(String(body.password ?? ''), user.passwordHash)) {
    const n = (f?.n ?? 0) + 1
    failures.set(ip, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 30_000 : 0 })
    throw new AppError(401, 'unauthorized', 'Неверный e-mail или пароль')
  }
  failures.delete(ip)
  createSession(event, user.email)
  await audit(null, 'operator', user.email, 'operator.login')
  return { email: user.email }
}, { auth: 'public' })

route('POST', '/auth/logout', ({ event }) => { deleteCookie(event, SESSION_COOKIE, { path: '/' }); return { ok: true } }, { auth: 'public' })
route('GET', '/auth/me', ({ operator }) => ({ email: operator }))

route('GET', '/health', async () => {
  let dbOk = false
  let workerAt: string | null = null
  try {
    const [row] = await db.select().from(schema.systemState).where(eq(schema.systemState.key, 'worker'))
    dbOk = true
    workerAt = (row?.value.at as string) ?? null
  }
  catch {}
  const workerOk = !!workerAt && Date.now() - new Date(workerAt).getTime() < 90_000
  return { status: dbOk && workerOk ? 'ok' : 'degraded', db: dbOk, worker: workerOk, worker_seen_at: workerAt }
}, { auth: 'public' })

route('GET', '/system/providers', async () => {
  const codex = await codexLoginStatus()
  let bot: { username: string } | null = null
  try { bot = await getBotInfo() }
  catch {}
  return {
    default_provider: config.llmProvider,
    bot,
    public_base_url: config.publicBaseUrl,
    providers: [
      { name: 'chatgpt_account', label: PROVIDER_LABELS.chatgpt_account, ready: codex.ok, status: codex.text, billing: 'Лимиты подписки ChatGPT, без оплаты за вызов', model: config.codexModel || 'по умолчанию в Codex CLI' },
      { name: 'api', label: PROVIDER_LABELS.api, ready: !!config.llmApiKey, status: config.llmApiKey ? `Ключ задан, ${config.llmApiBaseUrl}` : 'LLM_API_KEY не задан', billing: 'Отдельная оплата по тарифам API', model: config.llmModel || '—' },
      { name: 'mock', label: PROVIDER_LABELS.mock, ready: true, status: 'Всегда доступна', billing: 'Без модели и без расхода', model: 'mock' },
    ],
  }
})

route('POST', '/tenants/:t/provider-test', async ({ tenantId, body, operator }) => {
  const name = (body.provider || await tenantProvider(tenantId)) as ProviderName
  if (!['mock', 'api', 'chatgpt_account'].includes(name)) throw invalid('Неизвестный провайдер')
  const started = Date.now()
  try {
    const res = await getProvider(name).generateStructured({
      operation: 'provider_test', schemaName: 'provider_test', timeoutMs: 90_000,
      schema: toJsonSchema(z.object({ answer: z.string() })),
      system: 'Ответь одной короткой фразой по-русски.', user: 'Назови себя и подтверди, что готов писать посты для компании.',
    })
    await db.insert(schema.llmUsage).values({ tenantId, provider: res.provider, model: res.model, operation: 'provider_test', inputTokens: res.inputTokens, outputTokens: res.outputTokens, durationMs: res.durationMs })
    await audit(tenantId, 'operator', operator, 'provider.tested', 'provider', name, { ok: true, ms: res.durationMs })
    return { ok: true, provider: res.provider, model: res.model, duration_ms: res.durationMs, input_tokens: res.inputTokens, output_tokens: res.outputTokens, answer: (res.data as any)?.answer ?? JSON.stringify(res.data) }
  }
  catch (e) {
    await audit(tenantId, 'operator', operator, 'provider.tested', 'provider', name, { ok: false, error: (e as Error).message })
    return { ok: false, provider: name, duration_ms: Date.now() - started, error: (e as Error).message, kind: (e as any).kind ?? 'unknown' }
  }
})

async function tenantView(t: typeof schema.tenants.$inferSelect) {
  const s = await tenantSetup(t.id)
  return { id: t.id, name: t.name, slug: t.slug, timezone: t.timezone, status: s.status, settings: t.settings, setup: s.setup, created_at: t.createdAt }
}

route('GET', '/tenants', async () => {
  const rows = await db.select().from(schema.tenants).orderBy(schema.tenants.createdAt)
  return Promise.all(rows.map(tenantView))
})
route('POST', '/tenants', async ({ body, operator }) => tenantView(await createTenant(body, operator)), { status: 201 })
route('GET', '/tenants/:t', async ({ tenantId }) => {
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  return { ...await tenantView(t!), calls_today: await callsToday(tenantId), provider_effective: await tenantProvider(tenantId) }
})
route('PATCH', '/tenants/:t', async ({ tenantId, body, operator }) => tenantView(await updateTenant(tenantId, body, operator)))

route('GET', '/tenants/:t/sources', ({ tenantId, query }) =>
  db.select({
    id: schema.sources.id, kind: schema.sources.kind, scope: schema.sources.scope, uri: schema.sources.uri, title: schema.sources.title,
    status: schema.sources.status, error: schema.sources.error, chunks_count: schema.sources.chunksCount, created_at: schema.sources.createdAt,
  }).from(schema.sources)
    .where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.scope, query.scope === 'competitor' ? 'competitor' : 'company')))
    .orderBy(desc(schema.sources.createdAt)))

route('POST', '/tenants/:t/sources', async ({ event, tenantId, body, operator }) => {
  const type = getHeader(event, 'content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const parts = await readMultipartFormData(event) ?? []
    const file = parts.find(p => p.name === 'file' && p.filename)
    if (!file) throw invalid('Файл не передан')
    const title = parts.find(p => p.name === 'title')?.data.toString('utf8')
    return addSource(tenantId, { kind: 'file', title, file: { name: file.filename!, data: file.data, mime: file.type ?? '' } }, operator)
  }
  if (Array.isArray(body.urls)) {
    const urls = (body.urls as string[]).map(u => String(u).trim()).filter(Boolean).slice(0, 20)
    if (!urls.length) throw invalid('Укажите хотя бы один адрес')
    const results = []
    for (const uri of urls) {
      try { results.push({ uri, ok: true, id: (await addSource(tenantId, { kind: 'url', uri }, operator)).id }) }
      catch (e) { results.push({ uri, ok: false, error: (e as Error).message }) }
    }
    return { results }
  }
  return addSource(tenantId, { kind: body.kind, uri: body.uri, title: body.title, text: body.text }, operator)
}, { status: 202 })

route('POST', '/tenants/:t/sources/:id/reprocess', async ({ tenantId, params }) => {
  const [s] = await db.update(schema.sources).set({ status: 'pending', error: null })
    .where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.id, uuid(params.id!, 'Источник')))).returning()
  if (!s) throw notFound('Источник')
  const job_run_id = await enqueue({ tenantId, type: 'ingest_source', payload: { source_id: s.id }, maxAttempts: 2 })
  return { job_run_id }
}, { status: 202 })

const mcpUrl = () => `${config.publicBaseUrl.replace(/\/$/, '')}/mcp`

route('GET', '/tenants/:t/mcp-tokens', async ({ tenantId }) => ({ url: mcpUrl(), tokens: await listApiTokens(tenantId), tools: toolList().map(t => ({ name: t.name, description: t.description, read_only: t.annotations.readOnlyHint })) }))

route('POST', '/tenants/:t/mcp-tokens', async ({ tenantId, body, operator }) => {
  try {
    const t = await createApiToken(tenantId, String(body.name ?? ''), operator)
    return { ...t, url: mcpUrl() }
  }
  catch (e) { throw invalid((e as Error).message) }
}, { status: 201 })

route('DELETE', '/tenants/:t/mcp-tokens/:id', async ({ tenantId, params, operator }) => {
  if (!await revokeApiToken(tenantId, uuid(params.id!, 'Токен'), operator)) throw notFound('Токен')
  return { ok: true }
})

route('DELETE', '/tenants/:t/sources/:id', async ({ tenantId, params, operator }) => {
  const [s] = await db.delete(schema.sources).where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.id, uuid(params.id!, 'Источник')))).returning()
  if (!s) throw notFound('Источник')
  await audit(tenantId, 'operator', operator, 'source.deleted', 'source', s.id, { title: s.title })
})

route('GET', '/tenants/:t/brand-profile', async ({ tenantId }) => {
  const state = await brandProfileState(tenantId)
  const ids = (state.current?.data.facts ?? []).map(f => f.chunk_id).filter((x): x is string => !!x)
  const chunks = ids.length
    ? await db.select({ id: schema.kbChunks.id, title: schema.sources.title, text: schema.kbChunks.text })
        .from(schema.kbChunks).innerJoin(schema.sources, eq(schema.sources.id, schema.kbChunks.sourceId))
        .where(and(eq(schema.kbChunks.tenantId, tenantId), inArray(schema.kbChunks.id, ids)))
    : []
  const [running] = await db.select({ id: schema.jobRuns.id, status: schema.jobRuns.status, error: schema.jobRuns.error })
    .from(schema.jobRuns).where(and(eq(schema.jobRuns.tenantId, tenantId), eq(schema.jobRuns.type, 'build_brand_profile')))
    .orderBy(desc(schema.jobRuns.createdAt)).limit(1)
  return { ...state, fact_sources: Object.fromEntries(chunks.map(c => [c.id, { title: c.title, excerpt: c.text.slice(0, 240) }])), last_job: running ?? null }
})

route('POST', '/tenants/:t/brand-profile/generate', async ({ tenantId, operator }) => {
  const [ready] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sources)
    .where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.status, 'ready'), eq(schema.sources.scope, 'company')))
  if (!ready?.n) throw invalid('Сначала добавьте источники и дождитесь их обработки')
  const minute = new Date().toISOString().slice(0, 16)
  const job_run_id = await enqueue({ tenantId, type: 'build_brand_profile', dedupKey: `brand:${tenantId}:${minute}`, maxAttempts: 2 })
  await audit(tenantId, 'operator', operator, 'brand_profile.requested')
  return { job_run_id }
}, { status: 202 })

const profileInput = z.object({
  description: z.string().max(2000), products: z.array(z.string()), audiences: z.array(z.string()), advantages: z.array(z.string()),
  tone: z.string().max(500), rubrics: z.array(z.string()), forbidden: z.array(z.string()), required_phrases: z.array(z.string()),
  facts: z.array(z.object({ claim: z.string(), chunk_id: z.string().nullable() })), strategy: z.string().max(3000).optional(),
})

route('PUT', '/tenants/:t/brand-profile', async ({ tenantId, body, operator }) => {
  const parsed = profileInput.safeParse(body)
  if (!parsed.success) throw invalid('Профиль заполнен неверно', { issues: parsed.error.issues.slice(0, 5) })
  const ids = parsed.data.facts.map(f => f.chunk_id).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x))
  const own = new Set(ids.length ? (await db.select({ id: schema.kbChunks.id }).from(schema.kbChunks).where(and(eq(schema.kbChunks.tenantId, tenantId), inArray(schema.kbChunks.id, ids)))).map(r => r.id) : [])
  const data = { ...parsed.data, facts: parsed.data.facts.filter(f => f.claim.trim()).map(f => ({ claim: f.claim.trim(), chunk_id: f.chunk_id && own.has(f.chunk_id) ? f.chunk_id : null })) }
  const [{ v }] = await db.select({ v: sql<number>`coalesce(max(${schema.brandProfiles.version}), 0)::int` }).from(schema.brandProfiles).where(eq(schema.brandProfiles.tenantId, tenantId)) as [{ v: number }]
  const [row] = await db.insert(schema.brandProfiles).values({ tenantId, version: v + 1, status: 'draft', data }).returning()
  await audit(tenantId, 'operator', operator, 'brand_profile.edited', 'brand_profile', row!.id, { version: v + 1 })
  return row
})

route('POST', '/tenants/:t/brand-profile/confirm', async ({ tenantId, operator }) => {
  const { current } = await brandProfileState(tenantId)
  if (!current) throw invalid('Профиль ещё не сформирован')
  const [row] = await db.update(schema.brandProfiles).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(schema.brandProfiles.id, current.id)).returning()
  await audit(tenantId, 'operator', operator, 'brand_profile.confirmed', 'brand_profile', current.id, { version: current.version })
  await tenantSetup(tenantId)
  return row
})

const ASSET_FIELDS = { logo: 'logo_media_id', logo_light: 'logo_light_media_id', pattern: 'pattern_media_id', font_regular: 'font_regular_media_id', font_bold: 'font_bold_media_id' } as const

route('POST', '/tenants/:t/brand-assets', async ({ event, tenantId, operator }) => {
  const parts = await readMultipartFormData(event) ?? []
  const slot = parts.find(p => p.name === 'slot')?.data.toString('utf8') as keyof typeof ASSET_FIELDS
  const file = parts.find(p => p.name === 'file' && p.filename)
  if (!ASSET_FIELDS[slot] || !file) throw invalid('Передайте файл и назначение (логотип, паттерн или шрифт)')
  if (file.data.length > 5 * 1024 * 1024) throw invalid('Файл больше 5 МБ')
  const ext = file.filename!.split('.').pop()!.toLowerCase()
  const isFont = slot.startsWith('font')
  const allowed = isFont ? ['ttf', 'otf', 'woff'] : ['png', 'jpg', 'jpeg', 'svg', 'webp']
  if (!allowed.includes(ext)) throw invalid(`Для этого поля подходят файлы: ${allowed.join(', ')}`)
  const mime = isFont ? `font/${ext}` : ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  const media = await saveMedia(tenantId, isFont ? 'font' : slot === 'pattern' ? 'background' : 'logo', file.data, mime, { title: file.filename, ext })
  await updateTenant(tenantId, { settings: { brand: { [ASSET_FIELDS[slot]]: media.id } } }, operator)
  return { media_id: media.id, slot }
})

route('DELETE', '/tenants/:t/brand-assets/:slot', async ({ tenantId, params, operator }) => {
  const field = ASSET_FIELDS[params.slot as keyof typeof ASSET_FIELDS]
  if (!field) throw notFound('Поле')
  await updateTenant(tenantId, { settings: { brand: { [field]: null } } }, operator)
})

const CARD_SAMPLES: Record<string, Record<string, string>> = {
  product: { tag: 'Продукт', title: 'Новая линейка', value: '97%', detail: 'Показатель · пример подписи' },
  guide: { tag: 'Гайд', question: 'Где это пригодится?', detail: 'Короткий ответ на вопрос в одну-две строки', item0: 'Первый пример', item1: 'Второй пример', item2: 'Третий пример' },
  people: { tag: 'Команда', title: 'Расти в профессии', item0: 'Обучение', item1: 'Наставники' },
  project: { tag: 'Проект', title: 'Реализованный объект', detail: 'Подпись к фото' },
  event: { tag: 'Событие', value: '6–8', period: 'февраля 2026', title: 'Отраслевой форум', detail: 'Казань' },
  ecology: { tag: 'Экология', title: 'Три звена процесса', key0: 'Сырьё', item0: 'сбор', key1: 'Завод', item1: 'переработка', key2: 'Ресурс', item2: 'экономия' },
  plant: { tag: 'История', title: 'Как мы росли', key0: 'Июль 2022', item0: 'первый выпуск', key1: 'Апрель 2024', item1: 'первая отгрузка', key2: 'Лето 2025', item2: 'новая линия' },
  service: { tag: 'Сервис', title: 'Как оформить заказ', item0: 'выбрать товар', item1: 'сверить заказ', item2: 'оставить контакты' },
  quiz: { tag: 'Квиз', question: 'Угадаете ответ?', detail: 'Подсказка к вопросу', answer: '' },
}

async function cardSample(tenantId: string, template: keyof typeof CARD_TEMPLATES, event: H3Event) {
  const { renderCard } = await import('~~/core/image/card-render')
  const { readMedia } = await import('~~/core/media')
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  const [photo] = await libraryPhotos(tenantId)
  const { png } = await renderCard({
    tenantId, tenantName: t!.name, brand: t!.settings.brand, template, fields: CARD_SAMPLES[template]!,
    photo: photo ? await readMedia(tenantId, photo.id) : null,
  })
  setHeader(event, 'content-type', 'image/png')
  setHeader(event, 'cache-control', 'private, max-age=300')
  return png
}

route('GET', '/tenants/:t/card-preview/:template', async ({ tenantId, params, event }) => {
  if (!isCardTemplate(params.template)) throw notFound('Макет')
  return cardSample(tenantId, params.template, event)
})

route('GET', '/tenants/:t/photos', async ({ tenantId }) =>
  (await libraryPhotos(tenantId)).map(p => ({ ...p, url: `/api/v1/tenants/${tenantId}/media/${p.id}` })))

route('POST', '/tenants/:t/photos', async ({ event, tenantId, operator }) => {
  const parts = (await readMultipartFormData(event) ?? []).filter(p => p.name === 'file' && p.filename)
  if (!parts.length) throw invalid('Добавьте фото')
  const saved: string[] = []
  for (const file of parts.slice(0, 30)) {
    const photo = imageUpload(file)
    const m = await saveMedia(tenantId, 'photo', photo.buf, photo.mime, { title: file.filename!.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') })
    saved.push(m.id)
  }
  await audit(tenantId, 'operator', operator, 'photos.uploaded', null, null, { count: saved.length })
  return { ids: saved }
}, { status: 201 })

route('DELETE', '/tenants/:t/photos/:id', async ({ tenantId, params, operator }) => {
  await removeLibraryPhotos(tenantId, [uuid(params.id!, 'Фото')])
  await audit(tenantId, 'operator', operator, 'photos.removed', 'media', params.id!)
})

route('GET', '/tenants/:t/media/:id', async ({ event, tenantId, params }) => {
  const m = await getMedia(tenantId, uuid(params.id!, 'Файл'))
  if (!m) throw notFound('Файл')
  return sendMediaFile(event, m)
})

route('GET', '/tenants/:t/integrations', async ({ tenantId }) =>
  (await db.select().from(schema.integrations).where(eq(schema.integrations.tenantId, tenantId)).orderBy(schema.integrations.createdAt)).map(publicIntegration))

route('POST', '/tenants/:t/integrations', async ({ tenantId, body, operator }) => {
  const platform = body.platform ?? 'telegram'
  if (platform !== 'telegram' && platform !== 'vk') throw invalid('Подключаются Telegram и ВКонтакте')
  const row = publicIntegration(platform === 'vk'
    ? await connectVkGroup(tenantId, { group: String(body.channel ?? ''), token: body.token }, operator)
    : await connectTelegramChannel(tenantId, { channel: String(body.channel ?? ''), botToken: body.bot_token }, operator))
  await tenantSetup(tenantId)
  return row
}, { status: 201 })

route('POST', '/tenants/:t/integrations/:id/check', async ({ tenantId, params, operator }) => {
  const [i] = await db.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.id, uuid(params.id!, 'Канал'))))
  if (!i) throw notFound('Канал')
  try {
    if (i.platform === 'vk') return publicIntegration(await connectVkGroup(tenantId, { group: i.externalId }, operator, i.credentialsEnc ? decryptSecret(i.credentialsEnc) : null))
    return publicIntegration(await connectTelegramChannel(tenantId, { channel: i.externalId, botToken: null }, operator))
  }
  catch (e) {
    const [row] = await db.update(schema.integrations).set({ status: 'error', error: (e as Error).message, checkedAt: new Date() }).where(eq(schema.integrations.id, i.id)).returning()
    return publicIntegration(row!)
  }
})

route('DELETE', '/tenants/:t/integrations/:id', async ({ tenantId, params, operator }) => {
  const [i] = await db.delete(schema.integrations).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.id, uuid(params.id!, 'Канал')))).returning()
  if (!i) throw notFound('Канал')
  await audit(tenantId, 'operator', operator, 'integration.revoked', 'integration', i.id, { channel: i.username ?? i.externalId })
  await tenantSetup(tenantId)
})

route('GET', '/tenants/:t/members', async ({ tenantId }) => {
  const members = await db.select().from(schema.tenantMembers).where(eq(schema.tenantMembers.tenantId, tenantId)).orderBy(schema.tenantMembers.createdAt)
  const invites = await db.select().from(schema.invites).where(and(eq(schema.invites.tenantId, tenantId), gte(schema.invites.expiresAt, new Date()))).orderBy(desc(schema.invites.createdAt))
  let bot = '<бот>'
  try { bot = (await getBotInfo()).username }
  catch {}
  return {
    members: members.map(m => ({ id: m.id, display_name: m.displayName, roles: m.roles, status: m.status, tg_user_id: m.tgUserId, created_at: m.createdAt })),
    invites: invites.filter(i => !i.usedAt).map(i => ({ id: i.id, roles: i.roles, expires_at: i.expiresAt, link: `https://t.me/${bot}?start=${i.code}` })),
  }
})

route('POST', '/tenants/:t/invites', async ({ tenantId, body, operator }) => {
  const inv = await createInvite(tenantId, body.roles ?? ['client', 'approver'], Number(body.hours ?? 72), operator)
  return { id: inv.id, roles: inv.roles, expires_at: inv.expiresAt, link: inv.link }
}, { status: 201 })

route('DELETE', '/tenants/:t/invites/:id', async ({ tenantId, params }) => {
  await db.delete(schema.invites).where(and(eq(schema.invites.tenantId, tenantId), eq(schema.invites.id, uuid(params.id!, 'Приглашение'))))
})

route('DELETE', '/tenants/:t/members/:id', async ({ tenantId, params, operator }) => {
  const [m] = await db.update(schema.tenantMembers).set({ status: 'revoked' })
    .where(and(eq(schema.tenantMembers.tenantId, tenantId), eq(schema.tenantMembers.id, uuid(params.id!, 'Участник')))).returning()
  if (!m) throw notFound('Участник')
  await db.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() }).where(and(eq(schema.approvals.memberId, m.id), eq(schema.approvals.decision, 'pending')))
  await audit(tenantId, 'operator', operator, 'member.revoked', 'member', m.id, { name: m.displayName })
  await tenantSetup(tenantId)
})

route('GET', '/tenants/:t/posts', ({ tenantId, query }) =>
  listPosts(tenantId, { status: query.status || undefined, kind: query.kind || undefined, limit: Number(query.limit) || 50, offset: Number(query.offset) || 0 }))

route('GET', '/tenants/:t/posts/:id', async ({ tenantId, params }) => {
  const post = await postDetail(tenantId, uuid(params.id!, 'Публикация'))
  if (!post) throw notFound('Публикация')
  return post
})

route('PATCH', '/tenants/:t/posts/:id', async ({ tenantId, params, body, operator }) => {
  const postId = uuid(params.id!, 'Публикация')
  const detail = await postDetail(tenantId, postId)
  if (!detail?.current_version) throw notFound('Публикация')
  try {
    const cur = detail.current_version
    const textChanged = (body.text !== undefined && body.text !== cur.text) || (body.title !== undefined && body.title !== cur.title)
    if (textChanged) {
      const draft = {
        title: String(body.title ?? cur.title).slice(0, 90), text: String(body.text ?? cur.text), hashtags: cur.hashtags,
        image_prompt: cur.image_prompt, facts: cur.facts, warnings: [] as string[], format: cur.format,
      }
      if (!draft.text.trim()) throw invalid('Текст не может быть пустым')
      draft.warnings = await checkDraft(tenantId, draft, { contextText: cur.text })
      await addVersion(tenantId, postId, { draft, author: 'human', comment: 'Правка оператора', keepImage: true })
    }
    if (body.scheduled_at !== undefined) {
      const at = body.scheduled_at ? new Date(body.scheduled_at) : null
      if (at && Number.isNaN(at.getTime())) throw invalid('Некорректное время')
      await reschedulePost(tenantId, postId, at)
    }
    await audit(tenantId, 'operator', operator, 'post.edited', 'post', postId, { text: textChanged, time: body.scheduled_at !== undefined })
    await sendForApproval(tenantId, postId)
  }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
  return postDetail(tenantId, postId)
})

function imageUpload(file: { filename?: string, data: Buffer }) {
  if (file.data.length > 15 * 1024 * 1024) throw invalid(`«${file.filename}» больше 15 МБ`)
  const ext = (file.filename ?? '').split('.').pop()!.toLowerCase()
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw invalid('Подходят фото PNG, JPG и WebP')
  return { buf: file.data, mime: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`, title: file.filename }
}

async function cardChange(tenantId: string, postId: string, event: H3Event, body: any, actor: { type: 'operator' | 'member', id: string | null }) {
  const patch: CardPatch = {}
  if ((getHeader(event, 'content-type') ?? '').startsWith('multipart/')) {
    const parts = await readMultipartFormData(event) ?? []
    const file = parts.find(p => p.name === 'file' && p.filename)
    if (!file) throw invalid('Добавьте фото')
    if (parts.find(p => p.name === 'mode')?.data.toString() === 'custom') {
      const up = imageUpload(file)
      patch.custom = { buf: up.buf, mime: up.mime }
    }
    else patch.photo = { action: 'upload', ...imageUpload(file) }
  }
  else {
    if (body.template !== undefined) {
      if (!isCardTemplate(body.template)) throw invalid('Неизвестный макет')
      patch.template = body.template
    }
    if (body.fields && typeof body.fields === 'object') {
      const keys = new Set(Object.values(CARD_TEMPLATES).flatMap(t => cardFields(t.id).map(f => f.key)))
      patch.fields = Object.fromEntries(Object.entries(body.fields).filter(([k, v]) => keys.has(k) && typeof v === 'string')) as Record<string, string>
    }
    if (body.photo === 'next') patch.photo = { action: 'next' }
    if (body.photo === 'ai') patch.photo = { action: 'ai' }
  }
  try {
    const res = await updatePostCard(tenantId, postId, patch, actor)
    return { new_version: res.newVersion, overflow: res.overflow, missing: res.missing }
  }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
}

async function layoutChange(tenantId: string, postId: string, event: H3Event, body: any, actor: { type: 'operator' | 'member', id: string | null }) {
  let patch: LayoutPatch
  if ((getHeader(event, 'content-type') ?? '').startsWith('multipart/')) {
    const parts = await readMultipartFormData(event) ?? []
    const file = parts.find(p => p.name === 'file' && p.filename)
    if (!file) throw invalid('Добавьте фото')
    patch = { gallery: { action: 'upload', ...imageUpload(file) } }
  }
  else if (body.format === 'rich' || body.format === 'classic') patch = { format: body.format }
  else if (body.gallery === 'add') patch = { gallery: { action: 'add' } }
  else if (body.gallery === 'generate') patch = { gallery: { action: 'generate', prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 300) : null } }
  else if (typeof body.remove === 'string') patch = { gallery: { action: 'remove', media_id: uuid(body.remove, 'Фото') } }
  else if (body.move && typeof body.move.id === 'string') patch = { gallery: { action: 'move', media_id: uuid(body.move.id, 'Фото'), to: Number(body.move.to) || 0 } }
  else if (body.mode === 'slideshow' || body.mode === 'collage') patch = { gallery: { action: 'mode', mode: body.mode } }
  else throw invalid('Неизвестное изменение')
  try {
    const res = await updatePostLayout(tenantId, postId, patch, actor)
    return { new_version: res.newVersion, format: res.format, photos: (res.gallery?.media_ids.length ?? 0) + 1 }
  }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
}

route('POST', '/tenants/:t/posts/:id/layout', async ({ tenantId, params, event, body, operator }) => {
  const postId = uuid(params.id!, 'Публикация')
  const res = await layoutChange(tenantId, postId, event, body, { type: 'operator', id: operator })
  return { ...res, post: await postDetail(tenantId, postId) }
})

route('POST', '/tenants/:t/posts/:id/card', async ({ tenantId, params, event, body, operator }) => {
  const postId = uuid(params.id!, 'Публикация')
  const res = await cardChange(tenantId, postId, event, body, { type: 'operator', id: operator })
  return { ...res, post: await postDetail(tenantId, postId) }
})

route('POST', '/tenants/:t/posts/:id/retry-publication', async ({ tenantId, params, operator, event }) => {
  const postId = uuid(params.id!, 'Публикация')
  const post = await getPost(tenantId, postId)
  if (!post) throw notFound('Публикация')
  if (post.status !== 'failed') throw conflict('Повтор доступен только для постов с ошибкой публикации')
  if (!post.approvedVersionId || post.approvedVersionId !== post.currentVersionId) throw conflict('У поста нет одобренной версии')
  await db.update(schema.publications).set({ status: 'failed' })
    .where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.postId, postId), inArray(schema.publications.status, ['uncertain', 'publishing'])))
  await db.update(schema.posts).set({ status: 'approved' }).where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId), eq(schema.posts.status, 'failed')))
  const key = getHeader(event, 'idempotency-key') || String(Date.now())
  const job_run_id = await enqueue({ tenantId, type: 'publish_post', payload: { post_id: postId }, dedupKey: `pub-retry:${postId}:${key}`, maxAttempts: 1 })
  await audit(tenantId, 'operator', operator, 'publication.retry', 'post', postId)
  return { job_run_id }
}, { status: 202 })

route('POST', '/tenants/:t/posts/:id/send-for-approval', async ({ tenantId, params, operator }) => {
  const postId = uuid(params.id!, 'Публикация')
  try { await resendForApproval(tenantId, postId, { type: 'operator', id: operator }) }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
  return postDetail(tenantId, postId)
})

route('POST', '/tenants/:t/posts/:id/publish-now', async ({ tenantId, params, operator }) => {
  try { await publishNow(tenantId, uuid(params.id!, 'Публикация'), { type: 'operator', id: operator }) }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
  return { ok: true }
}, { status: 202 })

route('POST', '/tenants/:t/posts/:id/mark-published', async ({ tenantId, params, body, operator }) => {
  const postId = uuid(params.id!, 'Публикация')
  const post = await getPost(tenantId, postId)
  if (!post) throw notFound('Публикация')
  if (post.status !== 'failed') throw conflict('Доступно только для постов с неопределённым исходом публикации')
  await db.update(schema.publications).set({ status: 'published', publishedAt: new Date(), url: body.url ?? null, error: null })
    .where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.postId, postId)))
  await db.update(schema.posts).set({ status: 'published' }).where(eq(schema.posts.id, postId))
  await audit(tenantId, 'operator', operator, 'publication.marked_published', 'post', postId, { url: body.url ?? null })
  return postDetail(tenantId, postId)
})

route('GET', '/tenants/:t/schedules', async ({ tenantId }) => {
  const rows = await db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.tenantId, tenantId)).orderBy(schema.scheduledJobs.createdAt)
  return rows.map(({ params, ...r }) => ({ ...r, type_label: SCHEDULE_LABELS[r.type], params: { ...params, seen: undefined } }))
})
route('POST', '/tenants/:t/schedules', async ({ tenantId, body, operator }) => {
  const row = await saveSchedule(tenantId, { type: body.type, title: body.title, cron: body.cron, params: body.params, enabled: body.enabled }, operator)
  await tenantSetup(tenantId)
  return row
}, { status: 201 })
route('PATCH', '/tenants/:t/schedules/:id', ({ tenantId, params, body, operator }) =>
  saveSchedule(tenantId, { id: uuid(params.id!, 'Расписание'), title: body.title, cron: body.cron, params: body.params, enabled: body.enabled }, operator))
route('DELETE', '/tenants/:t/schedules/:id', async ({ tenantId, params, operator }) => {
  const [s] = await db.delete(schema.scheduledJobs).where(and(eq(schema.scheduledJobs.tenantId, tenantId), eq(schema.scheduledJobs.id, uuid(params.id!, 'Расписание')))).returning()
  if (!s) throw notFound('Расписание')
  await audit(tenantId, 'operator', operator, 'schedule.deleted', 'schedule', s.id, { type: s.type })
})
route('POST', '/tenants/:t/schedules/:id/run-now', async ({ tenantId, params, operator, event }) =>
  ({ job_run_id: await runScheduleNow(tenantId, uuid(params.id!, 'Расписание'), getHeader(event, 'idempotency-key') ?? undefined, operator) }), { status: 202 })

route('GET', '/tenants/:t/job-runs', ({ tenantId, query }) =>
  db.select().from(schema.jobRuns)
    .where(and(eq(schema.jobRuns.tenantId, tenantId), ...(query.status ? [eq(schema.jobRuns.status, query.status as any)] : [])))
    .orderBy(desc(schema.jobRuns.createdAt)).limit(Math.min(Number(query.limit) || 100, 300)))

route('GET', '/tenants/:t/job-runs/:id', async ({ tenantId, params }) => {
  const [j] = await db.select().from(schema.jobRuns).where(and(eq(schema.jobRuns.tenantId, tenantId), eq(schema.jobRuns.id, uuid(params.id!, 'Запуск'))))
  if (!j) throw notFound('Запуск')
  return j
})

route('GET', '/tenants/:t/audit', ({ tenantId, query }) =>
  db.select().from(schema.auditLogs).where(eq(schema.auditLogs.tenantId, tenantId)).orderBy(desc(schema.auditLogs.createdAt)).limit(Math.min(Number(query.limit) || 150, 500)))

route('GET', '/tenants/:t/usage', async ({ tenantId, query }) => {
  const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400_000)
  const to = query.to ? new Date(query.to) : new Date()
  const range = and(eq(schema.llmUsage.tenantId, tenantId), gte(schema.llmUsage.createdAt, from), lte(schema.llmUsage.createdAt, to))
  const agg = { calls: sql<number>`count(*)::int`, input_tokens: sql<number>`coalesce(sum(${schema.llmUsage.inputTokens}),0)::int`, output_tokens: sql<number>`coalesce(sum(${schema.llmUsage.outputTokens}),0)::int`, images: sql<number>`coalesce(sum(${schema.llmUsage.images}),0)::int`, cost_estimate: sql<number>`coalesce(sum(${schema.llmUsage.costEstimate}),0)::float`, avg_ms: sql<number>`coalesce(avg(${schema.llmUsage.durationMs}),0)::int` }
  const [total] = await db.select(agg).from(schema.llmUsage).where(range)
  const by_operation = await db.select({ operation: schema.llmUsage.operation, provider: schema.llmUsage.provider, ...agg }).from(schema.llmUsage).where(range).groupBy(schema.llmUsage.operation, schema.llmUsage.provider).orderBy(desc(sql`count(*)`))
  const by_day = await db.select({ day: sql<string>`to_char(${schema.llmUsage.createdAt}, 'YYYY-MM-DD')`, ...agg }).from(schema.llmUsage).where(range).groupBy(sql`1`).orderBy(sql`1`)
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  const [published] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.publications).where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.status, 'published'), gte(schema.publications.createdAt, from)))
  return { from, to, total, by_operation, by_day, calls_today: await callsToday(tenantId), daily_call_limit: t!.settings.daily_call_limit ?? 80, published_posts: published?.n ?? 0 }
})

route('GET', '/tenants/:t/analytics/summary', ({ tenantId, query }) => metricsSummary(tenantId, Math.min(Number(query.days) || 7, 90)))

route('GET', '/tenants/:t/analytics/performance', async ({ tenantId, query }) => {
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  return postPerformance(tenantId, Math.min(Number(query.days) || 30, 180), t!.timezone)
})

route('POST', '/tenants/:t/analytics/refresh', async ({ tenantId }) => refreshPostStats(tenantId))

route('GET', '/tenants/:t/plan-items', ({ tenantId }) =>
  db.select().from(schema.planItems).where(eq(schema.planItems.tenantId, tenantId)).orderBy(desc(schema.planItems.date), schema.planItems.time).limit(100))

route('PATCH', '/tenants/:t/plan-items/:id', async ({ tenantId, params, body }) => {
  const status = body.status as 'accepted' | 'skipped' | 'idea'
  if (!['accepted', 'skipped', 'idea'].includes(status)) throw invalid('Неверный статус')
  const [row] = await db.update(schema.planItems).set({ status })
    .where(and(eq(schema.planItems.tenantId, tenantId), eq(schema.planItems.id, uuid(params.id!, 'Тема')), inArray(schema.planItems.status, ['idea', 'accepted', 'skipped']))).returning()
  if (!row) throw notFound('Тема')
  return row
})

route('GET', '/tenants/:t/competitors', ({ tenantId }) => db.select().from(schema.competitors).where(eq(schema.competitors.tenantId, tenantId)).orderBy(schema.competitors.createdAt))
route('POST', '/tenants/:t/competitors', async ({ tenantId, body, operator }) => {
  const name = String(body.name ?? '').trim()
  if (!name) throw invalid('Укажите название конкурента')
  const [row] = await db.insert(schema.competitors).values({ tenantId, name: name.slice(0, 120), url: body.url ? String(body.url).trim() : null, notes: body.notes ? String(body.notes).slice(0, 5000) : null }).returning()
  await enqueue({ tenantId, type: 'analyze_competitor', payload: { competitor_id: row!.id }, maxAttempts: 2 })
  await audit(tenantId, 'operator', operator, 'competitor.added', 'competitor', row!.id, { name })
  return row
}, { status: 201 })
route('POST', '/tenants/:t/competitors/:id/analyze', async ({ tenantId, params }) =>
  ({ job_run_id: await enqueue({ tenantId, type: 'analyze_competitor', payload: { competitor_id: uuid(params.id!, 'Конкурент') }, maxAttempts: 2 }) }), { status: 202 })
route('DELETE', '/tenants/:t/competitors/:id', async ({ tenantId, params }) => {
  await db.delete(schema.competitors).where(and(eq(schema.competitors.tenantId, tenantId), eq(schema.competitors.id, uuid(params.id!, 'Конкурент'))))
})
route('GET', '/tenants/:t/comments', ({ tenantId }) =>
  db.select().from(schema.comments).where(eq(schema.comments.tenantId, tenantId)).orderBy(desc(schema.comments.createdAt)).limit(100))

route('GET', '/miniapp/me', async ({ event }) => {
  const { member, members, user } = await miniappUser(event)
  const tenants = await db.select({ id: schema.tenants.id, name: schema.tenants.name, timezone: schema.tenants.timezone, settings: schema.tenants.settings })
    .from(schema.tenants).where(inArray(schema.tenants.id, members.map(m => m.tenantId)))
  const active = tenants.find(t => t.id === member.tenantId)!
  return {
    user: { id: user.id, name: member.displayName }, roles: member.roles,
    tenant: { id: active.id, name: active.name, timezone: active.timezone, primary: active.settings.brand?.primary ?? '#1c6c7e', approval_rule: active.settings.approval_rule ?? 'any_one' },
    tenants: tenants.map(t => ({ id: t.id, name: t.name })),
  }
}, { auth: 'miniapp' })

route('POST', '/miniapp/tenant', async ({ event, body }) => {
  const { members, user } = await miniappUser(event)
  const target = members.find(m => m.tenantId === body.tenant_id)
  if (!target) throw new AppError(403, 'forbidden', 'Нет доступа к этой компании')
  await db.insert(schema.tgSessions).values({ tgUserId: user.id, activeTenantId: target.tenantId })
    .onConflictDoUpdate({ target: schema.tgSessions.tgUserId, set: { activeTenantId: target.tenantId, updatedAt: new Date() } })
}, { auth: 'miniapp' })

route('GET', '/miniapp/posts', async ({ event, query }) => {
  const { member } = await miniappUser(event)
  const posts = await listPosts(member.tenantId, { status: query.status || undefined, limit: 40 })
  const pending = await db.select({ id: schema.approvals.id, post_id: schema.approvals.postId }).from(schema.approvals)
    .where(and(eq(schema.approvals.tenantId, member.tenantId), eq(schema.approvals.memberId, member.id), eq(schema.approvals.decision, 'pending')))
  const byPost = new Map(pending.map(a => [a.post_id, a.id]))
  return posts.map(p => ({ ...p, image_url: p.image_media_id ? `/api/v1/miniapp/media/${p.image_media_id}` : null, approval_id: p.status === 'in_review' ? byPost.get(p.id) ?? null : null }))
}, { auth: 'miniapp' })

route('GET', '/miniapp/posts/:id', async ({ event, params }) => {
  const { member } = await miniappUser(event)
  const post = await postDetail(member.tenantId, uuid(params.id!, 'Публикация'))
  if (!post) throw notFound('Публикация')
  const fix = (u: string | null) => u ? u.replace(`/api/v1/tenants/${member.tenantId}/media/`, '/api/v1/miniapp/media/') : null
  const [pending] = await db.select({ id: schema.approvals.id }).from(schema.approvals)
    .where(and(eq(schema.approvals.tenantId, member.tenantId), eq(schema.approvals.memberId, member.id), eq(schema.approvals.postId, post.id), eq(schema.approvals.decision, 'pending')))
  const fixV = <V extends { image_url: string | null, video: { url: string | null } | null, gallery: { mode: string, photos: Array<{ id: string, url: string }> } | null }>(v: V): V => ({
    ...v, image_url: fix(v.image_url), video: v.video ? { ...v.video, url: fix(v.video.url) } : null,
    gallery: v.gallery ? { ...v.gallery, photos: v.gallery.photos.map(p => ({ ...p, url: fix(p.url)! })) } : null,
  })
  return { ...post, current_version: post.current_version ? fixV(post.current_version) : null, versions: post.versions.map(fixV), approval_id: post.status === 'in_review' ? pending?.id ?? null : null }
}, { auth: 'miniapp' })

route('POST', '/miniapp/posts/:id/layout', async ({ event, params, body }) => {
  const { member } = await miniappUser(event)
  return layoutChange(member.tenantId, uuid(params.id!, 'Публикация'), event, body, { type: 'member', id: member.id })
}, { auth: 'miniapp' })

route('POST', '/miniapp/posts/:id/card', async ({ event, params, body }) => {
  const { member } = await miniappUser(event)
  return cardChange(member.tenantId, uuid(params.id!, 'Публикация'), event, body, { type: 'member', id: member.id })
}, { auth: 'miniapp' })

route('GET', '/miniapp/media/:id', async ({ event, params, query }) => {
  if (query.tg && !getHeader(event, 'x-telegram-init-data')) event.node.req.headers['x-telegram-init-data'] = query.tg
  const { member } = await miniappUser(event)
  const m = await getMedia(member.tenantId, uuid(params.id!, 'Файл'))
  if (!m) throw notFound('Файл')
  return sendMediaFile(event, m)
}, { auth: 'miniapp' })

route('POST', '/miniapp/approvals/:id', async ({ event, params, body }) => {
  const { member, user } = await miniappUser(event)
  const action = body.action as 'a' | 'c' | 'r'
  if (!['a', 'c', 'r'].includes(action)) throw invalid('Неизвестное действие')
  const approvalId = uuid(params.id!, 'Согласование')
  if (action === 'c') {
    const comment = String(body.comment ?? '').trim()
    if (comment.length < 3) throw invalid('Напишите, что изменить')
    const res = await submitChangeRequest(member, approvalId, comment.slice(0, 2000))
    if (!res.ok) throw conflict(res.reason ?? 'Карточка неактуальна')
    return { ok: true, action: 'changes_requested' }
  }
  const res = await decideApproval(approvalId, user.id, action, action === 'r' ? String(body.comment ?? '') : null)
  if (!res.ok) throw conflict(res.reason)
  return { ok: true, action: res.action }
}, { auth: 'miniapp' })

route('POST', '/miniapp/posts/:id/send-for-approval', async ({ event, params }) => {
  const { member } = await miniappUser(event)
  try {
    const { sent } = await resendForApproval(member.tenantId, uuid(params.id!, 'Публикация'), { type: 'member', id: member.id })
    return { ok: true, sent }
  }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
}, { auth: 'miniapp' })

route('POST', '/miniapp/posts/:id/publish-now', async ({ event, params }) => {
  const { member, user } = await miniappUser(event)
  if (!member.roles.includes('approver')) throw new AppError(403, 'forbidden', 'Отправлять может только согласующий')
  const postId = uuid(params.id!, 'Публикация')
  const post = await getPost(member.tenantId, postId)
  if (!post) throw notFound('Публикация')
  if (post.status === 'in_review') {
    const [mine] = await db.select().from(schema.approvals).where(and(
      eq(schema.approvals.postId, postId), eq(schema.approvals.memberId, member.id), eq(schema.approvals.decision, 'pending'),
      eq(schema.approvals.versionId, post.currentVersionId!),
    ))
    if (!mine) throw conflict('Карточка согласования для вас не найдена')
    const res = await decideApproval(mine.id, user.id, 'a')
    if (!res.ok) throw conflict(res.reason)
    if (res.action === 'approved_partial') return { ok: true, published: false, partial: true }
  }
  try { await publishNow(member.tenantId, postId, { type: 'member', id: member.id }) }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
  return { ok: true, published: true }
}, { auth: 'miniapp' })

route('POST', '/miniapp/posts/:id/schedule', async ({ event, params, body }) => {
  const { member } = await miniappUser(event)
  const postId = uuid(params.id!, 'Публикация')
  const at = body.scheduled_at ? new Date(body.scheduled_at) : null
  if (at && Number.isNaN(at.getTime())) throw invalid('Некорректное время')
  if (at && at.getTime() < Date.now() - 60_000) throw invalid('Время уже прошло')
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, member.tenantId) })
  const keepApproval = member.roles.includes('approver') && tenant?.settings.approval_rule !== 'all'
  try {
    const { needsApproval } = await reschedulePost(member.tenantId, postId, at, { keepApproval })
    await audit(member.tenantId, 'member', member.id, 'post.edited', 'post', postId, { by: 'miniapp', time: true })
    if (needsApproval) await sendForApproval(member.tenantId, postId)
    return { ok: true, needs_approval: needsApproval }
  }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
}, { auth: 'miniapp' })

route('PATCH', '/miniapp/posts/:id', async ({ event, params, body }) => {
  const { member } = await miniappUser(event)
  const postId = uuid(params.id!, 'Публикация')
  const detail = await postDetail(member.tenantId, postId)
  if (!detail?.current_version) throw notFound('Публикация')
  const cur = detail.current_version
  const title = String(body.title ?? cur.title).trim().slice(0, 90)
  const text = String(body.text ?? cur.text).trim()
  if (text.length < 10) throw invalid('Текст слишком короткий')
  if (title === cur.title && text === cur.text) return { ok: true, changed: false }
  const draft = { title, text, hashtags: cur.hashtags, image_prompt: cur.image_prompt, facts: cur.facts, warnings: [] as string[], format: cur.format }
  draft.warnings = await checkDraft(member.tenantId, draft, { contextText: cur.text })
  try {
    await addVersion(member.tenantId, postId, { draft, author: 'human', comment: 'Правка вручную', keepImage: true })
  }
  catch (e) {
    if (e instanceof PostStateError) throw conflict(e.message)
    throw e
  }
  await audit(member.tenantId, 'member', member.id, 'post.edited', 'post', postId, { by: 'miniapp' })
  await sendForApproval(member.tenantId, postId)
  return { ok: true, changed: true }
}, { auth: 'miniapp' })

route('POST', '/miniapp/posts', async ({ event, body }) => {
  const { member } = await miniappUser(event)
  const title = String(body.title ?? '').trim().slice(0, 90)
  const text = String(body.text ?? '').trim().slice(0, 4000)
  if (title.length < 3) throw invalid('Добавьте заголовок')
  if (text.length < 10) throw invalid('Текст слишком короткий')
  const format = body.format === 'classic' || body.format === 'rich' ? body.format as 'classic' | 'rich' : undefined
  const draft = { title, text, hashtags: [] as string[], facts: [], warnings: [] as string[], format }
  draft.warnings = await checkDraft(member.tenantId, draft, {})
  const { post } = await createPost(member.tenantId, { draft, origin: 'user_request', memberId: member.id, author: 'human', topic: title })
  await audit(member.tenantId, 'member', member.id, 'post.created', 'post', post.id, { by: 'miniapp', author: 'human' })
  if (body.send !== false) await sendForApproval(member.tenantId, post.id)
  return { id: post.id }
}, { auth: 'miniapp', status: 201 })

route('GET', '/miniapp/facts/:id', async ({ event, params }) => {
  const { member } = await miniappUser(event)
  const [chunk] = await chunksByIds(member.tenantId, [uuid(params.id!, 'Источник')])
  if (!chunk) throw notFound('Источник')
  const [source] = await db.select({ uri: schema.sources.uri, kind: schema.sources.kind }).from(schema.sources)
    .where(and(eq(schema.sources.tenantId, member.tenantId), eq(schema.sources.id, chunk.sourceId)))
  return { title: chunk.title, text: chunk.text, url: source?.kind === 'url' && /^https?:/.test(source.uri ?? '') ? source.uri : null }
}, { auth: 'miniapp' })

route('POST', '/miniapp/plan/:id/draft', async ({ event, params }) => {
  const { member } = await miniappUser(event)
  const id = uuid(params.id!, 'Тема')
  const [row] = await db.update(schema.planItems).set({ status: 'accepted' })
    .where(and(eq(schema.planItems.tenantId, member.tenantId), eq(schema.planItems.id, id), inArray(schema.planItems.status, ['idea', 'accepted', 'skipped']))).returning()
  if (!row) throw conflict('Пост по этой теме уже готовится')
  await enqueue({ tenantId: member.tenantId, type: 'draft_plan_item', payload: { plan_item_id: id }, dedupKey: `plan-now:${id}` })
  await audit(member.tenantId, 'member', member.id, 'plan_item.draft_now', 'plan_item', id)
  return row
}, { auth: 'miniapp', status: 202 })

route('GET', '/miniapp/messages', async ({ event }) => {
  const { member } = await miniappUser(event)
  const rows = await db.select({ id: schema.messages.id, direction: schema.messages.direction, text: schema.messages.text, post_id: schema.messages.postId, created_at: schema.messages.createdAt })
    .from(schema.messages).where(and(eq(schema.messages.tenantId, member.tenantId), eq(schema.messages.memberId, member.id)))
    .orderBy(desc(schema.messages.createdAt)).limit(40)
  return rows.reverse()
}, { auth: 'miniapp' })

route('POST', '/miniapp/messages', async ({ event, body }) => {
  const { member } = await miniappUser(event)
  const text = String(body.text ?? '').trim().slice(0, 4000)
  if (text.length < 2) throw invalid('Опишите задачу словами')
  const [msg] = await db.insert(schema.messages).values({ tenantId: member.tenantId, memberId: member.id, direction: 'in', text }).returning()
  await enqueue({ tenantId: member.tenantId, type: 'handle_message', dedupKey: `mini:${msg!.id}`, payload: { message_id: msg!.id, member_id: member.id } })
  return { id: msg!.id, direction: 'in', text, post_id: null, created_at: msg!.createdAt }
}, { auth: 'miniapp', status: 201 })

route('POST', '/miniapp/voice', async ({ event }) => {
  const { member } = await miniappUser(event)
  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.data?.length)
  if (!file) throw invalid('Нет записи')
  if (file.data.length > 8 * 1024 * 1024) throw invalid('Запись слишком длинная')
  const mime = (file.type ?? 'audio/webm').split(';')[0]!
  if (!/^audio\/|^video\/webm/.test(mime)) throw invalid('Это не аудио')
  const media = await saveMedia(member.tenantId, 'uploaded', file.data, mime, { ext: mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm', title: 'Голосовая задача' })
  await enqueue({ tenantId: member.tenantId, type: 'voice_message', dedupKey: `mini-voice:${media.id}`, payload: { member_id: member.id, media_id: media.id } })
  return { ok: true }
}, { auth: 'miniapp', status: 202 })

route('PATCH', '/miniapp/plan/:id', async ({ event, params, body }) => {
  const { member } = await miniappUser(event)
  const status = body.status as 'accepted' | 'skipped'
  if (!['accepted', 'skipped'].includes(status)) throw invalid('Неверный статус')
  const [row] = await db.update(schema.planItems).set({ status })
    .where(and(eq(schema.planItems.tenantId, member.tenantId), eq(schema.planItems.id, uuid(params.id!, 'Тема')), inArray(schema.planItems.status, ['idea', 'accepted', 'skipped']))).returning()
  if (!row) throw notFound('Тема')
  await audit(member.tenantId, 'member', member.id, `plan_item.${status}`, 'plan_item', row.id)
  return row
}, { auth: 'miniapp' })

route('GET', '/miniapp/card-preview/:template', async ({ event, params, query }) => {
  if (query.tg && !getHeader(event, 'x-telegram-init-data')) event.node.req.headers['x-telegram-init-data'] = query.tg
  const { member } = await miniappUser(event)
  if (!isCardTemplate(params.template)) throw notFound('Макет')
  return cardSample(member.tenantId, params.template, event)
}, { auth: 'miniapp' })

route('GET', '/miniapp/plan', async ({ event }) => {
  const { member } = await miniappUser(event)
  return db.select().from(schema.planItems).where(eq(schema.planItems.tenantId, member.tenantId)).orderBy(desc(schema.planItems.date)).limit(40)
}, { auth: 'miniapp' })

route('GET', '/miniapp/summary', async ({ event, query }) => {
  const { member } = await miniappUser(event)
  const days = Number(query.days) === 30 ? 30 : 7
  const summary = await metricsSummary(member.tenantId, days)
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, member.tenantId) })
  return { ...summary, dash: await dashboard(member.tenantId, days, tenant?.timezone ?? 'Europe/Moscow', summary.performance) }
}, { auth: 'miniapp' })

void tg
export default defineEventHandler(event => dispatch(event))
