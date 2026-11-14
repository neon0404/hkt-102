import { and, desc, eq, sql } from 'drizzle-orm'
import { loadPack, packName } from '../telegram/emoji-pack'
import { findEditableGroup, groupRef, type VkGroup, VkError } from '../vk/api'
import type { VkCreds } from '../vk/oauth'
import { audit } from '../audit'
import { config } from '../config'
import { encryptSecret, hashPassword, isUuid, randomCode, sha256 } from '../crypto'
import { db, schema } from '../db/client'
import type { TenantSettings } from '../db/schema'
import { enqueue } from '../jobs/queue'
import { assertPublicUrl, IngestError } from '../kb/ingest'
import { saveMedia } from '../media'
import { isValidCron, nextRun } from '../scheduler'
import { getBotInfo, GrammyError, tg } from '../telegram/api'
import { isValidTimezone } from '../time'

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message)
  }
}
export const notFound = (what = 'Объект') => new AppError(404, 'not_found', `Не найдено: ${what.toLowerCase()}`)
export const invalid = (message: string, details = {}) => new AppError(422, 'validation_error', message, details)
export const conflict = (message: string) => new AppError(409, 'conflict', message)

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}
export const slugify = (name: string) =>
  [...name.toLowerCase()].map(ch => TRANSLIT[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'company'

export async function ensureAdmin() {
  const [existing] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, config.adminEmail))
  if (!existing) await db.insert(schema.adminUsers).values({ email: config.adminEmail, passwordHash: hashPassword(config.adminPassword) }).onConflictDoNothing()
}

type AdminRow = typeof schema.adminUsers.$inferSelect
export interface AdminInput { email?: string, password?: string, name?: string | null, tg_user_id?: number | string | null }

const adminView = (a: AdminRow) => ({ id: a.id, email: a.email, name: a.name, tg_user_id: a.tgUserId, created_at: a.createdAt })

function adminName(v: unknown) {
  if (v === undefined || v === null) return null
  const name = String(v).trim()
  if (name.length > 120) throw invalid('Имя — до 120 знаков')
  return name || null
}

function adminTgId(v: unknown) {
  if (v === undefined || v === null || String(v).trim() === '') return null
  const s = String(v).trim()
  const n = Number(s)
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n <= 0) throw invalid('Telegram ID — положительное целое число')
  return n
}

function adminPassword(v: unknown) {
  const p = typeof v === 'string' ? v : ''
  if (p.length < 8) throw invalid('Пароль — не короче 8 знаков')
  if (p.length > 200) throw invalid('Пароль — не длиннее 200 знаков')
  return p
}

export async function operatorExists(email: string) {
  const [row] = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).where(eq(schema.adminUsers.email, email))
  return !!row
}

export async function listAdmins(currentEmail?: string) {
  const rows = await db.select().from(schema.adminUsers).orderBy(schema.adminUsers.createdAt)
  return rows.map(a => ({ ...adminView(a), is_current: a.email === currentEmail }))
}

export async function createAdmin(input: AdminInput, actor = 'operator') {
  const email = String(input.email ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw invalid('Укажите корректную почту')
  const password = adminPassword(input.password)
  const name = adminName(input.name)
  const tgUserId = adminTgId(input.tg_user_id)
  const [row] = await db.insert(schema.adminUsers).values({ email, passwordHash: hashPassword(password), name, tgUserId }).onConflictDoNothing().returning()
  if (!row) throw conflict('Пользователь с такой почтой уже есть')
  await audit(null, 'operator', actor, 'admin.created', 'admin_user', row.id, { email, name, tg_user_id: tgUserId })
  return adminView(row)
}

export async function updateAdmin(id: string, patch: AdminInput, actor = 'operator') {
  if (!isUuid(id)) throw notFound('Пользователь')
  const set: Partial<typeof schema.adminUsers.$inferInsert> = {}
  if (patch.name !== undefined) set.name = adminName(patch.name)
  if (patch.tg_user_id !== undefined) set.tgUserId = adminTgId(patch.tg_user_id)
  if (patch.password !== undefined && patch.password !== null && patch.password !== '') set.passwordHash = hashPassword(adminPassword(patch.password))
  if (!Object.keys(set).length) {
    const [row] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, id))
    if (!row) throw notFound('Пользователь')
    return adminView(row)
  }
  const [row] = await db.update(schema.adminUsers).set(set).where(eq(schema.adminUsers.id, id)).returning()
  if (!row) throw notFound('Пользователь')
  await audit(null, 'operator', actor, 'admin.updated', 'admin_user', row.id, {
    email: row.email, fields: Object.keys(set).filter(k => k !== 'passwordHash'), password_changed: !!set.passwordHash,
  })
  return adminView(row)
}

