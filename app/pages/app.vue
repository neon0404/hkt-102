<script setup lang="ts">
import { CARD_TEMPLATES, cardFields, PHOTO_SOURCE_LABELS, type CardTemplateId } from '~~/core/image/card-templates'

definePageMeta({ layout: 'blank' })
useHead({ title: 'AI-маркетолог', script: [{ src: 'https://telegram.org/js/telegram-web-app.js' }] })

type Tab = 'home' | 'materials' | 'task' | 'plan' | 'results'
const toast = useToast()
const colorMode = useColorMode()
const initData = ref('')
const me = ref<any | null>(null)
const error = ref('')
const tab = ref<Tab>('home')
const posts = ref<any[] | null>(null)
const plan = ref<any[] | null>(null)
const summary = ref<any | null>(null)
const messages = ref<any[] | null>(null)
const detail = ref<any | null>(null)
const opening = ref(false)
const busy = ref('')
const hasTgBack = ref(false)
const scroller = ref<HTMLElement | null>(null)

const tg = () => (window as any).Telegram?.WebApp
const haptic = (kind: 'success' | 'warning' | 'error' = 'success') => tg()?.HapticFeedback?.notificationOccurred(kind)

async function call<T = any>(path: string, opts: { method?: string, body?: any } = {}): Promise<T> {
  try {
    return await $fetch<T>(`/api/v1/miniapp${path}`, { method: (opts.method ?? 'GET') as any, body: opts.body, headers: { 'x-telegram-init-data': initData.value } })
  }
  catch (e: any) {
    throw new Error(e?.data?.error?.message ?? 'Сервис недоступен')
  }
}
const img = (url: string | null, v?: string | number) => url ? `${url}?tg=${encodeURIComponent(initData.value)}${v ? `&v=${v}` : ''}` : ''
const tz = computed(() => me.value?.tenant.timezone ?? 'Europe/Moscow')
const fmt = (v: string | null) => v ? new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz.value }).format(new Date(v)).replace(/^./, c => c.toUpperCase()) : 'После одобрения'
const ymd = (d: Date | string) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz.value }).format(new Date(d))
const today = computed(() => ymd(new Date()))

const NAV = [
  { value: 'home', icon: 'i-lucide-house', label: 'Главная' },
  { value: 'materials', icon: 'i-lucide-newspaper', label: 'Материалы' },
  { value: 'task', icon: 'i-lucide-plus', label: 'Задача', center: true },
  { value: 'plan', icon: 'i-lucide-calendar-days', label: 'План' },
  { value: 'results', icon: 'i-lucide-chart-spline', label: 'Итоги' },
] as const
const head = computed<[string, string]>(() => {
  const now = new Date()
  const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: tz.value }).format(now)
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: tz.value }).format(now)
  return ({ home: ['Сегодня,', day], materials: ['Материалы', ''], task: ['Задача', 'боту'], plan: ['План,', month], results: ['Итоги,', `${period.value} дней`] } as Record<Tab, [string, string]>)[tab.value]
})
const pending = computed(() => posts.value?.filter(p => p.approval_id).length ?? 0)

const tabBack = ref<Tab | null>(null)
function goTab(t: Tab) { if (t !== tab.value) { tabBack.value = tab.value; tab.value = t } }
function navTo(t: Tab) { tabBack.value = null; tab.value = t }
function backTab() { if (tabBack.value) { tab.value = tabBack.value; tabBack.value = null } }

function openChannel(url: string) {
  const w = tg()
  if (w?.openTelegramLink && /^https:\/\/t\.me\//.test(url)) w.openTelegramLink(url)
  else if (w?.openLink) w.openLink(url)
  else window.open(url, '_blank')
}

async function load() {
  try {
    me.value = await call('/me')
    await Promise.all([loadPosts(), loadPlan()])
  }
  catch (e: any) { error.value = e.message }
}
const loadPosts = async () => { posts.value = await call<any[]>('/posts') }
const loadPlan = async () => { plan.value = await call<any[]>('/plan') }
async function loadTab() {
  try {
    if (tab.value === 'results') summary.value = await call(`/summary?days=${period.value}`)
    else if (tab.value === 'task') { messages.value = await call<any[]>('/messages'); scrollChat() }
    else if (tab.value === 'plan') await loadPlan()
    else await loadPosts()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
}
watch(tab, () => { idea.value = null; fact.value = null; scroller.value?.scrollTo({ top: 0 }); loadTab() })

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (!me.value || document.hidden) return
    if (tab.value === 'task' && waitingReply.value) call<any[]>('/messages').then((m) => { if (m.length !== messages.value?.length) { messages.value = m; scrollChat() } }).catch(() => {})
    if (!detail.value && (tab.value === 'home' || tab.value === 'materials') && posts.value?.some(p => p.status === 'draft' || p.status === 'publishing')) loadPosts().catch(() => {})
    if (detail.value && (detail.value.status === 'draft' || detail.value.revising)) refreshDetail().catch(() => {})
  }, 4000)
})
const tick = setInterval(() => { if (waitingReply.value) nowTick.value = Date.now() }, 1000)
onUnmounted(() => { clearInterval(timer); clearInterval(tick) })

const attention = computed(() => posts.value?.filter(p => p.status === 'failed') ?? [])
const queue = computed(() => posts.value?.filter(p => p.status === 'in_review' || p.status === 'draft') ?? [])
const soon = computed(() => posts.value?.filter(p => ['approved', 'scheduled', 'publishing'].includes(p.status)) ?? [])
const recent = computed(() => posts.value?.filter(p => p.status === 'published').slice(0, 2) ?? [])

function weekDays(start: Date) {
  const W = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
  return W.map((w, k) => {
    const d = new Date(start.getTime() + k * 86400_000)
    const key = ymd(d)
    const dots: string[] = []
    for (const p of posts.value ?? []) {
      if (p.status === 'published' && p.published_at && ymd(p.published_at) === key) dots.push('published')
      else if (['approved', 'scheduled', 'in_review'].includes(p.status) && p.scheduled_at && ymd(p.scheduled_at) === key) dots.push('planned')
    }
    for (const i of plan.value ?? []) {
      if (i.date !== key || i.status === 'skipped' || (i.postId && (posts.value ?? []).some(p => p.id === i.postId))) continue
      dots.push(i.status === 'idea' ? 'idea' : 'planned')
    }
    return { key, w, n: Number(key.slice(8)), dots, today: key === today.value }
  })
}
const monday = (offsetWeeks = 0) => {
  const now = new Date(`${today.value}T12:00:00Z`)
  const dow = (now.getUTCDay() + 6) % 7
  return new Date(now.getTime() - dow * 86400_000 + offsetWeeks * 7 * 86400_000)
}
const thisWeek = computed(() => weekDays(monday()))

const filter = ref('all')
const FILTERS = [
  { label: 'Все', value: 'all' }, { label: 'Готовятся', value: 'draft' }, { label: 'На решении', value: 'in_review' },
  { label: 'Одобрены', value: 'approved' }, { label: 'Вышли', value: 'published' }, { label: 'Ошибки', value: 'failed' }, { label: 'Отклонены', value: 'rejected' },
]
const inFilter = (v: string, p: any) => v === 'all' || p.status === v || (v === 'approved' && ['scheduled', 'publishing'].includes(p.status))
const count = (v: string) => posts.value?.filter(p => inFilter(v, p)).length ?? 0
const groups = computed(() => {
  const list = posts.value?.filter(p => inFilter(filter.value, p)) ?? []
  return [
    { title: 'Посты', icon: 'i-lucide-newspaper', posts: list.filter(p => p.kind === 'post') },
    { title: 'Сценарии видео', icon: 'i-lucide-clapperboard', posts: list.filter(p => p.kind === 'video_script') },
  ].filter(g => g.posts.length)
})

const draft = ref('')
const chatEnd = ref<HTMLElement | null>(null)
const QUICK = [
  { label: 'Пост о новинке', text: 'Подготовь пост о новинке компании' },
  { label: 'План на неделю', text: 'Составь контент-план на неделю' },
  { label: 'Короткое видео', text: 'Сделай короткий ролик о производстве стекла' },
  { label: 'Отчёт', text: 'Покажи отчёт за неделю' },
  { label: 'Статус', text: 'Что с последними материалами?' },
]
const nowTick = ref(Date.now())
const waitingSince = computed(() => {
  const last = messages.value?.at(-1)
  if (!last || last.direction !== 'in') return null
  const t = new Date(last.created_at).getTime()
  return nowTick.value - t < 5 * 60_000 ? t : null
})
const waitingReply = computed(() => waitingSince.value !== null)
const waitingPhase = computed(() => {
  const s = waitingSince.value === null ? 0 : (nowTick.value - waitingSince.value) / 1000
  return s < 6 ? 'Читаю задачу' : s < 20 ? 'Подбираю факты из материалов' : s < 45 ? 'Пишу текст' : s < 90 ? 'Готовлю картинку' : 'Почти готово'
})
async function askBot(text: string) {
  goTab('task')
  if (messages.value === null) messages.value = await call<any[]>('/messages').catch(() => [])
  await sendTask(text)
}
function scrollChat() { nextTick(() => chatEnd.value?.scrollIntoView({ behavior: 'smooth', block: 'end' })) }
async function sendTask(text?: string) {
  const t = (text ?? draft.value).trim()
  if (t.length < 2) return
  draft.value = ''
  try {
    const m = await call('/messages', { method: 'POST', body: { text: t } })
    messages.value = [...(messages.value ?? []), m]
    scrollChat()
    haptic()
  }
  catch (e: any) { draft.value = t; toast.add({ title: e.message, color: 'error' }) }
}

const recording = ref(false)
const recSeconds = ref(0)
const voiceBusy = ref(false)
let recorder: MediaRecorder | null = null
let recTimer: ReturnType<typeof setInterval> | null = null
const canRecord = computed(() => import.meta.client && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia)
async function toggleVoice() {
  if (recording.value) { recorder?.stop(); return }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) ?? ''
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const parts: Blob[] = []
    rec.ondataavailable = e => e.data.size && parts.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop())
      if (recTimer) clearInterval(recTimer)
      recording.value = false
      if (recSeconds.value < 1) return
      voiceBusy.value = true
      try {
        const fd = new FormData()
        fd.append('file', new Blob(parts, { type: rec.mimeType || 'audio/webm' }), 'voice')
        await call('/voice', { method: 'POST', body: fd })
        haptic()
        toast.add({ title: 'Расшифровываю голосовое', icon: 'i-lucide-audio-lines' })
        for (const ms of [5000, 9000, 15000]) setTimeout(() => call<any[]>('/messages').then((m) => { if (m.length !== messages.value?.length) { messages.value = m; scrollChat() } }).catch(() => {}), ms)
      }
      catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
      finally { voiceBusy.value = false }
    }
    recorder = rec
    recSeconds.value = 0
    rec.start()
    recording.value = true
    recTimer = setInterval(() => { if (++recSeconds.value >= 110) rec.stop() }, 1000)
    haptic()
  }
  catch { toast.add({ title: 'Нет доступа к микрофону', color: 'error' }) }
}

