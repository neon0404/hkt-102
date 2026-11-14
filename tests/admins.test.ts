process.env.TELEGRAM_BOT_TOKEN = ''
process.env.LLM_PROVIDER = 'mock'
process.env.OPERATOR_ALERT_CHAT_ID = ''

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { and, eq, inArray } from 'drizzle-orm'

const { db, pg, schema } = await import('../core/db/client')
const { runMigrations } = await import('../core/db/migrate')
const { adminDeleteBlock, AppError, createAdmin, deleteAdmin, listAdmins, updateAdmin } = await import('../core/services/admin')
const { verifyPassword } = await import('../core/crypto')

await runMigrations()
const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const mail = (n: string) => `test-${n}-${tag}@example.test`
after(async () => {
  await db.delete(schema.adminUsers).where(inArray(schema.adminUsers.email, ['a', 'b', 'c', 'd'].map(mail)))
  await pg.end()
})

const rejectsWith = (status: number, re: RegExp) => (e: unknown) => {
  assert.ok(e instanceof AppError)
  assert.equal(e.status, status)
  assert.match(e.message, re)
  return true
}

test('создание: почта в нижнем регистре, пароль хэшируется, поля сохраняются', async () => {
  const a = await createAdmin({ email: `  ${mail('a').toUpperCase()} `, password: 'Secret-123', name: ' Анна ', tg_user_id: '123456789' }, 'test')
  assert.equal(a.email, mail('a'))
  assert.equal(a.name, 'Анна')
  assert.equal(a.tg_user_id, 123456789)
  assert.equal((a as any).passwordHash, undefined)
  const [row] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, a.id))
  assert.notEqual(row!.passwordHash, 'Secret-123')
  assert.ok(verifyPassword('Secret-123', row!.passwordHash))
  assert.ok(!verifyPassword('secret-123', row!.passwordHash))
  const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'admin.created'), eq(schema.auditLogs.entityId, a.id)))
  assert.equal(logs.length, 1)
  assert.ok(!JSON.stringify(logs[0]!.data).includes('Secret-123'))
})

test('почта уникальна без учёта регистра', async () => {
  await createAdmin({ email: mail('b'), password: 'password-1' }, 'test')
  await assert.rejects(createAdmin({ email: mail('b').toUpperCase(), password: 'password-2' }, 'test'), rejectsWith(409, /такой почтой уже есть/))
})

test('проверка ввода: короткий пароль, плохая почта, нечисловой Telegram ID', async () => {
  await assert.rejects(createAdmin({ email: mail('c'), password: 'short' }, 'test'), rejectsWith(422, /не короче 8/))
  await assert.rejects(createAdmin({ email: 'не-почта', password: 'password-1' }, 'test'), rejectsWith(422, /почту/))
  await assert.rejects(createAdmin({ email: mail('c'), password: 'password-1', tg_user_id: '12ab' }, 'test'), rejectsWith(422, /Telegram ID/))
})

test('изменение: имя, Telegram ID, пароль; пустой пароль не меняет старый', async () => {
  const c = await createAdmin({ email: mail('c'), password: 'old-password' }, 'test')
  const u = await updateAdmin(c.id, { name: 'Иван', tg_user_id: 987654321, password: '' }, 'test')
  assert.equal(u.name, 'Иван')
  assert.equal(u.tg_user_id, 987654321)
  let [row] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, c.id))
  assert.ok(verifyPassword('old-password', row!.passwordHash))
  await updateAdmin(c.id, { password: 'new-password', tg_user_id: null }, 'test')
  ;[row] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, c.id))
  assert.ok(verifyPassword('new-password', row!.passwordHash))
  assert.equal(row!.tgUserId, null)
  await assert.rejects(updateAdmin(c.id, { password: '1234567' }, 'test'), rejectsWith(422, /не короче 8/))
  await assert.rejects(updateAdmin('00000000-0000-0000-0000-000000000000', { name: 'x' }, 'test'), rejectsWith(404, /пользователь/))
})

test('список отмечает текущего пользователя', async () => {
  const list = await listAdmins(mail('a'))
  const mine = list.filter(a => a.email.endsWith(`${tag}@example.test`))
  assert.ok(mine.length >= 3)
  assert.deepEqual(mine.filter(a => a.is_current).map(a => a.email), [mail('a')])
})

test('удаление: нельзя себя и последнего, другого можно', async () => {
  assert.match(adminDeleteBlock({ email: 'x@y.z' }, 'x@y.z', 5)!, /самого себя/)
  assert.match(adminDeleteBlock({ email: 'x@y.z' }, 'other@y.z', 1)!, /последнего/)
  assert.equal(adminDeleteBlock({ email: 'x@y.z' }, 'other@y.z', 2), null)

  const d = await createAdmin({ email: mail('d'), password: 'password-1' }, 'test')
  await assert.rejects(deleteAdmin(d.id, mail('d')), rejectsWith(409, /самого себя/))
  await deleteAdmin(d.id, mail('a'))
  const [gone] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, d.id))
  assert.equal(gone, undefined)
  await assert.rejects(deleteAdmin(d.id, mail('a')), rejectsWith(404, /пользователь/))
  const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'admin.deleted'), eq(schema.auditLogs.entityId, d.id)))
  assert.equal(logs.length, 1)
})