export function adminDeleteBlock(target: { email: string }, actor: string, total: number) {
  if (target.email === actor) return 'Нельзя удалить самого себя'
  if (total <= 1) return 'Нельзя удалить последнего пользователя'
  return null
}

export async function deleteAdmin(id: string, actor = 'operator') {
  if (!isUuid(id)) throw notFound('Пользователь')
  const removed = await db.transaction(async (tx) => {
    const all = await tx.select({ id: schema.adminUsers.id, email: schema.adminUsers.email }).from(schema.adminUsers).for('update')
    const target = all.find(a => a.id === id)
    if (!target) throw notFound('Пользователь')
    const block = adminDeleteBlock(target, actor, all.length)
    if (block) throw conflict(block)
    await tx.delete(schema.adminUsers).where(eq(schema.adminUsers.id, id))
    return target
  })
  await audit(null, 'operator', actor, 'admin.deleted', 'admin_user', removed.id, { email: removed.email })
}

export async function createTenant(input: { name: string, timezone?: string, settings?: TenantSettings }, actor = 'operator') {
  const name = input.name?.trim()
  if (!name || name.length > 120) throw invalid('Название обязательно, до 120 знаков')
  const timezone = input.timezone || config.defaultTimezone
  if (!isValidTimezone(timezone)) throw invalid('Неверный часовой пояс')
  const slug = slugify(name)
  const [dup] = await db.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug))
  if (dup) throw conflict('Компания с таким названием уже есть')
  const settings: TenantSettings = {
    tone: 'дружелюбно, по делу, без канцелярита', approval_rule: 'any_one', daily_call_limit: 80, image_mode: 'template',
    brand: { primary: '#1c6c7e' }, ...input.settings,
  }
  const [tenant] = await db.insert(schema.tenants).values({ name, slug, timezone, settings }).returning()
  await audit(tenant!.id, 'operator', actor, 'tenant.created', 'tenant', tenant!.id, { name })
  return tenant!
}

export async function getTenantOr404(tenantId: string) {
  if (!isUuid(tenantId)) throw notFound('Компания')
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  if (!t) throw notFound('Компания')
  return t
}

export async function tenantSetup(tenantId: string) {
  const count = async (table: any, where: any) =>
    ((await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where))[0]?.n ?? 0) as number
  const setup = {
    sources: await count(schema.sources, and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.status, 'ready'))) > 0,
    brand_profile: await count(schema.brandProfiles, and(eq(schema.brandProfiles.tenantId, tenantId), eq(schema.brandProfiles.status, 'confirmed'))) > 0,
    integration: await count(schema.integrations, and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.status, 'active'))) > 0,
    members: await count(schema.tenantMembers, and(eq(schema.tenantMembers.tenantId, tenantId), eq(schema.tenantMembers.status, 'active'))) > 0,
    schedule: await count(schema.scheduledJobs, and(eq(schema.scheduledJobs.tenantId, tenantId), eq(schema.scheduledJobs.enabled, true))) > 0,
  }
  const ready = setup.brand_profile && setup.integration && setup.members
  const [t] = await db.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  if (t && t.status !== 'disabled' && (t.status === 'active') !== ready) {
    await db.update(schema.tenants).set({ status: ready ? 'active' : 'setup' }).where(eq(schema.tenants.id, tenantId))
  }
  return { setup, status: t?.status === 'disabled' ? 'disabled' : ready ? 'active' : 'setup' }
}

