process.env.TELEGRAM_BOT_TOKEN = ''
process.env.LLM_PROVIDER = 'mock'
process.env.OPERATOR_ALERT_CHAT_ID = ''

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { and, eq } from 'drizzle-orm'

const { db, pg, schema } = await import('../core/db/client')
const { runMigrations } = await import('../core/db/migrate')
const { createTenant } = await import('../core/services/admin')
const posts = await import('../core/services/posts')
const { decideByMessage, pendingApprovalFor } = await import('../core/jobs/handlers')
const { humanize, humanizeDeep } = await import('../core/ai/humanize')

await runMigrations()
const created: string[] = []
after(async () => {
  for (const id of created) await db.delete(schema.tenants).where(eq(schema.tenants.id, id))
  await pg.end()
})

let uid = 700_000_000 + Math.floor(Math.random() * 1_000_000)
async function setup(roles: Array<'client' | 'approver'> = ['client', 'approver']) {
  const t = await createTenant({ name: `Решения ${Date.now()}-${uid}`, settings: { provider: 'mock' } }, 'test')
  created.push(t.id)
  const [m] = await db.insert(schema.tenantMembers).values({ tenantId: t.id, tgUserId: ++uid, tgChatId: uid, displayName: 'Тест', roles }).returning()
  const { post } = await posts.createPost(t.id, {
    draft: { title: 'Стекло для витрин', text: 'Текст поста.', hashtags: [], facts: [], warnings: [] }, origin: 'user_request', memberId: m!.id,
  })
  await posts.sendForApproval(t.id, post.id)
  return { tenantId: t.id, member: m!, postId: post.id }
}

test('«одобряю» голосом одобряет последнюю карточку и пишется в журнал', async () => {
  const { tenantId, member, postId } = await setup()
  assert.ok(await pendingApprovalFor(member))
  const r = await decideByMessage(member, 'a', { at: 'now' })
  assert.equal(r.ok, true)
  assert.match(r.text, /Одобрил пост «Стекло для витрин»/)
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId))
  assert.equal(p!.status, 'approved')
  assert.equal(p!.approvedVersionId, p!.currentVersionId)
  const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, 'approval.by_message')))
  assert.equal(logs.length, 1)
  const again = await decideByMessage(member, 'a')
  assert.equal(again.ok, false)
})

test('«отклоняю» голосом отклоняет, пост не публикуется', async () => {
  const { tenantId, member, postId } = await setup()
  const r = await decideByMessage(member, 'r')
  assert.equal(r.ok, true)
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId))
  assert.equal(p!.status, 'rejected')
  assert.equal((await posts.publishPost(tenantId, postId)).status, 'not_eligible')
})

test('участник без права согласования не может одобрить словами', async () => {
  const { member, postId } = await setup(['client'])
  const r = await decideByMessage(member, 'a')
  assert.equal(r.ok, false)
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId))
  assert.notEqual(p!.status, 'approved')
})

test('одобрение с новым временем ставит пост в расписание', async () => {
  const { member, postId } = await setup()
  const at = new Date(Date.now() + 86_400_000)
  const r = await decideByMessage(member, 'a', { at })
  assert.equal(r.ok, true)
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId))
  assert.equal(p!.status, 'scheduled')
  assert.equal(p!.scheduledAt?.getTime(), at.getTime())
})

test('из текстов для людей убираются служебные пометки, коды продуктов остаются', () => {
  assert.equal(humanize('chunk_id: c2 — все утверждения о сырье.'), 'Все утверждения о сырье.')
  assert.equal(humanize('Пропускает 97% света (c1, c3) и подходит для витрин [c4].'), 'Пропускает 97% света и подходит для витрин.')
  assert.equal(humanize('warnings: В материалах нет данных.'), 'В материалах нет данных.')
  assert.equal(humanize('Отдельного фрагмента о свойствах нет.'), 'Отдельного материала о свойствах нет.')
  assert.equal(humanize('Класс C1 по ГОСТ, работаем c 2020 года.'), 'Класс C1 по ГОСТ, работаем c 2020 года.')
  const deep = humanizeDeep({ text: 'Факт (c2).', facts: [{ claim: 'Факт', chunk_id: 'c2' }], warnings: ['chunk_id: c1 — проверить'] })
  assert.equal(deep.text, 'Факт.')
  assert.equal(deep.facts[0]!.chunk_id, 'c2')
  assert.equal(deep.warnings[0], 'Проверить')
  assert.deepEqual(humanizeDeep({ warnings: ['В задании указан c4, но сведения подтверждены фрагментом c2.', 'Проверьте срок поставки.'] }).warnings, ['Проверьте срок поставки.'])
})
