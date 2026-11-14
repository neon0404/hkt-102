export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login' || to.path.startsWith('/app')) return
  const me = useState<string | null>('operator', () => null)
  if (me.value) return
  try {
    const res = await $fetch<{ email: string }>('/api/v1/auth/me')
    me.value = res.email
  }
  catch {
    return navigateTo('/login')
  }
})
