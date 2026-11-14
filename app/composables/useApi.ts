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

export const fmtDate = (v: string | Date | null | undefined, tz?: string) => {
  if (!v) return '—'
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(v))
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

export const PROVIDER_NAMES: Record<string, string> = {
  chatgpt_account: 'Аккаунт ChatGPT',
  api: 'API-ключ',
  mock: 'Заглушка',
}

export const statusOf = (p: any): { label: string, color: any } =>
  p?.revising ? { label: 'На доработке', color: 'info' } : POST_STATUS[p?.status] ?? { label: p?.status ?? '—', color: 'neutral' }
