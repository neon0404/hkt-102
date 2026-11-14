process.env.TELEGRAM_BOT_TOKEN = ''
process.env.LLM_PROVIDER = 'mock'
process.env.OPERATOR_ALERT_CHAT_ID = ''

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { and, eq, inArray } from 'drizzle-orm'

const { db, pg, schema } = await import('../core/db/client')
const { runMigrations } = await import('../core/db/migrate')
const { createTenant, saveSchedule, updateTenant } = await import('../core/services/admin')
const { ingestSource } = await import('../core/kb/ingest')
const { searchChunks } = await import('../core/kb/search')
const { buildContext } = await import('../core/ai/context')
const { aiGeneratePost, aiRouteMessage, LimitError } = await import('../core/ai/ops')
const posts = await import('../core/services/posts')
const { postDetail } = await import('../core/services/views')
const { enqueue, claimJob } = await import('../core/jobs/queue')
const { schedulerTick } = await import('../core/scheduler')
const { sha256 } = await import('../core/crypto')

const stamp = Date.now()
let A: string, B: string
let memberA: typeof schema.tenantMembers.$inferSelect
let memberB: typeof schema.tenantMembers.$inferSelect

const SECRET_FACT = 'Завод «Альфа-Тест» выпускает ровно 7421 зеркальных панелей «Кварцит-Люкс» в сутки на линии в городе Тестоград.'

async function makeTenant(name: string, tgUserId: number) {
  const t = await createTenant({ name: `${name} ${stamp}`, settings: { provider: 'mock' } }, 'test')
  const [m] = await db.insert(schema.tenantMembers).values({ tenantId: t.id, tgUserId, tgChatId: tgUserId, displayName: `Тест ${name}`, roles: ['client', 'approver'] }).returning()
  return { id: t.id, member: m! }
}

async function makePost(tenantId: string, memberId: string, text = 'Тестовый пост о компании.') {
  const { post } = await posts.createPost(tenantId, {
    draft: { title: 'Тест', text, hashtags: ['#тест'], facts: [], warnings: [] }, origin: 'user_request', memberId,
  })
  await posts.sendForApproval(tenantId, post.id)
  const [approval] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.postId, post.id), eq(schema.approvals.decision, 'pending')))
  return { postId: post.id, approvalId: approval!.id }
}

before(async () => {
  await runMigrations()
  const a = await makeTenant('Тест-А', 900_000_000 + (stamp % 1_000_000))
  const b = await makeTenant('Тест-Б', 910_000_000 + (stamp % 1_000_000))
  A = a.id; B = b.id; memberA = a.member; memberB = b.member
  const [source] = await db.insert(schema.sources).values({ tenantId: A, kind: 'text', title: 'Секрет компании А', rawText: SECRET_FACT, contentHash: sha256(SECRET_FACT + stamp) }).returning()
  await ingestSource(A, source!.id)
})

after(async () => {
  await db.delete(schema.tenants).where(inArray(schema.tenants.id, [A, B].filter(Boolean)))
  await pg.end()
})

test('TC-09b: поиск по базе знаний не возвращает фрагменты другой компании', async () => {
  const own = await searchChunks(A, 'зеркальные панели Кварцит-Люкс Тестоград')
  assert.ok(own.length > 0, 'компания А находит свой факт')
  const foreign = await searchChunks(B, 'зеркальные панели Кварцит-Люкс Тестоград')
  assert.equal(foreign.length, 0, 'компания Б не видит фрагментов А')
})

test('TC-09b: в контексте модели для компании Б нет данных компании А', async () => {
  const ctx = await buildContext(B, { query: 'Сколько панелей Кварцит-Люкс выпускает завод Альфа-Тест?', memberId: memberB.id })
  assert.equal(ctx.chunks.length, 0)
  const route = await aiRouteMessage({ tenantId: B, calls: 0 }, ctx, 'Сколько панелей Кварцит-Люкс выпускает завод Альфа-Тест?')
  assert.ok(!route.reply.includes('7421'), 'в ответе нет чужого факта')
  assert.match(route.reply, /нет/i)
})

