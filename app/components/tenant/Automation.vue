<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const tenant = inject<Ref<any>>('tenant')!
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/schedules`, { silent: true }), { poll: 10000 })
const { data: runs, reload: reloadRuns } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/job-runs`, { query: { limit: 40 }, silent: true }), { poll: 5000 })

const TYPES = [
  { value: 'auto_draft', label: 'Черновик поста', icon: 'i-lucide-file-pen-line' },
  { value: 'weekly_plan', label: 'Контент-план на неделю', icon: 'i-lucide-calendar-days' },
  { value: 'weekly_report', label: 'Отчёт о результатах', icon: 'i-lucide-chart-line' },
  { value: 'site_monitor', label: 'Новости с сайта', icon: 'i-lucide-globe' },
  { value: 'custom_task', label: 'Своя задача', icon: 'i-lucide-wand-sparkles' },
  { value: 'collect_metrics', label: 'Метрики канала', icon: 'i-lucide-activity' },
]
const PRESETS = [
  { label: 'По будням в 9:00', value: '0 9 * * 1-5' },
  { label: 'Каждый день в 10:00', value: '0 10 * * *' },
  { label: 'По понедельникам в 9:30', value: '30 9 * * 1' },
  { label: 'По пятницам в 17:00', value: '0 17 * * 5' },
  { label: 'Каждые 3 часа', value: '0 */3 * * *' },
  { label: 'Каждый час', value: '0 * * * *' },
  { label: 'Своё выражение cron', value: 'custom' },
]
const RUN_STATUS: Record<string, { label: string, color: any, icon: string, cls: string }> = {
  queued: { label: 'В очереди', color: 'neutral', icon: 'i-lucide-clock', cls: 'text-muted' },
  running: { label: 'Выполняется', color: 'info', icon: 'i-lucide-loader-circle', cls: 'text-info animate-spin' },
  succeeded: { label: 'Выполнено', color: 'success', icon: 'i-lucide-circle-check', cls: 'text-success' },
  failed: { label: 'Ошибка', color: 'error', icon: 'i-lucide-circle-x', cls: 'text-error' },
  skipped: { label: 'Пропущено', color: 'warning', icon: 'i-lucide-circle-slash', cls: 'text-warning' },
}
const columns: TableColumn<any>[] = [
  { id: 'task', header: 'Задача' },
  { accessorKey: 'nextRunAt', header: 'Следующий', meta: { class: { td: 'whitespace-nowrap' } } },
  { id: 'actions', meta: { class: { td: 'text-right w-0' } } },
]

const open = ref(false)
const saving = ref(false)
const form = reactive({ type: 'auto_draft', preset: '0 9 * * 1-5', cron: '', inMinutes: false, url: '', text: '', rubric: '' })

function cronInTwoMinutes() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tenant.value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + 120000))
  const get = (t: string) => Number(p.find(x => x.type === t)!.value)
  return `${get('minute')} ${get('hour')} * * *`
}

async function create() {
  saving.value = true
  try {
    const cron = form.inMinutes ? cronInTwoMinutes() : form.preset === 'custom' ? form.cron : form.preset
    const params: Record<string, any> = {}
    if (form.type === 'site_monitor') params.url = form.url
    if (form.type === 'custom_task') params.text = form.text
    if (form.type === 'auto_draft' && form.rubric) params.rubric = form.rubric
    await api(`/tenants/${props.tenantId}/schedules`, { method: 'POST', body: { type: form.type, cron, params, enabled: true } })
    toast.add({ title: 'Расписание создано', color: 'success' })
    open.value = false
    await reload(true)
    await reloadTenant()
  }
  catch {}
  finally { saving.value = false }
}

