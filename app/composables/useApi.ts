export function useApi() {
  const toast = useToast()

  async function api<T = any>(path: string, opts: { method?: string, body?: any, query?: Record<string, any>, headers?: Record<string, string>, silent?: boolean } = {}): Promise<T> {
    try {
      return await $fetch<T>(`/api/v1${path}`, { method: (opts.method ?? 'GET') as any, body: opts.body, query: opts.query, headers: opts.headers })
    }
    catch (e: any) {
      const status = e?.response?.status
      const message = e?.data?.error?.message ?? 'Сервер недоступен'
      if (status === 401 && !path.startsWith('/auth')) {
        await navigateTo('/login')
      }
      else if (!opts.silent) {
        toast.add({ title: message, color: 'error', icon: 'i-lucide-circle-alert' })
      }
      throw Object.assign(new Error(message), { status, code: e?.data?.error?.code })
    }
  }

  return { api }
}

const yearIn = (d: Date, tz?: string) => new Intl.DateTimeFormat('ru-RU', { year: 'numeric', timeZone: tz }).format(d)

export const fmtDate = (v: string | Date | null | undefined, tz?: string) => {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const withYear = yearIn(d, tz) !== yearIn(new Date(), tz)
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: withYear ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d)
}

function tzOffsetMs(d: Date, tz?: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asUtc - Math.floor(d.getTime() / 1000) * 1000
}

export const toZonedInput = (v: string | Date | null | undefined, tz?: string) => {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() + tzOffsetMs(d, tz)).toISOString().slice(0, 16)
}

export const fromZonedInput = (v: string, tz?: string) => {
  if (!v) return null
  const guess = Date.parse(`${v}:00Z`)
  if (Number.isNaN(guess)) return null
  const first = guess - tzOffsetMs(new Date(guess), tz)
  return new Date(guess - tzOffsetMs(new Date(first), tz)).toISOString()
}

export const plural = (n: number, forms: [string, string, string]) => {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

export const POST_STATUS: Record<string, { label: string, color: any }> = {
  draft: { label: 'Черновик', color: 'neutral' },
  in_review: { label: 'На согласовании', color: 'warning' },
  approved: { label: 'Одобрен', color: 'info' },
  scheduled: { label: 'Запланирован', color: 'info' },
  publishing: { label: 'Публикуется', color: 'info' },
  published: { label: 'Опубликован', color: 'success' },
  failed: { label: 'Ошибка публикации', color: 'error' },
  rejected: { label: 'Отклонён', color: 'error' },
}

export const POST_ORIGIN: Record<string, string> = {
  user_request: 'По запросу',
  schedule: 'Автономно',
  plan: 'По плану',
  operator: 'Оператор',
}

export const PROVIDER_NAMES: Record<string, string> = {
  chatgpt_account: 'Аккаунт ChatGPT',
  api: 'API-ключ',
  mock: 'Заглушка',
}

export const statusOf = (p: any): { label: string, color: any } =>
  p?.revising ? { label: 'На доработке', color: 'info' } : POST_STATUS[p?.status] ?? { label: 'Неизвестно', color: 'neutral' }
