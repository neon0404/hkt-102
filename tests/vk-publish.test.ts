process.env.TELEGRAM_BOT_TOKEN = ''
process.env.LLM_PROVIDER = 'mock'
process.env.OPERATOR_ALERT_CHAT_ID = ''

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { and, eq } from 'drizzle-orm'

const { db, pg, schema } = await import('../core/db/client')
const { runMigrations } = await import('../core/db/migrate')
const { createTenant } = await import('../core/services/admin')
const { encryptSecret } = await import('../core/crypto')
const posts = await import('../core/services/posts')
const { postDetail } = await import('../core/services/views')

const stamp = Date.now()
let tenantId = ''
let member: typeof schema.tenantMembers.$inferSelect
const vkCalls: Array<{ method: string, params: Record<string, string> }> = []
const realFetch = globalThis.fetch

before(async () => {
  await runMigrations()
  const t = await createTenant({ name: `ВК-тест ${stamp}`, settings: { provider: 'mock', post_format: 'rich' } }, 'test')
  tenantId = t.id
  ;[member] = await db.insert(schema.tenantMembers).values({ tenantId, tgUserId: 920_000_000 + (stamp % 1_000_000), tgChatId: 1, displayName: 'Тест ВК', roles: ['client', 'approver'] }).returning() as any
  await db.insert(schema.integrations).values({ tenantId, platform: 'vk', externalId: String(42_000 + (stamp % 1000)), title: 'Сообщество', username: `vk_test_${stamp}`, credentialsEnc: encryptSecret('user-token'), status: 'active' })
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (u.startsWith('https://upload.vk.test')) return json({ server: 1, photo: '[{"p":1}]', hash: 'h' })
    if (!u.startsWith('https://api.vk.com/method/')) return realFetch(url, init)
    const method = u.split('/').pop()!
    vkCalls.push({ method, params: init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {} })
    if (method === 'photos.getWallUploadServer') return json({ response: { upload_url: 'https://upload.vk.test/x' } })
    if (method === 'photos.saveWallPhoto') return json({ response: [{ id: 55, owner_id: -42 }] })
    if (method === 'wall.post') return json({ response: { post_id: 9 } })
    return json({ error: { error_code: 100, error_msg: 'unknown' } })
  }) as typeof fetch
})

after(async () => {
  globalThis.fetch = realFetch
  if (tenantId) await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId))
  await pg.end()
})

test('ВК: одобренный пост уходит на стену сообщества простым текстом с картинкой', async () => {
  const { post } = await posts.createPost(tenantId, {
    draft: { title: 'Тест', text: 'Хук поста.\n\n### 🏢 Подзаголовок\n- **первый** пункт\n- второй пункт', hashtags: ['#тест'], facts: [], warnings: [] },
    origin: 'user_request', memberId: member.id,
  })
  assert.equal(post.platform, 'vk', 'без Telegram-канала основная площадка — ВК')
  await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() + 3600_000) }).where(eq(schema.posts.id, post.id))
  await posts.sendForApproval(tenantId, post.id)
  const [approval] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.postId, post.id), eq(schema.approvals.decision, 'pending')))
  await posts.decideApproval(approval!.id, member.tgUserId, 'a')

  const res = await posts.publishPost(tenantId, post.id)
  assert.equal(res.status, 'published')
  assert.match(res.url!, /^https:\/\/vk\.com\/wall-\d+_9$/)
  const wall = vkCalls.find(c => c.method === 'wall.post')!
  assert.ok(wall.params.owner_id!.startsWith('-'))
  assert.equal(wall.params.from_group, '1')
  assert.equal(wall.params.message, 'Хук поста.\n\n🏢 Подзаголовок\n• первый пункт\n• второй пункт\n\n#тест')
  assert.match(wall.params.attachments!, /^photo-42_55/)
  const detail = await postDetail(tenantId, post.id)
  assert.equal(detail!.publication?.status, 'published')
  assert.equal(detail!.status, 'published')
})
