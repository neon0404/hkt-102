export interface Section {
  value: string
  label: string
  icon: string
  group: 'work' | 'setup' | 'system'
  step?: string
}

export const SECTIONS: Section[] = [
  { value: '', label: 'Обзор', icon: 'i-lucide-layout-dashboard', group: 'work' },
  { value: 'posts', label: 'Публикации', icon: 'i-lucide-newspaper', group: 'work' },
  { value: 'plan', label: 'Контент-план', icon: 'i-lucide-calendar-days', group: 'work' },
  { value: 'comments', label: 'Комментарии', icon: 'i-lucide-messages-square', group: 'work' },
  { value: 'competitors', label: 'Конкуренты', icon: 'i-lucide-radar', group: 'work' },
  { value: 'profile', label: 'Профиль', icon: 'i-lucide-building-2', group: 'setup' },
  { value: 'sources', label: 'Источники', icon: 'i-lucide-library', group: 'setup', step: 'sources' },
  { value: 'brand', label: 'Бренд', icon: 'i-lucide-sparkles', group: 'setup', step: 'brand_profile' },
  { value: 'channels', label: 'Каналы', icon: 'i-lucide-send', group: 'setup', step: 'integration' },
  { value: 'members', label: 'Участники', icon: 'i-lucide-users', group: 'setup', step: 'members' },
  { value: 'automation', label: 'Автоматизация', icon: 'i-lucide-calendar-clock', group: 'setup', step: 'schedule' },
  { value: 'ai', label: 'Модель', icon: 'i-lucide-bot', group: 'system' },
  { value: 'agents', label: 'Агенты', icon: 'i-lucide-plug-zap', group: 'system' },
  { value: 'log', label: 'Журнал и расход', icon: 'i-lucide-scroll-text', group: 'system' },
]

export const SETUP_STEPS = SECTIONS.filter(s => s.step)

export const sectionPath = (tenantId: string, value: string) => value ? `/t/${tenantId}/${value}` : `/t/${tenantId}`

export const TIMEZONES = [
  { value: 'Europe/Kaliningrad', label: 'Калининград, UTC+2' },
  { value: 'Europe/Moscow', label: 'Москва, UTC+3' },
  { value: 'Europe/Samara', label: 'Самара, UTC+4' },
  { value: 'Asia/Yekaterinburg', label: 'Екатеринбург, Уфа, UTC+5' },
  { value: 'Asia/Omsk', label: 'Омск, UTC+6' },
  { value: 'Asia/Novosibirsk', label: 'Новосибирск, UTC+7' },
  { value: 'Asia/Krasnoyarsk', label: 'Красноярск, UTC+7' },
  { value: 'Asia/Irkutsk', label: 'Иркутск, UTC+8' },
  { value: 'Asia/Yakutsk', label: 'Якутск, UTC+9' },
  { value: 'Asia/Vladivostok', label: 'Владивосток, UTC+10' },
  { value: 'Asia/Magadan', label: 'Магадан, UTC+11' },
  { value: 'Asia/Kamchatka', label: 'Камчатка, UTC+12' },
]
export const tzLabel = (tz?: string | null) => TIMEZONES.find(t => t.value === tz)?.label ?? tz ?? ''

export const tenantColor = (t: any) => t?.settings?.brand?.primary || '#196C7F'

export const TENANT_STATUS: Record<string, { label: string, color: any }> = {
  active: { label: 'Работает', color: 'success' },
  disabled: { label: 'Отключена', color: 'neutral' },
  setup: { label: 'Настройка', color: 'warning' },
}
export const tenantStatus = (t: any) => TENANT_STATUS[t?.status] ?? TENANT_STATUS.setup!

export function useTenants() {
  const tenants = useState<any[] | null>('tenants', () => null)
  const { api } = useApi()
  async function loadTenants() {
    try { tenants.value = await api('/tenants', { silent: true }) }
    catch { tenants.value ??= [] }
  }
  return { tenants, loadTenants }
}

export function useCurrentTenant() {
  const tenant = useState<any | null>('tenant', () => null)
  const setupDone = computed(() => SETUP_STEPS.filter(s => tenant.value?.setup?.[s.step!]).length)
  return { tenant, setupDone, setupTotal: SETUP_STEPS.length }
}