export async function updateTenant(tenantId: string, patch: { name?: string, timezone?: string, status?: 'disabled' | 'setup', settings?: TenantSettings }, actor = 'operator') {
  const tenant = await getTenantOr404(tenantId)
  if (patch.timezone && !isValidTimezone(patch.timezone)) throw invalid('Неверный часовой пояс')
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120)) throw invalid('Название обязательно, до 120 знаков')
  const settings: TenantSettings = { ...tenant.settings, ...patch.settings, brand: { ...tenant.settings.brand, ...patch.settings?.brand } }
  if (settings.daily_call_limit !== undefined && (settings.daily_call_limit < 0 || settings.daily_call_limit > 5000)) throw invalid('Лимит обращений: от 0 до 5000')
  if (settings.emoji_pack && !packName(settings.emoji_pack)) throw invalid('Набор эмодзи: ссылка t.me/addemoji/… или имя набора')
  if (settings.emoji_pack) settings.emoji_pack = packName(settings.emoji_pack)
  if (settings.emoji_pack && settings.emoji_pack !== tenant.settings.emoji_pack && !await loadPack(settings.emoji_pack)) throw invalid('Набор эмодзи не найден в Telegram')
  if (!settings.emoji_pack) settings.emoji_in_channel = false
  if (settings.post_format !== undefined && !['rich', 'classic'].includes(settings.post_format)) throw invalid('Формат постов: rich или classic')
  const [updated] = await db.update(schema.tenants).set({
    name: patch.name?.trim() ?? tenant.name, timezone: patch.timezone ?? tenant.timezone, settings,
    ...(patch.status ? { status: patch.status } : {}),
  }).where(eq(schema.tenants.id, tenantId)).returning()
  await audit(tenantId, 'operator', actor, 'tenant.updated', 'tenant', tenantId, { fields: Object.keys(patch), provider: settings.provider ?? null })
  return updated!
}

const FILE_EXT = ['pdf', 'docx', 'txt', 'md']

export async function addSource(tenantId: string, input: {
  kind: 'url' | 'file' | 'text', uri?: string, title?: string, text?: string, file?: { name: string, data: Buffer, mime: string },
  scope?: 'company' | 'competitor',
}, actor = 'operator') {
  let contentHash: string
  let uri: string | null = null
  let rawText: string | null = null
  let mediaId: string | null = null
  let title = input.title?.trim() ?? ''
  if (input.kind === 'url') {
    try { uri = (await assertPublicUrl(input.uri ?? '')).toString() }
    catch (e) { throw invalid(e instanceof IngestError ? e.message : 'Некорректный адрес') }
    contentHash = sha256(`url:${uri}`)
  }
  else if (input.kind === 'text') {
    rawText = (input.text ?? '').trim()
    if (rawText.length < 40) throw invalid('Текст слишком короткий (минимум 40 знаков)')
    if (rawText.length > 50_000) throw invalid('Текст длиннее 50 000 знаков — разделите на части')
    contentHash = sha256(`text:${rawText}`)
    title ||= rawText.slice(0, 60)
  }
  else {
    const f = input.file
    if (!f) throw invalid('Файл не передан')
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!FILE_EXT.includes(ext)) throw invalid('Поддерживаются файлы PDF, DOCX, TXT, MD')
    if (f.data.length > 20 * 1024 * 1024) throw invalid('Файл больше 20 МБ')
    contentHash = sha256(f.data)
    uri = f.name
    title ||= f.name
  }
  const [dup] = await db.select().from(schema.sources).where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.contentHash, contentHash)))
  if (dup) throw conflict('Такой источник уже добавлен')
  if (input.kind === 'file') {
    const f = input.file!
    mediaId = (await saveMedia(tenantId, 'source', f.data, f.mime || 'application/octet-stream', { title: f.name, ext: f.name.split('.').pop()?.toLowerCase() })).id
  }
  const [source] = await db.insert(schema.sources).values({
    tenantId, kind: input.kind, scope: input.scope ?? 'company', uri, title, rawText, mediaId, contentHash,
  }).returning()
  await enqueue({ tenantId, type: 'ingest_source', payload: { source_id: source!.id }, dedupKey: `ingest:${source!.id}:${contentHash.slice(0, 16)}`, maxAttempts: 2 })
  await audit(tenantId, 'operator', actor, 'source.added', 'source', source!.id, { kind: input.kind, uri })
  return source!
}

export async function brandProfileState(tenantId: string) {
  const rows = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.tenantId, tenantId)).orderBy(desc(schema.brandProfiles.version)).limit(30)
  return { current: rows[0] ?? null, confirmed: rows.find(r => r.status === 'confirmed') ?? null, versions: rows.map(r => ({ version: r.version, status: r.status, created_at: r.createdAt })) }
}

export async function createInvite(tenantId: string, roles: Array<'client' | 'approver'>, hours = 72, actor = 'operator') {
  const clean = [...new Set(roles)].filter(r => r === 'client' || r === 'approver')
  if (!clean.length) throw invalid('Выберите хотя бы одну роль')
  const [invite] = await db.insert(schema.invites).values({
    tenantId, code: randomCode(), roles: clean, expiresAt: new Date(Date.now() + Math.min(Math.max(hours, 1), 720) * 3600_000),
  }).returning()
  await audit(tenantId, 'operator', actor, 'invite.created', 'invite', invite!.id, { roles: clean })
  let link = `t.me/<бот>?start=${invite!.code}`
  try { link = `https://t.me/${(await getBotInfo()).username}?start=${invite!.code}` }
  catch {}
  return { ...invite!, link }
}

