process.env.TELEGRAM_BOT_TOKEN = ''
process.env.LLM_PROVIDER = 'mock'
process.env.OPERATOR_ALERT_CHAT_ID = ''

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { and, eq } from 'drizzle-orm'

const { db, pg, schema } = await import('../core/db/client')
const { runMigrations } = await import('../core/db/migrate')
const { createTenant } = await import('../core/services/admin')
const posts = await import('../core/services/posts')

const stamp = Date.now()
let tenantId = ''
let member: typeof schema.tenantMembers.$inferSelect

async function approvedPost(at: Date | null) {
  const { post } = await posts.createPost(tenantId, {
    draft: { title: 'Тест', text: 'Текст поста для проверки отправки.', hashtags: [], facts: [], warnings: [] }, origin: 'user_request', memberId: member.id,
  })
  await db.update(schema.posts).set({ scheduledAt: at ?? new Date(Date.now() + 3 * 3600_000) }).where(eq(schema.posts.id, post.id))
  await posts.sendForApproval(tenantId, post.id)
  const [a] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.postId, post.id), eq(schema.approvals.decision, 'pending')))
  return { postId: post.id, approvalId: a!.id }
}

before(async () => {
  await runMigrations()
  const t = await createTenant({ name: `Отправка ${stamp}`, settings: { provider: 'mock', post_format: 'classic' } }, 'test')
  tenantId = t.id
  ;[member] = await db.insert(schema.tenantMembers).values({ tenantId, tgUserId: 930_000_000 + (stamp % 1_000_000), tgChatId: 1, displayName: 'Тест', roles: ['client', 'approver'] }).returning() as any
})

after(async () => {
  if (tenantId) await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId))
  await pg.end()
})

test('Опубликовать сейчас: неодобренный пост отправить нельзя', async () => {
  const { postId } = await approvedPost(null)
  await assert.rejects(posts.publishNow(tenantId, postId, { type: 'operator', id: 'test' }), posts.PostStateError)
})

test('Опубликовать сейчас: одобренный пост встаёт в очередь сразу, время — сейчас', async () => {
  const { postId, approvalId } = await approvedPost(null)
  await posts.decideApproval(approvalId, member.tgUserId, 'a')
  assert.equal((await posts.getPost(tenantId, postId))!.status, 'scheduled')
  await posts.publishNow(tenantId, postId, { type: 'operator', id: 'test' })
  const p = (await posts.getPost(tenantId, postId))!
  assert.equal(p.status, 'approved')
  assert.ok(Math.abs(p.scheduledAt!.getTime() - Date.now()) < 10_000)
  const jobs = await db.select().from(schema.jobRuns).where(and(eq(schema.jobRuns.tenantId, tenantId), eq(schema.jobRuns.type, 'publish_post')))
  assert.ok(jobs.some(j => (j.payload as any).post_id === postId), 'задача публикации поставлена')
  await db.delete(schema.jobRuns).where(eq(schema.jobRuns.tenantId, tenantId))
})

test('Перенос времени согласующим сохраняет одобрение, обычный — сбрасывает', async () => {
  const { postId, approvalId } = await approvedPost(null)
  await posts.decideApproval(approvalId, member.tgUserId, 'a')
  const later = new Date(Date.now() + 5 * 3600_000)
  assert.equal((await posts.reschedulePost(tenantId, postId, later, { keepApproval: true })).needsApproval, false)
  let p = (await posts.getPost(tenantId, postId))!
  assert.equal(p.status, 'scheduled')
  assert.equal(p.approvedVersionId, p.currentVersionId)
  assert.equal(p.scheduledAt!.getTime(), later.getTime())
  assert.equal((await posts.reschedulePost(tenantId, postId, new Date(Date.now() + 6 * 3600_000))).needsApproval, true)
  p = (await posts.getPost(tenantId, postId))!
  assert.equal(p.approvedVersionId, null)
})
