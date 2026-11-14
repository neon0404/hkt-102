import type { H3Event } from 'h3'
import { and, eq } from 'drizzle-orm'
import { config } from '~~/core/config'
import { signToken, verifyTelegramInitData, verifyToken } from '~~/core/crypto'
import { db, schema } from '~~/core/db/client'
import { AppError, getTenantOr404, operatorExists } from '~~/core/services/admin'

export const SESSION_COOKIE = 'aim_session'
const SESSION_HOURS = 12

export interface RouteCtx {
  event: H3Event
  params: Record<string, string>
  query: Record<string, string>
  body: any
  operator: string
  tenantId: string
}

type RouteHandler = (ctx: RouteCtx) => Promise<unknown> | unknown
interface Route { method: string, regex: RegExp, keys: string[], handler: RouteHandler, auth: 'operator' | 'public' | 'miniapp', status?: number }

const routes: Route[] = []

export function route(method: string, path: string, handler: RouteHandler, opts: { auth?: Route['auth'], status?: number } = {}) {
  const keys: string[] = []
  const regex = new RegExp(`^${path.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)' })}/?$`)
  routes.push({ method, regex, keys, handler, auth: opts.auth ?? 'operator', status: opts.status })
}

export function createSession(event: H3Event, email: string) {
  const token = signToken({ email, exp: Date.now() + SESSION_HOURS * 3600_000 })
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_HOURS * 3600, secure: config.publicBaseUrl.startsWith('https'),
  })
}

export function currentOperator(event: H3Event): string | null {
  return verifyToken<{ email: string }>(getCookie(event, SESSION_COOKIE))?.email ?? null
}

export async function miniappUser(event: H3Event) {
  const initData = getHeader(event, 'x-telegram-init-data') ?? ''
  const user = initData ? verifyTelegramInitData(initData, config.telegramBotToken) : null
  if (!user) throw new AppError(401, 'unauthorized', 'Откройте приложение из Telegram')
  const members = await db.select().from(schema.tenantMembers)
    .where(and(eq(schema.tenantMembers.tgUserId, user.id), eq(schema.tenantMembers.status, 'active')))
  if (!members.length) throw new AppError(403, 'forbidden', 'Доступа нет. Запросите приглашение у оператора.')
  const [session] = await db.select().from(schema.tgSessions).where(eq(schema.tgSessions.tgUserId, user.id))
  const member = members.find(m => m.tenantId === session?.activeTenantId) ?? members[0]!
  return { user, member, members }
}

export async function dispatch(event: H3Event) {
  const url = getRequestURL(event)
  const path = url.pathname.replace(/^\/api\/v1/, '') || '/'
  const method = event.method.toUpperCase()
  try {
    for (const r of routes) {
      if (r.method !== method) continue
      const m = path.match(r.regex)
      if (!m) continue
      let params: Record<string, string>
      try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) }
      catch { throw new AppError(404, 'not_found', 'Маршрут не найден') }
      let operator = ''
      if (r.auth === 'operator') {
        operator = currentOperator(event) ?? ''
        if (!operator || !await operatorExists(operator)) throw new AppError(401, 'unauthorized', 'Требуется вход')
      }
      const tenantId = params.t ? (await getTenantOr404(params.t)).id : ''
      const type = getHeader(event, 'content-type') ?? ''
      const body = ['POST', 'PUT', 'PATCH'].includes(method) && type.includes('application/json') ? (await readBody(event).catch(() => ({})) ?? {}) : {}
      const result = await r.handler({ event, params, query: getQuery(event) as Record<string, string>, body, operator, tenantId })
      if (r.status) setResponseStatus(event, r.status)
      return result ?? { ok: true }
    }
    throw new AppError(404, 'not_found', 'Маршрут не найден')
  }
  catch (e) {
    if (e instanceof AppError) {
      setResponseStatus(event, e.status)
      return { error: { code: e.code, message: e.message, details: e.details } }
    }
    console.error('[api]', method, path, e)
    setResponseStatus(event, 500)
    return { error: { code: 'internal_error', message: 'Внутренняя ошибка сервера', details: {} } }
  }
}
