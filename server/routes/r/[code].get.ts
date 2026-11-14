import { registerClick } from '~~/core/analytics'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code') ?? ''
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? ''
  const url = await registerClick(code, ip, getHeader(event, 'user-agent') ?? '').catch(() => null)
  if (!url) throw createError({ statusCode: 404, statusMessage: 'Ссылка не найдена' })
  setHeader(event, 'cache-control', 'no-store')
  return sendRedirect(event, url, 302)
})
