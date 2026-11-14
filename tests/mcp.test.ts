import assert from 'node:assert/strict'
import { test } from 'node:test'
import { richMarkdown } from '../core/services/post-media'

test('richMarkdown: карусель, текст, хештеги', () => {
  const md = richMarkdown('Хук.\n\n### 🔬 Как устроено\n- пункт', ['#стекло', 'витрины'], ['a', 'b', 'c'])
  assert.match(md, /^<tg-slideshow>\n!\[\]\(tg:\/\/photo\?id=a\)\n!\[\]\(tg:\/\/photo\?id=b\)\n!\[\]\(tg:\/\/photo\?id=c\)\n<\/tg-slideshow>/)
  assert.match(md, /### 🔬 Как устроено/)
  assert.match(md, /\\#стекло \\#витрины$/)
})

test('richMarkdown: одно фото без карусели, сетка по выбору', () => {
  assert.equal(richMarkdown('Текст', [], ['a']), '![](tg://photo?id=a)\n\nТекст')
  assert.match(richMarkdown('Т', [], ['a', 'b'], 'collage'), /^<tg-collage>/)
})

test('MCP: initialize, список инструментов, неизвестный метод', async () => {
  const { handleRpc, toolList, PROTOCOL_VERSIONS } = await import('../core/mcp/server')
  const tools = toolList()
  assert.ok(tools.length >= 15)
  for (const t of tools) {
    assert.match(t.name, /^[a-z_]+$/)
    assert.equal((t.inputSchema as any).type, 'object')
  }
  assert.ok(tools.find(t => t.name === 'create_post'))
  assert.ok(!tools.find(t => /approve|publish/.test(t.name)), 'одобрять и публиковать агент не может')
  const ctx = { agent: { tenantId: '00000000-0000-0000-0000-000000000000', tokenId: 'x', name: 'test' } }
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null)
  const nf = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope' }, ctx) as any
  assert.equal(nf.error.code, -32601)
  const bad = await handleRpc({ id: 4, method: 'ping' } as any, ctx) as any
  assert.equal(bad.error.code, -32600)
  assert.ok(PROTOCOL_VERSIONS.includes('2025-06-18'))
})