async function toggle(s: any) {
  await api(`/tenants/${props.tenantId}/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } })
  await reload(true)
  await reloadTenant()
}
async function runNow(s: any) {
  await api(`/tenants/${props.tenantId}/schedules/${s.id}/run-now`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } })
  toast.add({ title: 'Запущено', color: 'info' })
  await reloadRuns(true)
}
async function remove(s: any) {
  await api(`/tenants/${props.tenantId}/schedules/${s.id}`, { method: 'DELETE' })
  await reload(true)
  await reloadTenant()
}
const scheduleRuns = computed(() => (runs.value ?? []).filter(r => r.scheduledJobId).slice(0, 10))
const typeOf = (t: string) => TYPES.find(x => x.value === t)
</script>

<template>
  <div class="space-y-8">
    <Teleport defer to="#panel-actions">
      <UButton icon="i-lucide-plus" @click="open = true">Расписание</UButton>
    </Teleport>

    <LoadState :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-calendar-clock" empty-title="Расписаний нет" @retry="reload()">
      <template #action><UButton icon="i-lucide-plus" @click="open = true">Добавить расписание</UButton></template>
      <UTable :data="data ?? []" :columns="columns" class="rounded-xl border border-default" :ui="{ td: 'py-2.5' }">
        <template #task-cell="{ row }">
          <div class="flex items-center gap-3" :class="row.original.enabled ? '' : 'opacity-50'">
            <USwitch :model-value="row.original.enabled" size="sm" :aria-label="row.original.enabled ? 'Выключить' : 'Включить'" @update:model-value="toggle(row.original)" />
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><UIcon :name="typeOf(row.original.type)?.icon ?? 'i-lucide-calendar-clock'" class="size-4" /></span>
            <div class="min-w-0 max-w-xs xl:max-w-md">
              <p class="truncate font-medium text-highlighted">{{ row.original.title }}</p>
              <p v-if="row.original.params?.url || row.original.params?.text" class="truncate text-xs text-muted">{{ row.original.params?.url || row.original.params?.text }}</p>
            </div>
          </div>
        </template>
        <template #nextRunAt-cell="{ row }">
          <span class="text-toned">{{ row.original.enabled ? fmtDate(row.original.nextRunAt, tenant.timezone) : '—' }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UTooltip text="Запустить сейчас"><UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-play" aria-label="Запустить сейчас" @click="runNow(row.original)" /></UTooltip>
            <UTooltip text="Удалить"><UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" aria-label="Удалить" @click="remove(row.original)" /></UTooltip>
          </div>
        </template>
      </UTable>
    </LoadState>

    <section v-if="scheduleRuns.length">
      <h2 class="mb-3 text-sm font-semibold text-highlighted">Последние запуски</h2>
      <UTimeline
        :items="scheduleRuns.map(r => ({
          title: typeOf(r.type)?.label ?? r.type,
          description: r.error || r.result?.topic || '',
          date: `${fmtDate(r.createdAt, tenant.timezone)} · ${r.payload?.manual ? 'вручную' : 'по расписанию'}`,
          icon: RUN_STATUS[r.status]?.icon,
          status: r.status,
        }))"
        size="xs"
        :ui="{ description: 'line-clamp-1' }"
        class="max-w-3xl"
      >
        <template #indicator="{ item }">
          <UIcon :name="item.icon" class="size-4" :class="RUN_STATUS[(item as any).status]?.cls" />
        </template>
      </UTimeline>
    </section>

    <UModal v-model:open="open" title="Новое расписание">
      <template #body>
        <form id="schedule-form" class="space-y-4" @submit.prevent="create">
          <UFormField label="Задача">
            <USelect v-model="form.type" :items="TYPES" class="w-full" />
          </UFormField>
          <UFormField v-if="form.type === 'site_monitor'" label="Раздел новостей" required>
            <UInput v-model="form.url" class="w-full" placeholder="https://salavatsteklo.ru/news/" required />
          </UFormField>
          <UFormField v-if="form.type === 'custom_task'" label="Что делать" required>
            <UTextarea v-model="form.text" class="w-full" :rows="3" placeholder="Пост-поздравление с началом недели" required />
          </UFormField>
          <UFormField v-if="form.type === 'auto_draft'" label="Рубрика" hint="необязательно">
            <UInput v-model="form.rubric" class="w-full" />
          </UFormField>
          <UFormField v-if="!form.inMinutes" label="Когда" :hint="tenant.timezone">
            <USelect v-model="form.preset" :items="PRESETS" class="w-full" />
          </UFormField>
          <UFormField v-if="!form.inMinutes && form.preset === 'custom'" label="cron">
            <UInput v-model="form.cron" class="w-full font-mono" placeholder="0 9 * * 1-5" required />
          </UFormField>
          <USwitch v-model="form.inMinutes" label="Тестовый запуск через 2 минуты" />
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Отмена</UButton>
          <UButton type="submit" form="schedule-form" :loading="saving">Создать</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