test('TC-03: факт из материалов попадает в пост со ссылкой на источник', async () => {
  const ctx = await buildContext(A, { query: 'зеркальные панели Кварцит-Люкс', history: false })
  const { draft } = await aiGeneratePost({ tenantId: A, calls: 0 }, ctx, { topic: 'Зеркальные панели Кварцит-Люкс' })
  assert.ok(draft.facts.length > 0)
  assert.ok(draft.facts.every(f => f.chunk_id && f.source_title === 'Секрет компании А'))
  const warnings = await posts.checkDraft(A, { ...draft, text: `${draft.text} Скидка 55% до конца месяца.` })
  assert.ok(warnings.some(w => w.includes('их нет в материалах компании') && w.includes('55')), 'число без источника помечается')
})

test('TC-09a: пост компании А недоступен в контексте компании Б', async () => {
  const { postId } = await makePost(A, memberA.id)
  assert.ok(await postDetail(A, postId))
  assert.equal(await postDetail(B, postId), null)
  assert.equal(await posts.getPost(B, postId), null)
})

test('TC-09d: участник компании Б не может нажать кнопку согласования компании А', async () => {
  const { postId, approvalId } = await makePost(A, memberA.id)
  const res = await posts.decideApproval(approvalId, memberB.tgUserId, 'a')
  assert.equal(res.ok, false)
  assert.equal((await posts.getPost(A, postId))!.status, 'in_review')
  const denied = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, A), eq(schema.auditLogs.action, 'access.denied'), eq(schema.auditLogs.entityId, approvalId)))
  assert.equal(denied.length, 1, 'отказ записан в журнал')
})

test('TC-09c: канал нельзя подключить ко второй компании', async () => {
  const ext = `-100${stamp}`
  await db.insert(schema.integrations).values({ tenantId: A, platform: 'telegram', externalId: ext, title: 'Канал А' })
  await assert.rejects(db.insert(schema.integrations).values({ tenantId: B, platform: 'telegram', externalId: ext, title: 'Канал Б' }))
  await db.delete(schema.integrations).where(eq(schema.integrations.externalId, ext))
})

test('TC-06: отклонённый пост не публикуется', async () => {
  const { postId, approvalId } = await makePost(A, memberA.id)
  const res = await posts.decideApproval(approvalId, memberA.tgUserId, 'r')
  assert.deepEqual(res, { ok: true, action: 'rejected', postId })
  assert.equal((await posts.getPost(A, postId))!.status, 'rejected')
  await posts.enqueueDuePublications()
  const queued = await db.select().from(schema.jobRuns).where(and(eq(schema.jobRuns.tenantId, A), eq(schema.jobRuns.type, 'publish_post')))
  assert.ok(!queued.some(j => j.payload.post_id === postId), 'публикация не поставлена в очередь')
  assert.equal((await posts.publishPost(A, postId)).status, 'not_eligible')
  assert.equal((await db.select().from(schema.publications).where(eq(schema.publications.postId, postId))).length, 0)
})

test('TC-06: пост без решения согласующего не публикуется', async () => {
  const { postId } = await makePost(A, memberA.id)
  assert.equal((await posts.publishPost(A, postId)).status, 'not_eligible')
})

test('TC-05n: повторное нажатие и устаревшая карточка не меняют данные', async () => {
  const { postId, approvalId } = await makePost(A, memberA.id)
  await posts.addVersion(A, postId, { draft: { title: 'Тест', text: 'Новая версия текста.', hashtags: [], facts: [], warnings: [] } })
  const stale = await posts.decideApproval(approvalId, memberA.tgUserId, 'a')
  assert.equal(stale.ok, false, 'карточка прежней версии не действует')
  assert.equal((await posts.getPost(A, postId))!.approvedVersionId, null)
})

test('TC-06b: изменение после одобрения сбрасывает одобрение', async () => {
  const { postId, approvalId } = await makePost(A, memberA.id)
  const future = new Date(Date.now() + 3600_000)
  await db.update(schema.posts).set({ scheduledAt: future }).where(eq(schema.posts.id, postId))
  assert.equal((await posts.decideApproval(approvalId, memberA.tgUserId, 'a')).ok, true)
  assert.equal((await posts.getPost(A, postId))!.status, 'scheduled')
  const again = await posts.decideApproval(approvalId, memberA.tgUserId, 'a')
  assert.equal(again.ok, false, 'повторное нажатие без эффекта')
  await posts.addVersion(A, postId, { draft: { title: 'Тест', text: 'Изменённый текст.', hashtags: [], facts: [], warnings: [] }, comment: 'правка' })
  const post = (await posts.getPost(A, postId))!
  assert.equal(post.approvedVersionId, null)
  assert.equal(post.status, 'draft')
  assert.equal((await posts.publishPost(A, postId)).status, 'not_eligible')
})

