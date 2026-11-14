import { handleRpc } from '~~/core/mcp/server'
import { resolveApiToken } from '~~/core/mcp/tokens'

const hits = new Map<string, number[]>()
function limited(tokenId: string) {
  const now = Date.now()
  const list = (hits.get(tokenId) ?? []).filter(t => now - t < 60_000)
  list.push(now)
  hits.set(tokenId, list)
  return list.length > 120
}

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  })
  const method = event.method
  if (method === 'OPTIONS') { setResponseStatus(event, 204); return '' }
  if (method !== 'POST') {
    setResponseStatus(event, 405)
    setResponseHeader(event, 'Allow', 'POST, OPTIONS')
    return { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Только POST: сервер работает без потоковых сессий' } }
  }

  const agent = await resolveApiToken(getHeader(event, 'authorization'))
  if (!agent) {
    setResponseStatus(event, 401)
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer realm="ai-smm", error="invalid_token"')
    return { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Нужен действующий токен компании: Authorization: Bearer smm_…' } }
  }
  if (limited(agent.tokenId)) {
    setResponseStatus(event, 429)
    return { jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Слишком много запросов, попробуйте через минуту' } }
  }

  let body: unknown
  try { body = await readBody(event) }
  catch {
    setResponseStatus(event, 400)
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
  }
  const batch = Array.isArray(body)
  const messages = (batch ? body : [body]) as any[]
  if (!messages.length || messages.length > 20) {
    setResponseStatus(event, 400)
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
  }
  const out = (await Promise.all(messages.map(m => handleRpc(m && typeof m === 'object' ? m : {}, { agent }).catch((e) => {
    console.error('[mcp] ошибка обработки запроса', e)
    return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: 'Внутренняя ошибка сервиса' } }
  })))).filter(Boolean)
  if (!out.length) { setResponseStatus(event, 202); return '' }
  setResponseHeader(event, 'Content-Type', 'application/json')
  return batch ? out : out[0]
})