const weekOffset = ref(0)
const planWeek = computed(() => weekDays(monday(weekOffset.value)))
const selectedDay = ref('')
const weekLabel = computed(() => {
  const days = planWeek.value
  const f = (k: string, withMonth: boolean) => new Intl.DateTimeFormat('ru-RU', withMonth ? { day: 'numeric', month: 'long' } : { day: 'numeric' }).format(new Date(`${k}T12:00:00Z`))
  const sameMonth = days[0]!.key.slice(5, 7) === days[6]!.key.slice(5, 7)
  return `${f(days[0]!.key, !sameMonth)} – ${f(days[6]!.key, true)}`
})
const planDays = computed(() => planWeek.value.map(d => ({
  ...d,
  title: new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${d.key}T12:00:00Z`)).replace(/^./, c => c.toUpperCase()),
  items: (plan.value ?? []).filter(i => i.date === d.key).sort((a, b) => a.time.localeCompare(b.time)),
})).filter(d => d.items.length))
const ideas = computed(() => (plan.value ?? []).filter(i => i.status === 'idea' && i.date >= today.value))
const PLAN_LINE: Record<string, { t: string, c: string, about: string }> = {
  idea: { t: 'Идея', c: 'text-warning', about: 'AI предложил тему. Примите её — и пост будет готов за сутки до даты, или подготовьте его прямо сейчас.' },
  accepted: { t: 'Принята', c: 'text-primary', about: 'Тема принята. Пост подготовлю за сутки до публикации и пришлю на согласование.' },
  drafted: { t: 'Пост готов', c: 'text-success', about: 'Пост по этой теме готов — откройте его, чтобы проверить и одобрить.' },
  skipped: { t: 'Пропущена', c: 'text-muted', about: 'Тема пропущена. Её можно вернуть.' },
}
const dayTitle = (key: string) => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${key}T12:00:00Z`)).replace(/^./, c => c.toUpperCase())
const dayShort = (key: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(`${key}T12:00:00Z`))
const emptyDay = computed(() => {
  const k = selectedDay.value
  if (!k || !planWeek.value.some(d => d.key === k) || planDays.value.some(d => d.key === k)) return null
  return { key: k, title: dayTitle(k), past: k < today.value, published: (posts.value ?? []).filter(p => p.status === 'published' && p.published_at && ymd(p.published_at) === k) }
})
function pickDay(key: string) {
  selectedDay.value = key
  nextTick(() => document.getElementById(planDays.value.some(d => d.key === key) ? `day-${key}` : 'day-empty')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
function toToday() { weekOffset.value = 0; selectedDay.value = today.value }
watch(weekOffset, () => { selectedDay.value = '' })
function openDay(key: string) { goTab('plan'); weekOffset.value = 0; nextTick(() => pickDay(key)) }

const idea = ref<any | null>(null)
const ideaOpen = computed({ get: () => !!idea.value, set: (v) => { if (!v) idea.value = null } })
async function draftNow(i: any) {
  busy.value = `plan:${i.id}`
  try {
    const row = await call(`/plan/${i.id}/draft`, { method: 'POST' })
    plan.value = plan.value?.map(x => x.id === i.id ? { ...x, ...row } : x) ?? null
    idea.value = null
    toast.add({ title: 'Готовлю пост', description: 'Пришлю на согласование через 1–2 минуты', icon: 'i-lucide-sparkles', color: 'primary' })
    haptic()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}
async function setPlan(id: string, status: 'accepted' | 'skipped') {
  try {
    const row = await call(`/plan/${id}`, { method: 'PATCH', body: { status } })
    plan.value = plan.value?.map(i => i.id === id ? { ...i, ...row } : i) ?? null
    if (idea.value?.id === id) idea.value = { ...idea.value, ...row }
    haptic()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
}
async function acceptIdeas() {
  for (const i of ideas.value) await setPlan(i.id, 'accepted')
  toast.add({ title: 'Идеи приняты', description: 'Черновики появятся в назначенные дни', icon: 'i-lucide-circle-check', color: 'success' })
}

const mins = (s: number) => !s ? '—' : s < 3600 ? `${Math.max(1, Math.round(s / 60))} мин` : `${Math.round(s / 360) / 10} ч`
const perf = computed(() => summary.value?.performance ?? null)
const bests = computed(() => {
  if (!perf.value) return []
  const pick = (items: any[], label: string, icon: string) => {
    const list = items.filter(i => i.avgViews !== null)
    return list.length > 1 ? { label, icon, value: list[0].label, views: list[0].avgViews } : null
  }
  return [
    pick(perf.value.byTemplate, 'лучший макет', 'i-lucide-layout-template'),
    pick(perf.value.byRubric, 'лучшая рубрика', 'i-lucide-tag'),
    pick(perf.value.byDaypart, 'лучшее время', 'i-lucide-clock'),
  ].filter(Boolean) as Array<{ label: string, icon: string, value: string, views: number }>
})
const period = ref<7 | 30>(7)
async function setPeriod(p: 7 | 30) {
  if (p === period.value) return
  period.value = p
  summary.value = null
  haptic()
  await loadTab()
}
const dash = computed(() => summary.value?.dash ?? null)
const nf = (n: number) => new Intl.NumberFormat('ru-RU').format(n)
const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10
  return `${nf(n)} ${a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many}`
}
const secs = (ms: number) => ms < 1000 ? 'меньше секунды' : ms < 60_000 ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / 6000) / 10} мин`
const TREND = {
  views: { label: 'Просмотры', unit: (n: number) => plural(n, 'просмотр', 'просмотра', 'просмотров') },
  clicks: { label: 'Переходы', unit: (n: number) => plural(n, 'переход', 'перехода', 'переходов') },
  published: { label: 'Посты', unit: (n: number) => plural(n, 'пост', 'поста', 'постов') },
  reactions: { label: 'Реакции', unit: (n: number) => plural(n, 'реакция', 'реакции', 'реакций') },
} as const
const trend = ref<keyof typeof TREND>('views')
const trendItems = computed(() => (dash.value?.daily ?? []).map((d: any) => ({ date: d.date, value: d[trend.value] as number })))
const trendTotal = computed(() => trendItems.value.reduce((a: number, b: any) => a + b.value, 0))
const funnel = computed(() => {
  const f = dash.value?.funnel
  if (!f) return []
  const pct = (n: number) => f.created ? `${Math.round(n / f.created * 100)}%` : null
  return [
    { label: 'Подготовлено', value: f.created, hint: null },
    { label: 'Ушло на согласование', value: f.sent, hint: pct(f.sent) },
    { label: 'Одобрено', value: f.approved, hint: pct(f.approved) },
    { label: 'Опубликовано', value: f.published, hint: pct(f.published) },
  ]
})
const FORMATS = { byTemplate: 'Макеты', byRubric: 'Рубрики', byDaypart: 'Время' } as const
const format = ref<keyof typeof FORMATS>('byTemplate')
const formatItems = computed(() => (perf.value?.[format.value] ?? []).filter((s: any) => s.avgViews !== null)
  .map((s: any) => ({ label: s.label, value: s.avgViews, hint: plural(s.posts, 'пост', 'поста', 'постов') })))
const topPosts = computed(() => [...(perf.value?.posts ?? [])].filter((p: any) => p.views !== null).sort((a: any, b: any) => b.views - a.views).slice(0, 5))
const topMax = computed(() => Math.max(1, ...topPosts.value.map((p: any) => p.views)))
const stack = (src: Record<string, number> | undefined, spec: Array<[string, string, string]>) =>
  spec.map(([k, label, color]) => ({ label, value: src?.[k] ?? 0, color }))
const planStack = computed(() => stack(dash.value?.plan, [['idea', 'Идеи', 'bg-petrol-200'], ['accepted', 'Приняты', 'bg-petrol-500'], ['drafted', 'Пост готов', 'bg-emerald-500'], ['skipped', 'Пропущены', 'bg-glass-400']]))
const originStack = computed(() => stack(dash.value?.origin, [['user_request', 'По просьбе', 'bg-petrol-500'], ['plan', 'Из плана', 'bg-sky-400'], ['schedule', 'По расписанию', 'bg-amber-400'], ['operator', 'Вручную', 'bg-glass-400']]))
const sentimentStack = computed(() => stack(dash.value?.sentiment, [['positive', 'Хвалят', 'bg-emerald-500'], ['question', 'Вопросы', 'bg-sky-400'], ['neutral', 'Нейтрально', 'bg-glass-300'], ['negative', 'Недовольны', 'bg-rose-500'], ['spam', 'Спам', 'bg-glass-500']]))
const sumOf = (xs: Array<{ value: number }>) => xs.reduce((a, b) => a + b.value, 0)
const pctText = (n: number | null) => n === null ? '—' : `${String(n).replace('.', ',')}%`
const timesUnit = (n: number) => plural(n, 'раз', 'раза', 'раз')
const avgUnit = (n: number) => `${nf(n)} в среднем`
const approverStack = (a: any) => [
  { label: 'Одобрил', value: a.approved, color: 'bg-emerald-500' },
  { label: 'На доработку', value: a.changes, color: 'bg-petrol-400' },
  { label: 'Отклонил', value: a.rejected, color: 'bg-rose-500' },
]
const aiItems = computed(() => (dash.value?.ai ?? []).slice(0, 6).map((a: any) => ({ label: a.label, value: a.calls, hint: `по ${secs(a.ms)}` })))
const kpis = computed(() => summary.value
  ? [
      { label: 'Подготовлено', value: summary.value.created, icon: 'i-lucide-sparkles', tone: 'brand', spark: dash.value?.daily.map((d: any) => d.created) },
      { label: 'Опубликовано', value: summary.value.published, icon: 'i-lucide-send', tone: 'emerald', spark: dash.value?.daily.map((d: any) => d.published) },
      { label: 'Ждут решения', value: summary.value.waiting, icon: 'i-lucide-hourglass', tone: 'amber' },
      { label: 'Отклонено', value: summary.value.rejected, icon: 'i-lucide-ban', tone: 'rose' },
      { label: 'Подписчики', value: summary.value.subscribers ?? '—', delta: summary.value.subscribersDelta, icon: 'i-lucide-users-round', tone: 'sky', spark: dash.value?.subscribers.map((d: any) => d.value) },
      { label: 'Время согласования', value: mins(summary.value.approvals.avgApproveSec), icon: 'i-lucide-timer', tone: 'indigo' },
    ]
  : [])

const shownVersion = ref<string>('')
const stamp = ref(Date.now())
const version = computed(() => detail.value?.versions?.find((v: any) => v.id === shownVersion.value) ?? detail.value?.current_version ?? null)
const isCurrent = computed(() => version.value?.id === detail.value?.current_version?.id)
const editable = computed(() => detail.value?.kind === 'post' && ['draft', 'in_review', 'approved', 'scheduled'].includes(detail.value?.status) && isCurrent.value)
const versionTabs = computed(() => (detail.value?.versions ?? []).map((v: any) => ({ label: `v${v.n}`, value: v.id })))
const approvalsNow = computed(() => (detail.value?.approvals ?? []).filter((a: any) => a.version_id === detail.value?.current_version?.id))
const DECISION: Record<string, { t: string, c: string, tone: string }> = {
  pending: { t: 'Ждёт решения', c: 'text-warning', tone: 'slate' }, approved: { t: 'Одобрил', c: 'text-success', tone: 'emerald' },
  rejected: { t: 'Отклонил', c: 'text-error', tone: 'rose' }, changes_requested: { t: 'Попросил правки', c: 'text-primary', tone: 'sky' },
  superseded: { t: 'Решение уже принято', c: 'text-muted', tone: 'slate' },
}
const initials = (n: string | null) => (n ?? '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase()
const warnings = computed(() => (version.value?.warnings ?? []).map((w: string) => {
  const [h, ...rest] = w.split(': ')
  return rest.length ? { title: rest.join(': '), subtitle: h } : { title: w, subtitle: 'Замечание' }
}))

async function open(id: string) {
  opening.value = true
  try {
    detail.value = await call(`/posts/${id}`)
    shownVersion.value = detail.value.current_version?.id ?? ''
    stamp.value = Date.now()
    scroller.value?.scrollTo({ top: 0 })
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { opening.value = false }
}
async function refreshDetail() {
  if (!detail.value) return
  const d = await call(`/posts/${detail.value.id}`)
  const changed = d.current_version?.id !== detail.value.current_version?.id
  detail.value = d
  if (changed) { shownVersion.value = d.current_version?.id ?? ''; stamp.value = Date.now() }
}
function back() {
  detail.value = null
  reviseOpen.value = false
  editOpen.value = false
  rejectOpen.value = false
  timeOpen.value = false
  fact.value = null
  loadPosts().catch(() => {})
}

const rejectOpen = ref(false)
const rejectReason = ref('')
const REJECT_CHIPS = ['Не по теме', 'Неточные факты', 'Не тот тон', 'Не сейчас']

async function decide(action: 'a' | 'r') {
  busy.value = action
  try {
    await call(`/approvals/${detail.value.approval_id}`, { method: 'POST', body: { action, comment: action === 'r' ? rejectReason.value.trim() : undefined } })
    rejectOpen.value = false
    rejectReason.value = ''
    toast.add(action === 'a'
      ? { title: 'Одобрено', description: detail.value.scheduled_at ? `Выйдет ${fmt(detail.value.scheduled_at)}` : 'Публикую', color: 'success', icon: 'i-lucide-circle-check' }
      : { title: 'Отклонено', color: 'neutral', icon: 'i-lucide-ban' })
    haptic(action === 'r' ? 'warning' : 'success')
    back()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}

const isApprover = computed(() => !!me.value?.roles?.includes('approver'))
const canSendNow = computed(() => isApprover.value && detail.value?.kind === 'post' && isCurrent.value
  && (['approved', 'scheduled'].includes(detail.value?.status) || (detail.value?.status === 'in_review' && !!detail.value?.approval_id)))
const timeOpen = ref(false)
const timeValue = ref('')
const toLocalInput = (v: string | null) => {
  if (!v) return ''
  const d = new Date(v)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function openTime() {
  timeValue.value = toLocalInput(detail.value?.scheduled_at ?? null)
  timeOpen.value = true
}
function quickTime(days: number, hour: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(hour, 0, 0, 0)
  timeValue.value = toLocalInput(d.toISOString())
}
async function saveTime(clear = false) {
  busy.value = 'time'
  try {
    const res = await call(`/posts/${detail.value.id}/schedule`, { method: 'POST', body: { scheduled_at: clear || !timeValue.value ? null : new Date(timeValue.value).toISOString() } })
    timeOpen.value = false
    toast.add(res.needs_approval
      ? { title: 'Время изменено', description: 'Пост снова ушёл на согласование', color: 'primary', icon: 'i-lucide-clock' }
      : { title: 'Время изменено', color: 'success', icon: 'i-lucide-clock' })
    haptic()
    await refreshDetail()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}
const canResend = computed(() => editable.value && ['draft', 'in_review'].includes(detail.value?.status) && !detail.value?.revising)
async function resend() {
  busy.value = 'resend'
  try {
    await call(`/posts/${detail.value.id}/send-for-approval`, { method: 'POST' })
    toast.add({ title: 'Отправлено согласующим', description: 'Карточка с текущим видом поста', color: 'success', icon: 'i-lucide-send' })
    haptic('success')
    await refreshDetail()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}
async function sendNow() {
  busy.value = 'now'
  try {
    const res = await call(`/posts/${detail.value.id}/publish-now`, { method: 'POST' })
    toast.add(res.partial
      ? { title: 'Одобрено', description: 'Пост выйдет, когда одобрят остальные согласующие', color: 'primary', icon: 'i-lucide-users' }
      : { title: 'Публикую', description: 'Ссылка придёт в чат с ботом', color: 'success', icon: 'i-lucide-send' })
    haptic('success')
    setTimeout(() => refreshDetail().catch(() => {}), 5000)
    await refreshDetail()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}

const reviseOpen = ref(false)
const comment = ref('')
const CHIPS = ['Сделай короче', 'Добавь призыв к действию', 'Проще, без терминов', 'Другой заголовок']
async function sendRevision() {
  busy.value = 'c'
  try {
    await call(`/approvals/${detail.value.approval_id}`, { method: 'POST', body: { action: 'c', comment: comment.value.trim() } })
    toast.add({ title: 'Отправлено на доработку', description: 'Новая версия придёт на согласование', color: 'primary', icon: 'i-lucide-wand-sparkles' })
    haptic()
    comment.value = ''
    reviseOpen.value = false
    await refreshDetail()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}

const card = computed(() => detail.value?.current_version?.card ?? null)
const templateOpen = ref(false)
const fieldsOpen = ref(false)
const cardForm = reactive<Record<string, string>>({})
const cardFieldList = computed(() => cardFields((card.value?.template ?? 'project') as CardTemplateId))
const templates = Object.values(CARD_TEMPLATES)
const photoInput = ref<HTMLInputElement | null>(null)
watch(fieldsOpen, (o) => {
  if (!o) return
  for (const k of Object.keys(cardForm)) delete cardForm[k]
  for (const f of cardFieldList.value) cardForm[f.key] = card.value?.fields?.[f.key] ?? ''
})
async function changeCard(body: any, what: string) {
  busy.value = what
  try {
    const res = await call(`/posts/${detail.value.id}/card`, { method: 'POST', body })
    await refreshDetail()
    stamp.value = Date.now()
    templateOpen.value = false
    fieldsOpen.value = false
    haptic()
    if (res.new_version) toast.add({ title: 'Создана новая версия', description: 'Её нужно одобрить заново', color: 'primary' })
    else if (res.overflow?.length) toast.add({ title: 'Часть текста не поместилась', description: 'Сократите текст на карточке', color: 'warning' })
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}
async function uploadPhoto(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  await changeCard(fd, 'upload')
  input.value = ''
}

const isRich = computed(() => version.value?.format === 'rich')
const slides = computed<Array<{ id: string, url: string, cover: boolean }>>(() => {
  const v = version.value
  if (!v || v.video || !v.image_url) return []
  return [{ id: 'cover', url: img(v.image_url, stamp.value), cover: true }, ...(v.gallery?.photos ?? []).map((p: any) => ({ id: p.id, url: img(p.url), cover: false }))]
})
const slide = ref(0)
const slider = ref<HTMLElement | null>(null)
watch(() => version.value?.id, () => { slide.value = 0; slider.value?.scrollTo({ left: 0 }) })
function onSlide() {
  const el = slider.value
  if (el) slide.value = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
}
function goSlide(i: number) { slider.value?.scrollTo({ left: i * (slider.value?.clientWidth ?? 0), behavior: 'smooth' }) }
const galleryInput = ref<HTMLInputElement | null>(null)
async function changeLayout(body: any, what: string) {
  busy.value = what
  try {
    const res = await call(`/posts/${detail.value.id}/layout`, { method: 'POST', body })
    await refreshDetail()
    haptic()
    if (res.new_version) toast.add({ title: 'Создана новая версия', description: 'Её нужно одобрить заново', color: 'primary' })
    if (body?.gallery === 'add' || body?.gallery === 'generate' || body instanceof FormData) nextTick(() => goSlide(slides.value.length - 1))
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}
function generateGallery() {
  toast.add({ title: 'Генерирую фото', description: 'Около минуты', color: 'primary', icon: 'i-lucide-sparkles' })
  return changeLayout({ gallery: 'generate' }, 'gal-gen')
}
async function uploadGallery(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  await changeLayout(fd, 'gal-up')
  input.value = ''
}

const editOpen = ref(false)
const editTa = ref<any>(null)
const MD_TOOLS = [
  { label: 'Подзаголовок', icon: 'i-lucide-heading', before: '\n### ', after: '', sample: 'Подзаголовок' },
  { label: 'Жирный', icon: 'i-lucide-bold', before: '**', after: '**', sample: 'главное' },
  { label: 'Список', icon: 'i-lucide-list', before: '\n- ', after: '', sample: 'пункт' },
  { label: 'Цитата', icon: 'i-lucide-quote', before: '\n> ', after: '', sample: 'цитата' },
  { label: 'Таблица', icon: 'i-lucide-table', before: '\n| Параметр | Значение |\n| :--- | ---: |\n| ', after: ' | |', sample: 'Толщина' },
]
function insertMd(t: typeof MD_TOOLS[number]) {
  const el: HTMLTextAreaElement | undefined = editTa.value?.textareaRef ?? editTa.value?.$el?.querySelector?.('textarea')
  const text = editForm.text
  const start = el?.selectionStart ?? text.length
  const end = el?.selectionEnd ?? text.length
  const picked = text.slice(start, end) || t.sample
  editForm.text = `${text.slice(0, start)}${t.before}${picked}${t.after}${text.slice(end)}`
  nextTick(() => {
    if (!el) return
    const from = start + t.before.length
    el.focus()
    el.setSelectionRange(from, from + picked.length)
  })
}
const editForm = reactive({ title: '', text: '' })
watch(editOpen, (o) => { if (o) { editForm.title = version.value?.title ?? ''; editForm.text = version.value?.text ?? '' } })
async function saveEdit() {
  busy.value = 'edit'
  try {
    await call(`/posts/${detail.value.id}`, { method: 'PATCH', body: { title: editForm.title, text: editForm.text } })
    editOpen.value = false
    await refreshDetail()
    stamp.value = Date.now()
    toast.add({ title: 'Текст обновлён', description: 'Новая версия ушла на согласование', icon: 'i-lucide-pencil', color: 'primary' })
    haptic()
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}

const newOpen = ref(false)
const newForm = reactive({ title: '', text: '' })
const newFile = ref<File | null>(null)
const newFileInput = ref<HTMLInputElement | null>(null)
async function createOwn() {
  busy.value = 'new'
  try {
    const { id } = await call('/posts', { method: 'POST', body: { title: newForm.title, text: newForm.text } })
    if (newFile.value) {
      const fd = new FormData()
      fd.append('mode', 'custom')
      fd.append('file', newFile.value)
      await call(`/posts/${id}/card`, { method: 'POST', body: fd }).catch(() => {})
    }
    newOpen.value = false
    newForm.title = ''; newForm.text = ''; newFile.value = null
    toast.add({ title: 'Пост создан', description: 'Ушёл на согласование', icon: 'i-lucide-circle-check', color: 'success' })
    haptic()
    await open(id)
  }
  catch (e: any) { toast.add({ title: e.message, color: 'error' }) }
  finally { busy.value = '' }
}

const customInput = ref<HTMLInputElement | null>(null)
async function uploadCustom(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('mode', 'custom')
  fd.append('file', file)
  await changeCard(fd, 'custom')
  input.value = ''
}

const fact = ref<any | null>(null)
const factOpen = computed({ get: () => !!fact.value, set: (v) => { if (!v) fact.value = null } })
async function openFact(f: any) {
  if (!f.chunk_id) return
  fact.value = { claim: f.claim, title: f.source_title, loading: true }
  try { fact.value = { claim: f.claim, ...(await call(`/facts/${f.chunk_id}`)), loading: false } }
  catch (e: any) { fact.value = null; toast.add({ title: e.message, color: 'error' }) }
}

async function copyLink(url: string) {
  try { await navigator.clipboard.writeText(url) } catch {}
  toast.add({ title: 'Ссылка скопирована', icon: 'i-lucide-copy', color: 'neutral' })
}

const switcherOpen = ref(false)
async function switchTenant(id: string) {
  switcherOpen.value = false
  if (id === me.value?.tenant.id) return
  await call('/tenant', { method: 'POST', body: { tenant_id: id } })
  detail.value = null
  posts.value = plan.value = summary.value = messages.value = null
  await load()
  const t = me.value?.tenants.find((x: any) => x.id === id)
  toast.add({ title: `Компания: ${t?.name}`, description: 'Данные других компаний недоступны', icon: 'i-lucide-shield-check', color: 'neutral' })
}

const tgBack = () => { if (detail.value) back(); else backTab() }
watch([detail, tabBack], ([d, t]) => {
  const b = tg()?.BackButton
  if (!b) return
  b.offClick?.(tgBack)
  if (d || t) { b.show(); b.onClick(tgBack) }
  else b.hide()
})

function launchInitData(w: any): string {
  const signed = (v: string | null | undefined) => !!v && /(^|&)hash=/.test(v)
  if (signed(w?.initData)) return w.initData
  let raw = location.hash
  try { raw = sessionStorage.getItem('tg-launch-hash') || raw } catch {}
  const fromHash = new URLSearchParams(raw.replace(/^#/, '')).get('tgWebAppData')
  return signed(fromHash) ? fromHash! : ''
}

onMounted(() => {
  colorMode.preference = 'light'
  const start = () => {
    const w = tg()
    hasTgBack.value = !!w?.BackButton && !!w?.platform && w.platform !== 'unknown'
    initData.value = launchInitData(w)
    w?.ready?.()
    w?.expand?.()
    w?.setHeaderColor?.('#eef3f4')
    w?.setBackgroundColor?.('#eef3f4')
    w?.setBottomBarColor?.('#ffffff')
    if (!initData.value) { error.value = 'Откройте приложение из Telegram: кнопка «Кабинет» в чате с ботом'; return }
    load()
  }
  let tries = 0
  const t = setInterval(() => {
    if (tg() || ++tries > 30) { clearInterval(t); start() }
  }, 100)
})
</script>

<template>
  <div class="mini-app flex min-h-dvh justify-center sm:items-center sm:py-6">
    <div class="relative flex h-dvh w-full max-w-[430px] flex-col sm:transform-gpu overflow-hidden bg-default sm:h-[min(880px,calc(100dvh-3rem))] sm:rounded-[2.75rem] sm:shadow-2xl sm:shadow-slate-900/15 sm:ring-[10px] sm:ring-white">
      <UEmpty v-if="error" icon="i-lucide-lock" :title="error" class="flex-1 justify-center px-6">
        <template #header><img src="/brand/icon.png" alt="" class="mx-auto mb-4 h-14 w-auto"></template>
      </UEmpty>

      <div v-else-if="!me" class="space-y-3 p-4 pt-8">
        <USkeleton class="h-14 w-2/3 rounded-tile" /><USkeleton class="h-28 rounded-card" /><USkeleton class="h-48 rounded-card" /><USkeleton class="h-48 rounded-card" />
      </div>

      <template v-else>
        <header v-if="!detail" class="flex items-end justify-between gap-3 px-5 pb-4 pt-6">
          <UButton
            v-if="tabBack && !hasTgBack" icon="i-lucide-arrow-left" color="neutral" variant="outline" size="lg"
            class="mb-1 size-11 shrink-0 justify-center rounded-full bg-elevated ring-0 shadow-sm" aria-label="Назад" @click="backTab"
          />
          <div class="min-w-0 flex-1">
            <p class="mb-0.5 truncate text-caption font-semibold uppercase tracking-wider text-primary">AI-маркетолог · {{ me.tenant.name }}</p>
            <h1 class="truncate text-[1.625rem] font-bold leading-tight tracking-tight text-highlighted">
              {{ head[0] }} <span class="font-semibold text-muted">{{ head[1] }}</span>
            </h1>
          </div>
          <button
            type="button" aria-label="Сменить компанию"
            class="relative mb-1 grid size-12 shrink-0 place-items-center rounded-full bg-elevated shadow-sm transition active:scale-95"
            @click="switcherOpen = true"
          >
            <img src="/brand/icon.png" alt="" class="h-7 w-auto">
            <span class="absolute bottom-0 right-0 size-3 rounded-full bg-success ring-2 ring-default" />
          </button>
        </header>

        <main ref="scroller" class="no-scrollbar flex-1 overflow-y-auto px-3 pb-6" :class="detail && 'pt-4'">
          <div v-if="opening" class="absolute inset-0 z-40 grid place-items-center bg-default/60"><UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-primary" /></div>

          <section v-if="detail" class="space-y-3">
            <div class="flex items-center justify-between px-1">
              <UButton v-if="!hasTgBack" icon="i-lucide-arrow-left" color="neutral" variant="outline" size="lg" class="size-11 justify-center rounded-full bg-elevated ring-0 shadow-sm" aria-label="Назад" @click="back" />
              <span v-else />
              <MiniStatus :post="detail" />
            </div>

            <video
              v-if="version?.video?.url" :src="img(version.video.url)" :poster="version.image_url ? img(version.image_url) : undefined"
              controls playsinline preload="metadata" class="mx-auto aspect-9/16 max-h-[70vh] w-full rounded-card bg-black object-contain shadow-sm"
            />
            <div v-else-if="slides.length" class="relative">
              <div ref="slider" class="flex snap-x snap-mandatory overflow-x-auto rounded-card shadow-sm [scrollbar-width:none]" @scroll.passive="onSlide">
                <img v-for="s in slides" :key="s.id" :src="s.url" alt="" class="aspect-square w-full shrink-0 snap-center object-cover">
              </div>
              <div v-if="slides.length > 1" class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
                <span v-for="(s, i) in slides" :key="s.id" class="h-1.5 rounded-full transition-all" :class="i === slide ? 'w-5 bg-white' : 'w-1.5 bg-white/60'" />
              </div>
              <span v-if="slides.length > 1" class="absolute right-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-caption font-semibold text-white">{{ slide + 1 }} / {{ slides.length }}</span>
              <div v-if="busy.startsWith('card') || busy.startsWith('gal') || ['upload', 'photo', 'ai', 'custom'].includes(busy)" class="absolute inset-0 grid place-items-center rounded-card bg-default/50 backdrop-blur-[1px]">
                <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-primary" />
              </div>
            </div>

            <div v-if="editable && slides.length" class="space-y-3 rounded-card bg-elevated p-4">
              <div class="grid grid-cols-2 gap-1 rounded-full bg-muted p-1">
                <button
                  v-for="f in ([{ v: 'rich', l: 'Журнальный', i: 'i-lucide-newspaper' }, { v: 'classic', l: 'Обычный', i: 'i-lucide-image' }] as const)" :key="f.v" type="button"
                  class="flex h-9 items-center justify-center gap-1.5 rounded-full text-meta font-semibold transition"
                  :class="(version?.format ?? 'classic') === f.v ? 'bg-elevated text-highlighted shadow-sm' : 'text-muted'"
                  :disabled="!!busy" @click="(version?.format ?? 'classic') !== f.v && changeLayout({ format: f.v }, 'gal-format')"
                >
                  <UIcon :name="f.i" class="size-4" />{{ f.l }}
                </button>
              </div>
              <div class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
                <div v-for="(s, i) in slides" :key="s.id" class="relative shrink-0">
                  <button type="button" class="block size-16 overflow-hidden rounded-tile-sm ring-2 transition" :class="i === slide ? 'ring-primary' : 'ring-transparent'" @click="goSlide(i)">
                    <img :src="s.url" alt="" class="size-full object-cover">
                  </button>
                  <span v-if="s.cover" class="pointer-events-none absolute inset-x-1 bottom-1 rounded-full bg-black/55 text-center text-[10px] font-semibold text-white">обложка</span>
                  <button v-else type="button" class="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-elevated text-muted shadow ring-1 ring-default" aria-label="Убрать из карусели" :disabled="!!busy" @click="changeLayout({ remove: s.id }, 'gal-rm')">
                    <UIcon name="i-lucide-x" class="size-3.5" />
                  </button>
                </div>
                <button type="button" class="grid size-16 shrink-0 place-items-center rounded-tile-sm bg-muted text-primary" aria-label="Фото из фотобанка" :disabled="!!busy || slides.length >= 10" @click="changeLayout({ gallery: 'add' }, 'gal-add')">
                  <UIcon :name="busy === 'gal-add' ? 'i-lucide-loader-circle' : 'i-lucide-images'" class="size-6" :class="busy === 'gal-add' && 'animate-spin'" />
                </button>
                <button type="button" class="grid size-16 shrink-0 place-items-center rounded-tile-sm bg-muted text-primary" aria-label="Сгенерировать фото" :disabled="!!busy || slides.length >= 10" @click="generateGallery">
                  <UIcon :name="busy === 'gal-gen' ? 'i-lucide-loader-circle' : 'i-lucide-sparkles'" class="size-6" :class="busy === 'gal-gen' && 'animate-spin'" />
                </button>
                <button type="button" class="grid size-16 shrink-0 place-items-center rounded-tile-sm bg-muted text-primary" aria-label="Загрузить фото" :disabled="!!busy || slides.length >= 10" @click="galleryInput?.click()">
                  <UIcon :name="busy === 'gal-up' ? 'i-lucide-loader-circle' : 'i-lucide-image-plus'" class="size-6" :class="busy === 'gal-up' && 'animate-spin'" />
                </button>
                <input ref="galleryInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="uploadGallery">
              </div>
              <div v-if="isRich && slides.length > 1" class="flex items-center justify-between gap-3">
                <span class="text-meta text-muted">Фото в посте</span>
                <div class="flex gap-0.5 rounded-full bg-muted p-0.5">
                  <button
                    v-for="m in ([{ v: 'slideshow', l: 'Листать' }, { v: 'collage', l: 'Сеткой' }] as const)" :key="m.v" type="button"
                    class="h-7 rounded-full px-3 text-meta font-semibold transition" :class="(version?.gallery?.mode ?? 'slideshow') === m.v ? 'bg-petrol-900 text-white' : 'text-toned'"
                    :disabled="!!busy" @click="changeLayout({ mode: m.v }, 'gal-mode')"
                  >
                    {{ m.l }}
                  </button>
                </div>
              </div>
            </div>
            <div v-if="editable && version?.image_url && !version?.video" class="grid grid-cols-2 gap-2">
              <template v-if="!card?.custom && CARD_TEMPLATES[(card?.template ?? 'project') as CardTemplateId].photo">
                <UButton icon="i-lucide-refresh-cw" label="Другое фото" color="neutral" variant="outline" class="h-10 w-full justify-center rounded-full bg-elevated px-3 ring-0 shadow-sm" :loading="busy === 'photo'" :disabled="!!busy" @click="changeCard({ photo: 'next' }, 'photo')" />
                <UButton icon="i-lucide-sparkles" label="Сгенерировать" color="neutral" variant="outline" class="h-10 w-full justify-center rounded-full bg-elevated px-3 ring-0 shadow-sm" :loading="busy === 'ai'" :disabled="!!busy" @click="changeCard({ photo: 'ai' }, 'ai')" />
                <UButton icon="i-lucide-image-up" label="Своё фото" color="neutral" variant="outline" class="h-10 w-full justify-center rounded-full bg-elevated px-3 ring-0 shadow-sm" :loading="busy === 'upload'" :disabled="!!busy" @click="photoInput?.click()" />
              </template>
              <UButton icon="i-lucide-image" label="Своя картинка" color="neutral" variant="outline" class="h-10 w-full justify-center rounded-full bg-elevated px-3 ring-0 shadow-sm" :loading="busy === 'custom'" :disabled="!!busy" @click="customInput?.click()" />
              <UButton icon="i-lucide-layout-template" :label="card?.custom ? 'Вернуть макет' : 'Макет'" color="neutral" variant="outline" class="h-10 w-full justify-center rounded-full bg-elevated px-3 ring-0 shadow-sm" :disabled="!!busy" @click="templateOpen = true" />
              <UButton v-if="!card?.custom" icon="i-lucide-type" label="Текст на карточке" color="neutral" variant="outline" class="h-10 w-full justify-center rounded-full bg-elevated px-3 ring-0 shadow-sm" :disabled="!!busy" @click="fieldsOpen = true" />
              <input ref="photoInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="uploadPhoto">
              <input ref="customInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="uploadCustom">
            </div>
            <p v-if="busy === 'ai'" class="px-2 text-caption text-muted">Рисую фото по смыслу поста — это около минуты</p>
            <p v-if="editable && !card?.custom && card?.photo && card.photo.source !== 'none'" class="px-2 text-caption text-muted">
              {{ PHOTO_SOURCE_LABELS[card.photo.source as keyof typeof PHOTO_SOURCE_LABELS] }}<template v-if="card.photo.credit"> · {{ card.photo.credit }}</template>
            </p>

            <MiniSection v-if="detail.status === 'failed'" :title="detail.publication?.status === 'uncertain' ? 'Исход неясен' : 'Публикация не удалась'" icon="i-lucide-triangle-alert" tone="error">
              <p class="text-body text-toned">{{ detail.publication?.error || 'Оператор сервиса уже получил уведомление' }}</p>
            </MiniSection>

            <MiniSection v-if="detail.status === 'published'" title="Опубликован" icon="i-lucide-circle-check" tone="success">
              <MiniRow icon="i-lucide-send" tone="emerald" :title="detail.channel ?? 'Канал'" :subtitle="fmt(detail.publication?.published_at)" />
              <div v-if="detail.publication" class="grid grid-cols-3 text-center">
                <div><p class="text-stat font-bold text-highlighted">{{ detail.publication.views ?? '—' }}</p><p class="mt-1 text-caption text-muted">просмотры</p></div>
                <div><p class="text-stat font-bold text-highlighted">{{ detail.publication.reactions ?? '—' }}</p><p class="mt-1 text-caption text-muted">реакции</p></div>
                <div><p class="text-stat font-bold text-highlighted">{{ detail.publication.clicks ?? 0 }}</p><p class="mt-1 text-caption text-muted">переходы</p></div>
              </div>
              <div v-if="detail.publication?.url" class="flex gap-2">
                <UButton label="Открыть в канале" icon="i-lucide-external-link" size="lg" class="h-12 flex-1 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" @click="openChannel(detail.publication.url)" />
                <UButton icon="i-lucide-copy" color="neutral" variant="soft" size="lg" class="size-12 justify-center rounded-full" aria-label="Копировать ссылку" @click="copyLink(detail.publication.url)" />
              </div>
            </MiniSection>

            <MiniSection v-if="detail.revising || detail.status === 'draft'" title="Готовится" icon="i-lucide-sparkles">
              <MiniRow icon="i-lucide-loader-circle" spin tone="brand" :title="detail.revising ? 'AI вносит правки' : 'AI пишет текст и подбирает факты'" subtitle="Обычно 1–2 минуты" />
              <UProgress size="xs" />
            </MiniSection>

            <MiniSection title="Публикация" icon="i-lucide-send">
              <MiniRow icon="i-lucide-send" tone="sky" :title="detail.channel ?? 'Канал не подключён'" subtitle="Telegram-канал" />
              <button v-if="editable" type="button" class="block w-full text-left" @click="openTime">
                <MiniRow icon="i-lucide-clock" tone="brand" :title="fmt(detail.scheduled_at)" subtitle="Время выхода">
                  <UIcon name="i-lucide-pencil" class="size-4 shrink-0 text-dimmed" />
                </MiniRow>
              </button>
              <MiniRow v-else icon="i-lucide-clock" tone="brand" :title="fmt(detail.scheduled_at)" subtitle="Время выхода" />
              <UButton
                v-if="canResend" label="Отправить на согласование" icon="i-lucide-send-to-back" color="neutral" variant="soft"
                size="lg" block class="h-11 justify-center rounded-full" :loading="busy === 'resend'" :disabled="!!busy" @click="resend"
              />
              <UButton
                v-if="canSendNow" :label="detail.status === 'in_review' ? 'Одобрить и опубликовать сейчас' : 'Опубликовать сейчас'" icon="i-lucide-send"
                size="lg" block class="h-11 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'now'" :disabled="!!busy" @click="sendNow"
              />
            </MiniSection>

            <MiniSection :title="detail.kind === 'video_script' ? 'Сценарий' : 'Текст'" icon="i-lucide-align-left">
              <template v-if="versionTabs.length > 1 || editable" #right>
                <UButton v-if="editable && versionTabs.length <= 1" icon="i-lucide-pencil" label="Изменить" color="neutral" variant="soft" size="sm" class="h-8 rounded-full px-3" @click="editOpen = true" />
                <div v-else-if="versionTabs.length > 1" class="flex gap-0.5 rounded-full bg-muted p-0.5">
                  <button
                    v-for="t in versionTabs.slice(0, 4)" :key="t.value" type="button"
                    class="h-7 rounded-full px-3 text-meta font-semibold transition" :class="shownVersion === t.value ? 'bg-petrol-900 text-white' : 'text-toned'"
                    @click="shownVersion = t.value"
                  >
                    {{ t.label }}
                  </button>
                </div>
              </template>
              <p v-if="version?.comment" class="!mt-0 text-meta font-medium text-primary">Правка: «{{ version.comment }}»</p>
              <div v-if="isRich && detail.kind === 'post'" class="space-y-3 text-body text-toned" v-html="renderMarkdown(version?.text ?? '')" />
              <p v-else class="whitespace-pre-line text-body text-highlighted">{{ detail.kind === 'post' ? plainMarkdown(version?.text ?? '') : version?.text }}</p>
              <p v-if="version?.hashtags?.length" class="text-meta font-semibold text-primary">{{ version.hashtags.join(' ') }}</p>
              <UButton v-if="editable && versionTabs.length > 1" icon="i-lucide-pencil" label="Изменить текст вручную" color="neutral" variant="soft" block class="h-10 justify-center rounded-full" @click="editOpen = true" />
            </MiniSection>

            <MiniSection title="Проверка" icon="i-lucide-shield-check">
              <MiniRow v-for="w in warnings" :key="w.title" icon="i-lucide-triangle-alert" tone="amber" :title="w.title" :subtitle="w.subtitle" :lines="0" />
              <MiniRow v-if="!warnings.length" icon="i-lucide-check" tone="emerald" title="Замечаний нет" subtitle="Текст прошёл проверку" />
              <button v-for="(f, i) in version?.facts ?? []" :key="i" type="button" class="block w-full text-left" :disabled="!f.chunk_id" @click="openFact(f)">
                <MiniRow :icon="f.chunk_id ? 'i-lucide-book-open' : 'i-lucide-circle-help'" :tone="f.chunk_id ? 'brand' : 'amber'" :title="f.claim" :subtitle="f.chunk_id ? f.source_title : f.general ? 'Общеизвестный факт — сверьте' : 'Нет в материалах — проверьте'" :lines="0">
                  <UIcon v-if="f.chunk_id" name="i-lucide-chevron-right" class="size-5 shrink-0 text-dimmed" />
                </MiniRow>
              </button>
            </MiniSection>

            <MiniSection v-if="approvalsNow.length" title="Согласующие" icon="i-lucide-users">
              <template #right><span class="text-meta text-muted">{{ me.tenant.approval_rule === 'all' ? 'нужны все' : 'хватит одного' }}</span></template>
              <MiniRow
                v-for="a in approvalsNow" :key="a.id" :text="initials(a.member)" :tone="DECISION[a.decision]?.tone" :title="a.member ?? 'Участник'"
                :subtitle="a.comment ? `«${a.comment}»` : undefined" :meta="DECISION[a.decision]?.t" :meta-class="DECISION[a.decision]?.c" :lines="0"
              />
              <p class="text-caption text-muted">{{ me.tenant.approval_rule === 'all' ? 'Пост выйдет, когда одобрят все согласующие.' : 'Карточка приходит всем согласующим — пост выходит после первого одобрения.' }}</p>
            </MiniSection>

            <p class="px-4 pb-2 text-center text-caption text-muted">
              Версия {{ version?.n }} · {{ version?.author === 'human' ? 'правка вручную' : 'подготовил AI' }} · {{ fmt(version?.created_at) }}
            </p>

            <div v-if="detail.approval_id" class="sticky -bottom-6 z-10 -mx-3 flex gap-2 rounded-t-card bg-elevated px-4 pb-6 pt-3 shadow-[0_-8px_24px_rgb(15_59_68/.06)]">
              <UButton label="Отклонить" color="error" variant="outline" size="lg" class="h-12 flex-1 justify-center rounded-full ring-[1.5px] ring-rose-200" :loading="busy === 'r'" :disabled="!!busy" @click="rejectOpen = true" />
              <UButton label="Правка" icon="i-lucide-wand-sparkles" color="neutral" variant="soft" size="lg" class="h-12 flex-1 justify-center rounded-full" :disabled="!!busy" @click="reviseOpen = true" />
              <UButton label="Одобрить" icon="i-lucide-check" size="lg" class="h-12 flex-[1.3] justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'a'" :disabled="!!busy" @click="decide('a')" />
            </div>
          </section>

          <Transition v-else name="mini-fade" mode="out-in">
            <div v-if="tab === 'home'" key="home" class="space-y-3">
              <MiniWeekStrip :days="thisWeek" @select="d => openDay(d.key)" />
              <template v-if="posts === null"><USkeleton v-for="i in 2" :key="i" class="h-48 rounded-card" /></template>
              <template v-else>
                <MiniSection v-if="attention.length" title="Требуют внимания" icon="i-lucide-triangle-alert" :count="attention.length">
                  <MiniPostRow v-for="p in attention" :key="p.id" :post="p" :img="img" :fmt="fmt" @open="open(p.id)" />
                </MiniSection>
                <MiniSection title="Ждут решения" icon="i-lucide-hourglass" :count="queue.length || undefined">
                  <MiniPostRow v-for="p in queue" :key="p.id" :post="p" :img="img" :fmt="fmt" @open="open(p.id)" />
                  <MiniRow v-if="!queue.length" icon="i-lucide-party-popper" tone="emerald" tile="lg" title="Всё согласовано" subtitle="Новые посты появятся здесь">
                    <UButton label="Задача" color="neutral" variant="soft" class="h-10 rounded-full px-4" @click="goTab('task')" />
                  </MiniRow>
                </MiniSection>
                <MiniSection v-if="soon.length" title="Скоро выйдут" icon="i-lucide-calendar-clock" :count="soon.length">
                  <MiniPostRow v-for="p in soon" :key="p.id" :post="p" :img="img" :fmt="fmt" @open="open(p.id)" />
                </MiniSection>
                <MiniSection v-if="recent.length" title="Недавно вышли" icon="i-lucide-send">
                  <MiniPostRow v-for="p in recent" :key="p.id" :post="p" :img="img" :fmt="fmt" @open="open(p.id)" />
                </MiniSection>
              </template>
            </div>

            <div v-else-if="tab === 'materials'" key="materials" class="space-y-3">
              <div class="scroll-row">
                <button
                  v-for="f in FILTERS.filter(x => x.value === 'all' || count(x.value))" :key="f.value" type="button"
                  class="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[0.9rem] font-semibold transition active:scale-95"
                  :class="filter === f.value ? 'bg-petrol-900 text-white' : 'bg-elevated text-default shadow-sm'"
                  @click="filter = f.value"
                >
                  {{ f.label }} <span class="opacity-60">{{ count(f.value) }}</span>
                </button>
              </div>
              <template v-if="posts === null"><USkeleton v-for="i in 2" :key="i" class="h-48 rounded-card" /></template>
              <MiniSection v-for="g in groups" :key="g.title" :title="g.title" :icon="g.icon" :count="g.posts.length">
                <MiniPostRow v-for="p in g.posts" :key="p.id" :post="p" :img="img" :fmt="fmt" @open="open(p.id)" />
              </MiniSection>
              <div v-if="posts && !groups.length" class="rounded-card bg-elevated px-6 py-12 text-center">
                <MiniIconTile icon="i-lucide-newspaper" tone="slate" size="md" class="mx-auto" />
                <p class="mt-4 text-heading font-semibold text-highlighted">Здесь пока ничего нет</p>
                <p class="text-meta text-muted">Напишите боту задачу</p>
              </div>
            </div>

            <section v-else-if="tab === 'task'" key="task" class="-mb-6 flex min-h-full flex-col">
              <div class="flex-1 space-y-2.5 pb-3">
                <div v-if="messages === null" class="space-y-2.5"><USkeleton class="h-16 w-3/4 rounded-tile" /><USkeleton class="ms-auto h-12 w-2/3 rounded-tile" /></div>
                <div v-else-if="!messages.length" class="px-6 py-10 text-center">
                  <MiniIconTile icon="i-lucide-bot" tone="brand" size="md" class="mx-auto" />
                  <p class="mt-4 text-heading font-semibold text-highlighted">Опишите задачу своими словами</p>
                  <p class="text-meta text-muted">Пост, план на неделю, сценарий видео или вопрос о компании</p>
                </div>
                <div v-for="m in messages ?? []" :key="m.id" class="flex" :class="m.direction === 'in' ? 'justify-end' : 'justify-start'">
                  <div
                    class="max-w-[85%] rounded-tile px-4 py-3 text-body"
                    :class="m.direction === 'in' ? 'rounded-br-md bg-petrol-900 text-white' : 'rounded-bl-md bg-elevated text-highlighted'"
                  >
                    <p class="whitespace-pre-line">{{ m.text }}</p>
                    <UButton
                      v-if="m.post_id && m.direction === 'out'" label="Открыть карточку" trailing-icon="i-lucide-arrow-right" color="primary" variant="outline" block
                      class="mt-2 h-10 justify-between rounded-full bg-elevated ring-[1.5px] ring-petrol-200" @click="open(m.post_id)"
                    />
                  </div>
                </div>
                <div v-if="waitingReply" class="flex">
                  <div class="flex items-center gap-3 rounded-tile rounded-bl-md bg-elevated px-4 py-3">
                    <span class="flex gap-1">
                      <span v-for="i in 3" :key="i" class="size-2 animate-bounce rounded-full bg-primary" :style="{ animationDelay: `${i * 0.15}s` }" />
                    </span>
                    <span class="text-meta text-muted">{{ waitingPhase }}…</span>
                  </div>
                </div>
                <div ref="chatEnd" />
              </div>
              <div class="sticky bottom-0 -mx-3 space-y-2.5 bg-default/95 px-3 py-3 backdrop-blur">
                <div class="scroll-row !mb-0">
                  <button type="button" class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-petrol-900 px-3.5 text-meta font-semibold text-white shadow-sm active:scale-95" @click="newOpen = true">
                    <UIcon name="i-lucide-pencil-line" class="size-4" />Написать самому
                  </button>
                  <button v-for="q in QUICK" :key="q.label" type="button" class="inline-flex h-9 shrink-0 items-center rounded-full bg-elevated px-3.5 text-meta font-semibold shadow-sm active:scale-95" :disabled="waitingReply" @click="sendTask(q.text)">{{ q.label }}</button>
                </div>
                <form class="flex items-end gap-2 rounded-card bg-elevated p-2 ps-4" @submit.prevent="sendTask()">
                  <UTextarea
                    v-model="draft" :rows="1" autoresize :maxrows="5" variant="none" :placeholder="recording ? `Запись… ${recSeconds} с` : `Задача для ${me.tenant.name}…`" :disabled="recording"
                    class="flex-1" :ui="{ base: 'px-0 py-2 text-body' }" @keydown.enter.exact.prevent="sendTask()"
                  />
                  <UButton
                    v-if="!draft.trim() && canRecord" type="button" :icon="recording ? 'i-lucide-square' : 'i-lucide-mic'" :loading="voiceBusy"
                    class="size-10 justify-center rounded-full" :class="recording ? 'animate-pulse bg-error hover:bg-error' : 'bg-petrol-900 hover:bg-petrol-800'"
                    :aria-label="recording ? 'Остановить запись' : 'Записать голосом'" @click="toggleVoice"
                  />
                  <UButton v-else type="submit" icon="i-lucide-arrow-up" class="size-10 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :disabled="draft.trim().length < 2" aria-label="Отправить" />
                </form>
              </div>
            </section>

            <div v-else-if="tab === 'plan'" key="plan" class="space-y-3">
              <div class="flex items-center justify-between px-1">
                <UButton icon="i-lucide-chevron-left" color="neutral" variant="outline" class="size-10 justify-center rounded-full bg-elevated ring-0 shadow-sm" aria-label="Предыдущая неделя" @click="weekOffset--" />
                <div class="text-center">
                  <p class="text-heading font-semibold text-highlighted">{{ weekLabel }}</p>
                  <button v-if="weekOffset !== 0" type="button" class="text-meta font-semibold text-primary" @click="toToday">К сегодняшней неделе</button>
                </div>
                <UButton icon="i-lucide-chevron-right" color="neutral" variant="outline" class="size-10 justify-center rounded-full bg-elevated ring-0 shadow-sm" aria-label="Следующая неделя" @click="weekOffset++" />
              </div>
              <MiniWeekStrip :days="planWeek" :selected="selectedDay" @select="d => pickDay(d.key)" />

              <div v-if="ideas.length" class="flex items-center gap-3 rounded-card bg-elevated p-4 ps-5">
                <UIcon name="i-lucide-lightbulb" class="size-5 shrink-0 text-warning" />
                <p class="flex-1 text-body font-semibold text-highlighted">Идей ждут решения: {{ ideas.length }}</p>
                <UButton label="Принять" size="sm" class="h-9 rounded-full bg-petrol-900 px-3.5 hover:bg-petrol-800" @click="acceptIdeas" />
              </div>

              <div v-if="emptyDay" id="day-empty" class="scroll-mt-3 rounded-card bg-elevated p-5">
                <MiniRow
                  :icon="emptyDay.published.length ? 'i-lucide-send' : 'i-lucide-calendar'" :tone="emptyDay.published.length ? 'emerald' : 'slate'" tile="md"
                  :title="emptyDay.title" :subtitle="emptyDay.published.length ? `Вышло: ${emptyDay.published.map((p: any) => p.title || p.topic).join(', ')}` : emptyDay.past ? 'В этот день ничего не выходило' : 'На этот день ничего не запланировано'" :lines="0"
                >
                  <UButton v-if="!emptyDay.past" label="Тема" icon="i-lucide-sparkles" class="h-10 rounded-full bg-petrol-900 px-4 hover:bg-petrol-800" @click="askBot(`Предложи тему поста на ${dayShort(emptyDay.key)} и подготовь его к 10:00`)" />
                </MiniRow>
              </div>

              <template v-if="plan === null"><USkeleton v-for="i in 2" :key="i" class="h-40 rounded-card" /></template>
              <section v-for="d in planDays" :id="`day-${d.key}`" :key="d.key" class="scroll-mt-3">
                <MiniSection :title="d.title" :icon="d.today ? 'i-lucide-sun' : 'i-lucide-calendar'">
                  <MiniRow
                    v-for="i in d.items" :key="i.id" icon="i-lucide-lightbulb" :tone="i.status === 'idea' ? 'amber' : i.status === 'drafted' ? 'emerald' : 'brand'"
                    tile="lg" :lines="2" :title="i.topic" :subtitle="i.reason || i.rubric" :meta="`${PLAN_LINE[i.status]?.t} · ${i.time}`" :meta-class="PLAN_LINE[i.status]?.c"
                    class="cursor-pointer" :class="i.status === 'skipped' && 'opacity-45'" @click="idea = i"
                  >
                    <div v-if="i.status === 'idea'" class="flex flex-col items-end gap-0.5">
                      <UButton label="Принять" color="primary" variant="outline" class="h-10 rounded-full bg-elevated px-4 ring-[1.5px] ring-petrol-200" @click.stop="setPlan(i.id, 'accepted')" />
                      <UButton label="Пропустить" color="neutral" variant="ghost" size="sm" class="h-7 px-2 text-caption text-muted" @click.stop="setPlan(i.id, 'skipped')" />
                    </div>
                    <UButton v-else-if="i.postId" icon="i-lucide-arrow-right" color="neutral" variant="soft" class="size-10 justify-center rounded-full" aria-label="Открыть пост" @click.stop="open(i.postId)" />
                    <UIcon v-else name="i-lucide-chevron-right" class="mx-1 size-5 text-dimmed" />
                  </MiniRow>
                </MiniSection>
              </section>
              <div v-if="plan && !planDays.length" class="rounded-card bg-elevated p-5">
                <MiniRow icon="i-lucide-calendar-plus" tone="slate" tile="md" title="Неделя пустая" subtitle="Попросите бота составить план">
                  <UButton label="Составить" icon="i-lucide-sparkles" class="h-10 rounded-full bg-petrol-900 px-4 hover:bg-petrol-800" @click="askBot('Составь контент-план на неделю')" />
                </MiniRow>
              </div>
            </div>

            <div v-else key="results" class="space-y-3">
              <div class="grid grid-cols-2 gap-1 rounded-full bg-elevated p-1">
                <button
                  v-for="p in ([7, 30] as const)" :key="p" type="button"
                  class="h-10 rounded-full text-body font-semibold transition"
                  :class="period === p ? 'bg-petrol-900 text-white' : 'text-muted'"
                  @click="setPeriod(p)"
                >
                  {{ p }} дней
                </button>
              </div>

              <div v-if="!summary" class="grid grid-cols-2 gap-3"><USkeleton v-for="i in 6" :key="i" class="h-36 rounded-card" /></div>
              <template v-else>
                <div class="grid grid-cols-2 gap-3">
                  <div v-for="k in kpis" :key="k.label" class="space-y-4 rounded-card bg-elevated p-5">
                    <MiniIconTile :icon="k.icon" :tone="k.tone" />
                    <div>
                      <p class="text-display font-bold leading-none tracking-tight text-highlighted">{{ k.value }}</p>
                      <p class="mt-1.5 text-meta text-muted">
                        {{ k.label }}
                        <span v-if="k.delta" class="font-semibold" :class="k.delta > 0 ? 'text-success' : 'text-error'"> {{ k.delta > 0 ? '+' : '' }}{{ k.delta }}</span>
                      </p>
                    </div>
                    <MiniSpark v-if="k.spark" :values="k.spark" />
                  </div>
                </div>

                <MiniSection v-if="dash" title="Динамика" icon="i-lucide-chart-column">
                  <template #right><span class="text-meta font-semibold tabular-nums text-muted">{{ TREND[trend].unit(trendTotal) }}</span></template>
                  <div class="grid grid-cols-4 gap-1 rounded-full bg-glass-100 p-1">
                    <button
                      v-for="(t, key) in TREND" :key="key" type="button"
                      class="h-8 rounded-full text-caption font-semibold transition"
                      :class="trend === key ? 'bg-elevated text-highlighted shadow-sm' : 'text-muted'"
                      @click="trend = key"
                    >
                      {{ t.label }}
                    </button>
                  </div>
                  <MiniBars :items="trendItems" :unit="TREND[trend].unit" />
                </MiniSection>

                <MiniSection v-if="perf" title="Охват" icon="i-lucide-eye">
                  <div class="grid grid-cols-3">
                    <div><p class="text-stat font-bold text-highlighted">{{ perf.totals.views === null ? '—' : nf(perf.totals.views) }}</p><p class="mt-1 text-caption text-muted">просмотры</p></div>
                    <div><p class="text-stat font-bold text-highlighted">{{ perf.totals.avgViews ?? '—' }}</p><p class="mt-1 text-caption text-muted">на пост</p></div>
                    <div><p class="text-stat font-bold text-highlighted">{{ perf.totals.clicks }}</p><p class="mt-1 text-caption text-muted">переходы</p></div>
                  </div>
                  <div v-if="dash" class="grid grid-cols-3 border-t border-default pt-4">
                    <div><p class="text-heading font-bold text-highlighted">{{ pctText(dash.engagement.er) }}</p><p class="mt-1 text-caption text-muted">вовлечённость</p></div>
                    <div><p class="text-heading font-bold text-highlighted">{{ pctText(dash.engagement.ctr) }}</p><p class="mt-1 text-caption text-muted">кликабельность</p></div>
                    <div><p class="text-heading font-bold text-highlighted">{{ dash.engagement.reactions ?? '—' }}</p><p class="mt-1 text-caption text-muted">реакции</p></div>
                  </div>
                  <MiniRow v-for="b in bests" :key="b.label" :icon="b.icon" tone="brand" :title="b.value" :subtitle="b.label">
                    <span class="text-body font-semibold tabular-nums text-highlighted">{{ b.views }}</span>
                  </MiniRow>
                </MiniSection>

                <MiniSection v-if="topPosts.length" title="Лучшие посты" icon="i-lucide-trophy">
                  <button v-for="(p, i) in topPosts" :key="p.postId" type="button" class="block w-full text-left" @click="p.url ? openChannel(p.url) : open(p.postId)">
                    <div class="flex items-center gap-3">
                      <span class="grid size-8 shrink-0 place-items-center rounded-full text-meta font-bold" :class="i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-glass-100 text-toned'">{{ i + 1 }}</span>
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-body font-semibold text-highlighted">{{ p.title }}</p>
                        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-glass-100">
                          <div class="h-full rounded-full bg-petrol-500" :style="{ width: `${Math.max(3, p.views / topMax * 100)}%` }" />
                        </div>
                      </div>
                      <span class="flex shrink-0 flex-col items-end text-caption tabular-nums text-muted">
                        <span class="flex items-center gap-1 font-semibold text-highlighted"><UIcon name="i-lucide-eye" class="size-3.5" />{{ nf(p.views) }}</span>
                        <span class="flex items-center gap-1"><UIcon name="i-lucide-mouse-pointer-click" class="size-3.5" />{{ p.clicks }}</span>
                      </span>
                    </div>
                  </button>
                </MiniSection>

                <MiniSection v-if="perf && (perf.byTemplate.length || perf.byRubric.length)" title="Что заходит" icon="i-lucide-flame">
                  <div class="grid grid-cols-3 gap-1 rounded-full bg-glass-100 p-1">
                    <button
                      v-for="(t, key) in FORMATS" :key="key" type="button"
                      class="h-8 rounded-full text-meta font-semibold transition"
                      :class="format === key ? 'bg-elevated text-highlighted shadow-sm' : 'text-muted'"
                      @click="format = key"
                    >
                      {{ t }}
                    </button>
                  </div>
                  <MiniHBars v-if="formatItems.length" :items="formatItems" :unit="avgUnit" />
                  <p v-else class="text-meta text-muted">Просмотры ещё собираются</p>
                </MiniSection>

                <MiniSection v-if="dash" title="Воронка" icon="i-lucide-filter">
                  <MiniHBars :items="funnel" :base="dash.funnel.created || 1" />
                </MiniSection>

                <MiniSection title="Согласование" icon="i-lucide-stamp">
                  <div class="grid grid-cols-3">
                    <div><p class="text-stat font-bold text-success">{{ summary.approvals.approved }}</p><p class="mt-1 text-caption text-muted">одобрено</p></div>
                    <div><p class="text-stat font-bold text-primary">{{ summary.approvals.changes }}</p><p class="mt-1 text-caption text-muted">на доработку</p></div>
                    <div><p class="text-stat font-bold text-error">{{ summary.approvals.rejected }}</p><p class="mt-1 text-caption text-muted">отклонено</p></div>
                  </div>
                  <div v-for="a in dash?.approvers ?? []" :key="a.name" class="space-y-3 border-t border-default pt-4">
                    <div class="flex items-center gap-3">
                      <MiniIconTile :text="a.name.slice(0, 1)" tone="sky" />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-heading font-semibold text-highlighted">{{ a.name }}</p>
                        <p class="text-meta text-muted">{{ a.avgSec ? `отвечает за ${mins(a.avgSec)}` : 'ещё не отвечал' }}<template v-if="a.pending"> · ждёт {{ a.pending }}</template></p>
                      </div>
                    </div>
                    <MiniStack :items="approverStack(a)" />
                  </div>
                </MiniSection>

                <MiniSection v-if="dash && sumOf(planStack)" title="Контент-план" icon="i-lucide-calendar-check" :count="sumOf(planStack)">
                  <MiniStack :items="planStack" />
                </MiniSection>

                <MiniSection v-if="dash && sumOf(originStack)" title="Откуда посты" icon="i-lucide-git-branch">
                  <MiniStack :items="originStack" />
                  <div v-if="dash.mix.videos" class="flex items-center gap-2 text-meta text-muted">
                    <UIcon name="i-lucide-clapperboard" class="size-4" />
                    Вышло видео: <span class="font-semibold text-highlighted">{{ dash.mix.videos }}</span>, постов: <span class="font-semibold text-highlighted">{{ dash.mix.posts }}</span>
                  </div>
                </MiniSection>

                <MiniSection title="Комментарии" icon="i-lucide-message-circle" :count="summary.comments">
                  <MiniStack v-if="dash && sumOf(sentimentStack)" :items="sentimentStack" />
                  <p v-else class="text-meta text-muted">Комментариев пока нет</p>
                </MiniSection>

                <MiniSection title="Работа AI" icon="i-lucide-cpu">
                  <div class="grid grid-cols-3">
                    <div><p class="text-heading font-bold text-highlighted">{{ summary.usage.calls }}</p><p class="text-caption text-muted">обращений</p></div>
                    <div><p class="text-heading font-bold text-highlighted">{{ Math.round((summary.usage.tokensIn + summary.usage.tokensOut) / 1000) }} тыс.</p><p class="text-caption text-muted">токенов</p></div>
                    <div><p class="text-heading font-bold text-highlighted">${{ Number(summary.usage.cost).toFixed(2) }}</p><p class="text-caption text-muted">оценка</p></div>
                  </div>
                  <MiniHBars v-if="aiItems.length" :items="aiItems" :unit="timesUnit" />
                </MiniSection>

                <MiniSection v-if="dash" title="База знаний" icon="i-lucide-library">
                  <div class="grid grid-cols-2">
                    <div><p class="text-stat font-bold text-highlighted">{{ dash.kb.sources }}</p><p class="mt-1 text-caption text-muted">материалов</p></div>
                    <div><p class="text-stat font-bold text-highlighted">{{ nf(dash.kb.chunks) }}</p><p class="mt-1 text-caption text-muted">фактов для постов</p></div>
                  </div>
                </MiniSection>
              </template>
            </div>
          </Transition>
        </main>

        <nav v-if="!detail" class="grid grid-cols-5 items-center rounded-t-card bg-elevated px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgb(15_59_68/.05)]">
          <div v-for="n in NAV" :key="n.value" class="flex justify-center">
            <button
              v-if="'center' in n" type="button" :aria-label="n.label"
              class="grid size-12 place-items-center rounded-nav bg-petrol-900 text-white shadow-lg shadow-petrol-900/25 transition active:scale-95"
              @click="navTo(n.value)"
            >
              <UIcon :name="n.icon" class="size-6" />
            </button>
            <button
              v-else type="button" :aria-label="n.label"
              class="relative grid size-12 place-items-center rounded-nav transition active:scale-95"
              :class="tab === n.value ? 'bg-muted text-petrol-900' : 'text-muted'"
              @click="navTo(n.value)"
            >
              <UIcon :name="n.icon" class="size-6.5" />
              <span v-if="n.value === 'home' && pending" class="absolute right-1.5 top-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-error px-1 text-[0.6875rem] font-bold leading-none text-white tabular-nums">{{ pending }}</span>
            </button>
          </div>
        </nav>

        <UDrawer v-model:open="switcherOpen" title="Компания" :ui="{ content: 'bg-default', header: 'sr-only' }">
          <template #body>
            <MiniSection title="Компания" icon="i-lucide-building-2">
              <button v-for="t in me.tenants" :key="t.id" type="button" class="block w-full text-left" @click="switchTenant(t.id)">
                <MiniRow icon="i-lucide-factory" tone="brand" tile="md" :title="t.name" :meta="t.id === me.tenant.id ? 'Выбрана' : undefined" meta-class="text-primary">
                  <UIcon :name="t.id === me.tenant.id ? 'i-lucide-circle-check' : 'i-lucide-circle'" class="size-6" :class="t.id === me.tenant.id ? 'text-primary' : 'text-dimmed'" />
                </MiniRow>
              </button>
              <p class="text-caption text-muted">Данные компаний изолированы: посты, план и статистика другой компании не видны.</p>
            </MiniSection>
          </template>
        </UDrawer>

        <UDrawer v-model:open="reviseOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <div class="p-3 pb-6">
              <div class="space-y-4 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-title font-semibold text-highlighted">Что поменять?</p>
                  <p class="text-meta text-muted">AI подготовит новую версию, её нужно будет одобрить заново</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="c in CHIPS" :key="c" type="button" class="h-9 rounded-full px-3.5 text-meta font-semibold transition"
                    :class="comment === c ? 'bg-petrol-900 text-white' : 'bg-muted text-default'" @click="comment = c"
                  >
                    {{ c }}
                  </button>
                </div>
                <UTextarea v-model="comment" placeholder="Или напишите своими словами" :rows="3" autoresize variant="soft" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted text-body' }" />
                <UButton label="Отправить на доработку" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'c'" :disabled="comment.trim().length < 3" @click="sendRevision" />
              </div>
            </div>
          </template>
        </UDrawer>

        <UDrawer v-model:open="templateOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <div class="p-3 pb-6">
              <div class="space-y-4 rounded-card bg-elevated p-5">
                <p class="text-title font-semibold text-highlighted">Макет карточки</p>
                <div class="grid grid-cols-3 gap-2.5">
                  <button
                    v-for="t in templates" :key="t.id" type="button" class="relative text-left disabled:opacity-60" :disabled="!!busy"
                    @click="t.id !== card?.template && changeCard({ template: t.id }, `card:${t.id}`)"
                  >
                    <img :src="img(`/api/v1/miniapp/card-preview/${t.id}`)" :alt="t.name" loading="lazy" class="aspect-square w-full rounded-tile-sm bg-muted object-cover" :class="t.id === card?.template ? 'ring-[3px] ring-primary' : ''">
                    <span class="mt-1 block text-caption font-semibold leading-tight" :class="t.id === card?.template ? 'text-primary' : 'text-toned'">{{ t.name }}</span>
                    <span v-if="busy === `card:${t.id}`" class="absolute inset-0 grid aspect-square place-items-center rounded-tile-sm bg-white/60"><UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-primary" /></span>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </UDrawer>

        <UDrawer v-model:open="fieldsOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <form class="p-3 pb-6" @submit.prevent="changeCard({ fields: { ...cardForm } }, 'card:fields')">
              <div class="space-y-3 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-title font-semibold text-highlighted">Текст на карточке</p>
                  <p class="text-meta text-muted">{{ CARD_TEMPLATES[(card?.template ?? 'project') as CardTemplateId].name }}</p>
                </div>
                <div class="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  <label v-for="f in cardFieldList" :key="f.key" :class="f.wide ? 'col-span-2' : ''" class="block">
                    <span class="mb-1 flex justify-between text-caption font-semibold text-toned">{{ f.label }}<span class="font-normal tabular-nums text-dimmed">{{ (cardForm[f.key] ?? '').length }}/{{ f.max }}</span></span>
                    <UInput v-model="cardForm[f.key]" :maxlength="f.max" variant="soft" size="lg" class="w-full" :placeholder="f.optional ? 'необязательно' : ''" :ui="{ base: 'rounded-tile-sm bg-muted' }" />
                  </label>
                </div>
                <UButton type="submit" label="Обновить карточку" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'card:fields'" />
              </div>
            </form>
          </template>
        </UDrawer>
        <UDrawer v-model:open="timeOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <form class="p-3 pb-6" @submit.prevent="saveTime()">
              <div class="space-y-4 rounded-card bg-elevated p-5">
                <p class="text-title font-semibold text-highlighted">Время выхода</p>
                <div class="flex flex-wrap gap-2">
                  <button v-for="q in [{ l: 'Сегодня 18:00', d: 0, h: 18 }, { l: 'Завтра 10:00', d: 1, h: 10 }, { l: 'Завтра 18:00', d: 1, h: 18 }]" :key="q.l" type="button" class="h-9 rounded-full bg-muted px-3.5 text-meta font-semibold text-default" @click="quickTime(q.d, q.h)">
                    {{ q.l }}
                  </button>
                </div>
                <UInput v-model="timeValue" type="datetime-local" variant="soft" size="lg" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted' }" />
                <UButton type="submit" label="Сохранить" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'time'" :disabled="!timeValue" />
                <UButton label="Без времени — сразу после одобрения" color="neutral" variant="soft" size="lg" block class="h-11 justify-center rounded-full" :disabled="!!busy" @click="saveTime(true)" />
              </div>
            </form>
          </template>
        </UDrawer>
        <UDrawer v-model:open="rejectOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <div class="p-3 pb-6">
              <div class="space-y-4 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-title font-semibold text-highlighted">Почему отклоняете?</p>
                  <p class="text-meta text-muted">Пост не выйдет. Причину AI учтёт в следующих материалах</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="c in REJECT_CHIPS" :key="c" type="button" class="h-9 rounded-full px-3.5 text-meta font-semibold transition"
                    :class="rejectReason === c ? 'bg-error text-white' : 'bg-muted text-default'" @click="rejectReason = c"
                  >
                    {{ c }}
                  </button>
                </div>
                <UTextarea v-model="rejectReason" placeholder="Или своими словами (необязательно)" :rows="2" autoresize variant="soft" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted text-body' }" />
                <UButton label="Отклонить пост" color="error" size="lg" block class="h-12 justify-center rounded-full" :loading="busy === 'r'" @click="decide('r')" />
              </div>
            </div>
          </template>
        </UDrawer>

        <UDrawer v-model:open="editOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <form class="p-3 pb-6" @submit.prevent="saveEdit">
              <div class="space-y-3 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-title font-semibold text-highlighted">Текст поста</p>
                  <p class="text-meta text-muted">Правите сами, без AI. Карточка обновится по тексту, пост снова уйдёт на согласование</p>
                </div>
                <UInput v-model="editForm.title" placeholder="Заголовок" size="lg" maxlength="90" variant="soft" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted text-body' }" />
                <div v-if="isRich" class="-mx-1 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]">
                  <button v-for="t in MD_TOOLS" :key="t.label" type="button" class="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 text-meta font-semibold text-toned" @mousedown.prevent @click="insertMd(t)">
                    <UIcon :name="t.icon" class="size-3.5" />{{ t.label }}
                  </button>
                </div>
                <UTextarea ref="editTa" v-model="editForm.text" :rows="8" autoresize :maxrows="16" variant="soft" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted text-body' }" />
                <UButton type="submit" label="Сохранить" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'edit'" :disabled="editForm.text.trim().length < 10" />
              </div>
            </form>
          </template>
        </UDrawer>

        <UDrawer v-model:open="newOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <form class="p-3 pb-6" @submit.prevent="createOwn">
              <div class="space-y-3 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-title font-semibold text-highlighted">Свой пост</p>
                  <p class="text-meta text-muted">Пишете сами. Карточку соберу по тексту — или приложите готовую картинку</p>
                </div>
                <UInput v-model="newForm.title" placeholder="Заголовок" size="lg" maxlength="90" variant="soft" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted text-body' }" />
                <UTextarea v-model="newForm.text" placeholder="Текст поста" :rows="6" autoresize :maxrows="14" variant="soft" class="w-full" :ui="{ base: 'rounded-tile-sm bg-muted text-body' }" />
                <button type="button" class="flex w-full items-center gap-3 rounded-tile-sm bg-muted px-4 py-3 text-left" @click="newFileInput?.click()">
                  <UIcon :name="newFile ? 'i-lucide-image' : 'i-lucide-image-plus'" class="size-5 text-primary" />
                  <span class="flex-1 truncate text-body" :class="newFile ? 'text-highlighted' : 'text-muted'">{{ newFile ? newFile.name : 'Готовая картинка (необязательно)' }}</span>
                  <UIcon v-if="newFile" name="i-lucide-x" class="size-4 text-muted" @click.stop="newFile = null" />
                </button>
                <input ref="newFileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="e => newFile = (e.target as HTMLInputElement).files?.[0] ?? null">
                <UButton type="submit" label="На согласование" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === 'new'" :disabled="newForm.title.trim().length < 3 || newForm.text.trim().length < 10" />
              </div>
            </form>
          </template>
        </UDrawer>

        <UDrawer v-model:open="ideaOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <div v-if="idea" class="p-3 pb-6">
              <div class="space-y-4 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-meta font-semibold" :class="PLAN_LINE[idea.status]?.c">{{ PLAN_LINE[idea.status]?.t }} · {{ dayShort(idea.date) }}, {{ idea.time }}<template v-if="idea.rubric"> · {{ idea.rubric }}</template></p>
                  <p class="mt-1 text-title font-semibold text-highlighted">{{ idea.topic }}</p>
                  <p v-if="idea.reason" class="mt-2 text-body text-toned">{{ idea.reason }}</p>
                </div>
                <p class="rounded-tile-sm bg-muted px-4 py-3 text-meta text-toned">{{ PLAN_LINE[idea.status]?.about }}</p>
                <UButton v-if="idea.postId" label="Открыть пост" icon="i-lucide-arrow-right" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" @click="open(idea.postId); idea = null" />
                <template v-else>
                  <UButton label="Подготовить пост сейчас" icon="i-lucide-sparkles" size="lg" block class="h-12 justify-center rounded-full bg-petrol-900 hover:bg-petrol-800" :loading="busy === `plan:${idea.id}`" @click="draftNow(idea)" />
                  <div v-if="idea.status === 'idea'" class="grid grid-cols-2 gap-2">
                    <UButton label="Принять" color="primary" variant="outline" size="lg" class="h-11 justify-center rounded-full ring-[1.5px] ring-petrol-200" @click="setPlan(idea.id, 'accepted')" />
                    <UButton label="Пропустить" color="neutral" variant="soft" size="lg" class="h-11 justify-center rounded-full" @click="setPlan(idea.id, 'skipped'); idea = null" />
                  </div>
                  <UButton v-else-if="idea.status === 'skipped'" label="Вернуть в план" color="primary" variant="outline" size="lg" block class="h-11 justify-center rounded-full" @click="setPlan(idea.id, 'accepted')" />
                </template>
              </div>
            </div>
          </template>
        </UDrawer>

        <UDrawer v-model:open="factOpen" :ui="{ content: 'bg-default' }">
          <template #content>
            <div v-if="fact" class="p-3 pb-6">
              <div class="space-y-4 rounded-card bg-elevated p-5">
                <div>
                  <p class="text-meta font-semibold text-primary">Утверждение в посте</p>
                  <p class="mt-1 text-heading font-semibold text-highlighted">{{ fact.claim }}</p>
                </div>
                <div class="space-y-2">
                  <p class="flex items-center gap-2 text-meta font-semibold text-toned"><UIcon name="i-lucide-book-open" class="size-4 text-primary" />{{ fact.title }}</p>
                  <USkeleton v-if="fact.loading" class="h-24 rounded-tile-sm" />
                  <blockquote v-else class="max-h-72 overflow-y-auto whitespace-pre-line rounded-tile-sm border-l-4 border-primary bg-muted px-4 py-3 text-body text-highlighted">{{ fact.text }}</blockquote>
                </div>
                <UButton v-if="fact.url" label="Открыть источник" icon="i-lucide-external-link" color="neutral" variant="soft" size="lg" block class="h-11 justify-center rounded-full" @click="openChannel(fact.url)" />
              </div>
            </div>
          </template>
        </UDrawer>
      </template>

      <div id="phone-portal" class="relative z-50" />
    </div>
  </div>
</template>