test('FR-024: перенос времени одобренного поста требует повторного согласования', async () => {
  const { postId, approvalId } = await makePost(A, memberA.id)
  await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() + 3600_000) }).where(eq(schema.posts.id, postId))
  await posts.decideApproval(approvalId, memberA.tgUserId, 'a')
  const { needsApproval } = await posts.reschedulePost(A, postId, new Date(Date.now() + 7200_000))
  assert.equal(needsApproval, true)
  assert.equal((await posts.getPost(A, postId))!.approvedVersionId, null)
  await posts.sendForApproval(A, postId)
  const pending = await db.select().from(schema.approvals).where(and(eq(schema.approvals.postId, postId), eq(schema.approvals.decision, 'pending')))
  assert.equal(pending.length, 1, 'создано новое согласование той же версии')
})

test('TC-11: два исполнителя не публикуют один пост дважды', async () => {
  const { postId, approvalId } = await makePost(A, memberA.id)
  await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() + 3600_000) }).where(eq(schema.posts.id, postId))
  await posts.decideApproval(approvalId, memberA.tgUserId, 'a')
  const results = await Promise.all([posts.publishPost(A, postId), posts.publishPost(A, postId)])
  const statuses = results.map(r => r.status).sort()
  assert.deepEqual(statuses, ['failed', 'not_eligible'])
})

test('TC-11: повторная постановка задачи с тем же ключом не создаёт дубль', async () => {
  const key = `msg:test-${stamp}`
  const first = await enqueue({ tenantId: A, type: 'noop_test', dedupKey: key, runAfter: new Date(Date.now() + 86400_000) })
  const second = await enqueue({ tenantId: A, type: 'noop_test', dedupKey: key })
  assert.ok(first)
  assert.equal(second, null)
})

test('TC-08n: два такта планировщика подряд дают один запуск', async () => {
  const s = await saveSchedule(A, { type: 'collect_metrics', cron: '0 9 * * *' }, 'test')
  const past = new Date(Date.now() - 60_000)
  await db.update(schema.scheduledJobs).set({ nextRunAt: past }).where(eq(schema.scheduledJobs.id, s.id))
  await schedulerTick()
  await schedulerTick()
  const runs = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.scheduledJobId, s.id))
  assert.equal(runs.length, 1)
  const [after] = await db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.id, s.id))
  assert.ok(after!.nextRunAt!.getTime() > Date.now(), 'следующий запуск сдвинут в будущее')
  await db.delete(schema.jobRuns).where(eq(schema.jobRuns.scheduledJobId, s.id))
})

test('S-7: запуск, опоздавший больше чем на 6 часов, помечается пропущенным', async () => {
  const s = await saveSchedule(A, { type: 'collect_metrics', cron: '0 10 * * *' }, 'test')
  await db.update(schema.scheduledJobs).set({ nextRunAt: new Date(Date.now() - 7 * 3600_000) }).where(eq(schema.scheduledJobs.id, s.id))
  const res = await schedulerTick()
  assert.ok(res.skipped >= 1)
  const [run] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.scheduledJobId, s.id))
  assert.equal(run!.status, 'skipped')
})

test('TC-14: при исчерпанном лимите вызова модели нет', async () => {
  await updateTenant(B, { settings: { daily_call_limit: 0 } }, 'test')
  const ctx = await buildContext(B, { query: 'пост', history: false })
  const before = await db.select().from(schema.llmUsage).where(eq(schema.llmUsage.tenantId, B))
  await assert.rejects(aiGeneratePost({ tenantId: B, calls: 0 }, ctx, { topic: 'Любая тема' }), LimitError)
  const afterRows = await db.select().from(schema.llmUsage).where(eq(schema.llmUsage.tenantId, B))
  assert.equal(afterRows.length, before.length, 'расход не изменился')
})

test('Очередь: задачу берёт только один исполнитель', async () => {
  const id = await enqueue({ tenantId: A, type: 'noop_claim_test', dedupKey: `claim:${stamp}`, runAfter: new Date(0) })
  const claimed = (await Promise.all([claimJob(), claimJob(), claimJob()])).filter(j => j?.id === id)
  assert.equal(claimed.length, 1)
  await db.delete(schema.jobRuns).where(eq(schema.jobRuns.id, id!))
})