export async function connectTelegramChannel(tenantId: string, input: { channel: string, botToken?: string | null }, actor = 'operator') {
  const raw = input.channel.trim().replace(/^https?:\/\/t\.me\//, '@').replace(/^t\.me\//, '@')
  if (!raw) throw invalid('Укажите канал: @username или числовой ID')
  const chatRef = /^\d{9,}$/.test(raw) ? Number(`-100${raw}`) : /^-?\d+$/.test(raw) ? Number(raw) : (raw.startsWith('@') ? raw : `@${raw}`)
  const token = input.botToken?.trim() || null
  const api = tg(token)
  let chat: Awaited<ReturnType<typeof api.getChat>>
  try { chat = await api.getChat(chatRef) }
  catch (e) {
    throw invalid(e instanceof GrammyError ? 'Канал не найден. Проверьте имя и добавьте бота администратором канала.' : 'Telegram недоступен, попробуйте позже')
  }
  if (chat.type !== 'channel') throw invalid('Это не канал. Укажите канал, в котором бот — администратор.')
  const me = await api.getMe()
  let canPost = false
  try {
    const cm = await api.getChatMember(chat.id, me.id)
    canPost = cm.status === 'creator' || (cm.status === 'administrator' && (cm as any).can_post_messages !== false)
  }
  catch { canPost = false }
  if (!canPost) throw invalid(`Бот @${me.username} не администратор канала или не имеет права публиковать. Добавьте его администратором с правом «Публикация сообщений».`)
  const externalId = String(chat.id)
  const [taken] = await db.select().from(schema.integrations).where(and(eq(schema.integrations.platform, 'telegram'), eq(schema.integrations.externalId, externalId)))
  if (taken && taken.tenantId !== tenantId) {
    await audit(tenantId, 'operator', actor, 'access.denied', 'integration', null, { reason: 'channel_taken', channel: externalId })
    throw conflict('Этот канал уже подключён к другой компании')
  }
  const values = {
    tenantId, platform: 'telegram' as const, title: chat.title ?? '', externalId, username: (chat as any).username ?? null,
    credentialsEnc: token ? encryptSecret(token) : null, status: 'active' as const, error: null, checkedAt: new Date(),
    meta: { linked_chat_id: (chat as any).linked_chat_id ?? null, bot: me.username },
  }
  const [row] = taken
    ? await db.update(schema.integrations).set(values).where(eq(schema.integrations.id, taken.id)).returning()
    : await db.insert(schema.integrations).values(values).returning()
  await audit(tenantId, 'operator', actor, 'integration.connected', 'integration', row!.id, { channel: values.username ?? externalId })
  return row!
}

export async function connectVkGroup(tenantId: string, input: { group: string, token?: string | null, creds?: VkCreds | null }, actor = 'operator') {
  const ref = groupRef(input.group)
  if (!ref) throw invalid('Укажите сообщество: ссылка vk.com/…, короткое имя или ID')
  const creds: VkCreds | null = input.creds ?? (input.token?.trim() ? { access_token: input.token.trim() } : null)
  const token = creds?.access_token ?? ''
  if (!token) throw invalid('Укажите ключ доступа администратора сообщества')
  let group: VkGroup | null
  try { group = await findEditableGroup(ref, token) }
  catch (e) {
    throw invalid(e instanceof VkError ? e.message : 'ВКонтакте недоступен, попробуйте позже')
  }
  if (!group) throw invalid('Этого сообщества нет среди тех, где владелец ключа — администратор или редактор. Проверьте ссылку и что ключ получен под аккаунтом, который управляет сообществом.')
  const externalId = String(group.id)
  const [taken] = await db.select().from(schema.integrations).where(and(eq(schema.integrations.platform, 'vk'), eq(schema.integrations.externalId, externalId)))
  if (taken && taken.tenantId !== tenantId) {
    await audit(tenantId, 'operator', actor, 'access.denied', 'integration', null, { reason: 'channel_taken', channel: externalId })
    throw conflict('Это сообщество уже подключено к другой компании')
  }
  const values = {
    tenantId, platform: 'vk' as const, title: group.name, externalId, username: group.screen_name ?? null,
    credentialsEnc: encryptSecret(JSON.stringify(creds)), status: 'active' as const, error: null, checkedAt: new Date(), meta: { admin_level: group.admin_level ?? null },
  }
  const [row] = taken
    ? await db.update(schema.integrations).set(values).where(eq(schema.integrations.id, taken.id)).returning()
    : await db.insert(schema.integrations).values(values).returning()
  await audit(tenantId, 'operator', actor, 'integration.connected', 'integration', row!.id, { channel: `vk:${values.username ?? externalId}` })
  return row!
}

export function publicIntegration(i: typeof schema.integrations.$inferSelect) {
  const { credentialsEnc, ...rest } = i
  return { ...rest, own_bot: !!credentialsEnc }
}

export const SCHEDULE_TYPES = ['auto_draft', 'weekly_plan', 'weekly_report', 'site_monitor', 'custom_task', 'collect_metrics'] as const
export const SCHEDULE_LABELS: Record<typeof SCHEDULE_TYPES[number], string> = {
  auto_draft: 'Автономный черновик поста', weekly_plan: 'Контент-план на неделю', weekly_report: 'Отчёт о результатах',
  site_monitor: 'Мониторинг новостей сайта', custom_task: 'Задача обычным языком', collect_metrics: 'Сбор метрик канала',
}

export async function saveSchedule(tenantId: string, input: {
  id?: string, type?: typeof SCHEDULE_TYPES[number], title?: string, cron?: string, params?: Record<string, unknown>, enabled?: boolean,
}, actor = 'operator') {
  const tenant = await getTenantOr404(tenantId)
  let existing: typeof schema.scheduledJobs.$inferSelect | undefined
  if (input.id) {
    [existing] = await db.select().from(schema.scheduledJobs).where(and(eq(schema.scheduledJobs.tenantId, tenantId), eq(schema.scheduledJobs.id, input.id)))
    if (!existing) throw notFound('Расписание')
  }
  const type = input.type ?? existing?.type
  if (!type || !SCHEDULE_TYPES.includes(type)) throw invalid('Неизвестный тип задачи')
  const cron = (input.cron ?? existing?.cron ?? '').trim()
  if (!isValidCron(cron)) throw invalid('Неверное выражение cron: нужно 5 полей, например «0 9 * * 1-5»')
  const params = { ...(existing?.params ?? {}), ...(input.params ?? {}) }
  if (type === 'site_monitor') {
    try { await assertPublicUrl(String(params.url ?? '')) }
    catch { throw invalid('Укажите адрес раздела новостей сайта (http/https)') }
  }
  if (type === 'custom_task' && !String(params.text ?? '').trim()) throw invalid('Опишите задачу словами')
  const enabled = input.enabled ?? existing?.enabled ?? true
  const values = {
    tenantId, type, title: input.title?.trim() || existing?.title || SCHEDULE_LABELS[type], cron, timezone: tenant.timezone, params, enabled,
    nextRunAt: enabled ? nextRun(cron, tenant.timezone) : null,
  }
  const [row] = existing
    ? await db.update(schema.scheduledJobs).set(values).where(eq(schema.scheduledJobs.id, existing.id)).returning()
    : await db.insert(schema.scheduledJobs).values(values).returning()
  await audit(tenantId, 'operator', actor, existing ? 'schedule.updated' : 'schedule.created', 'schedule', row!.id, { type, cron, enabled })
  return row!
}

export async function runScheduleNow(tenantId: string, scheduleId: string, idempotencyKey?: string, actor = 'operator') {
  const [job] = await db.select().from(schema.scheduledJobs).where(and(eq(schema.scheduledJobs.tenantId, tenantId), eq(schema.scheduledJobs.id, scheduleId)))
  if (!job) throw notFound('Расписание')
  const key = `manual:${job.id}:${idempotencyKey || Date.now()}`
  const id = await enqueue({
    tenantId, type: job.type, scheduledJobId: job.id, dedupKey: key,
    payload: { ...job.params, seen: undefined, scheduled_job_id: job.id, manual: true },
  })
  if (id) await audit(tenantId, 'operator', actor, 'schedule.run_now', 'schedule', job.id, { job_run_id: id })
  if (id) return id
  const [existing] = await db.select({ id: schema.jobRuns.id }).from(schema.jobRuns).where(eq(schema.jobRuns.dedupKey, key))
  return existing?.id ?? null
}
