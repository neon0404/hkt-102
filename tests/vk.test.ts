import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupRef, uploadWallPhoto, VkError, vkPostUrl, wallPost } from '../core/vk/api'

test('groupRef: ссылка, короткое имя, club/public и ID', () => {
  assert.equal(groupRef('https://vk.com/salavatsteklo'), 'salavatsteklo')
  assert.equal(groupRef('vk.com/club12345'), '12345')
  assert.equal(groupRef('https://vk.com/club12345'), '12345')
  assert.equal(groupRef('public777'), '777')
  assert.equal(groupRef('@salavat.steklo'), 'salavat.steklo')
  assert.equal(groupRef('https://m.vk.com/salavatsteklo?from=x'), 'salavatsteklo')
  assert.equal(groupRef(''), null)
  assert.equal(groupRef('плохое имя'), null)
})

test('VK: загрузка фото на стену и публикация от имени сообщества', async () => {
  const calls: Array<{ url: string, params: Record<string, string> }> = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const params = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {}
    calls.push({ url: String(url), params })
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (String(url).endsWith('photos.getWallUploadServer')) return json({ response: { upload_url: 'https://upload.vk.test/x' } })
    if (String(url).startsWith('https://upload.vk.test')) return json({ server: 1, photo: '[{"p":1}]', hash: 'h' })
    if (String(url).endsWith('photos.saveWallPhoto')) return json({ response: [{ id: 55, owner_id: -42 }] })
    if (String(url).endsWith('wall.post')) return json({ response: { post_id: 9 } })
    return json({ error: { error_code: 100, error_msg: 'unknown' } })
  }) as typeof fetch
  try {
    const att = await uploadWallPhoto(42, 'tok', Buffer.from([0x89, 0x50]))
    assert.equal(att, 'photo-42_55')
    const id = await wallPost(42, 'tok', 'Текст поста #тег', [att])
    assert.equal(id, 9)
    const post = calls.find(c => c.url.endsWith('wall.post'))!
    assert.equal(post.params.owner_id, '-42')
    assert.equal(post.params.from_group, '1')
    assert.equal(post.params.attachments, 'photo-42_55')
    assert.equal(post.params.access_token, 'tok')
    assert.equal(vkPostUrl(42, id), 'https://vk.com/wall-42_9')
  }
  finally { globalThis.fetch = real }
})

test('VK: ошибка ключа сообщества объясняется по-человечески', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { error_code: 27, error_msg: 'Group authorization failed' } }))) as typeof fetch
  try {
    await assert.rejects(wallPost(1, 'group-token', 'x', []), (e: unknown) => e instanceof VkError && /ключ пользователя-администратора/.test(e.message))
  }
  finally { globalThis.fetch = real }
})

test('VK: права на стену — is_admin любым видом или список сообществ редактора', async () => {
  const { canPostToWall } = await import('../core/vk/api')
  const real = globalThis.fetch
  let items: unknown[] = []
  let fail = 0
  globalThis.fetch = (async () => new Response(JSON.stringify(fail ? { error: { error_code: fail, error_msg: 'no' } } : { response: { count: items.length, items } }))) as typeof fetch
  try {
    const g = { id: 42, name: 'Сообщество', screen_name: 's' }
    assert.equal(await canPostToWall({ ...g, is_admin: true }, 't'), null)
    assert.equal(await canPostToWall({ ...g, is_admin: 1, admin_level: 3 }, 't'), null)
    assert.match((await canPostToWall({ ...g, is_admin: 1, admin_level: 1 }, 't'))!, /модератор/)
    items = [7, 42]
    assert.equal(await canPostToWall(g, 't'), null, 'is_admin не пришёл — сообщество есть в списке редактора')
    items = [7]
    assert.match((await canPostToWall(g, 't'))!, /не администратор/)
    fail = 15
    assert.match((await canPostToWall(g, 't'))!, /нет права groups/)
  }
  finally { globalThis.fetch = real }
})
