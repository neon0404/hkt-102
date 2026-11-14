<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const tenant = inject<Ref<any>>('tenant')!
const view = ref<'runs' | 'audit' | 'usage'>('runs')
const runStatus = ref('all')
const { data: runs, error: runsError, loading: runsLoading, reload: reloadRuns } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/job-runs`, { query: { status: runStatus.value === 'all' ? undefined : runStatus.value }, silent: true }), { poll: 5000 })
const { data: audit, error: auditError, loading: auditLoading, reload: reloadAudit } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/audit`, { silent: true }), { poll: 10000 })
const { data: usage, error: usageError, loading: usageLoading, reload: reloadUsage } = useLoad<any>(() => api(`/tenants/${props.tenantId}/usage`, { silent: true }), { poll: 15000 })
watch(runStatus, () => reloadRuns())

const VIEWS = [
  { label: 'Задачи', value: 'runs', icon: 'i-lucide-list-checks' },
  { label: 'Действия', value: 'audit', icon: 'i-lucide-history' },
  { label: 'Расход', value: 'usage', icon: 'i-lucide-gauge' },
]
const RUN_STATUS: Record<string, { label: string, color: any }> = {
  queued: { label: 'В очереди', color: 'neutral' }, running: { label: 'Выполняется', color: 'info' },
  succeeded: { label: 'Выполнено', color: 'success' }, failed: { label: 'Ошибка', color: 'error' }, skipped: { label: 'Пропущено', color: 'warning' },
}
const RUN_FILTER = [{ label: 'Все статусы', value: 'all' }, ...Object.entries(RUN_STATUS).map(([value, s]) => ({ label: s.label, value }))]
const JOB: Record<string, string> = {
  ingest_source: 'Обработка источника', build_brand_profile: 'Профиль бренда', handle_message: 'Сообщение в боте', revise_post: 'Доработка поста',
  auto_draft: 'Автономный черновик', weekly_plan: 'Контент-план', draft_plan_item: 'Пост по плану', weekly_report: 'Отчёт', collect_metrics: 'Метрики канала',
  site_monitor: 'Мониторинг сайта', custom_task: 'Своя задача', analyze_competitor: 'Анализ конкурента', comment_reply: 'Ответ на комментарий', publish_post: 'Публикация',
}
const ACTION: Record<string, string> = {
  'tenant.created': 'Компания создана', 'tenant.updated': 'Настройки изменены', 'source.added': 'Источник добавлен', 'source.deleted': 'Источник удалён',
  'brand_profile.requested': 'Запрошен профиль', 'brand_profile.generated': 'Профиль сформирован', 'brand_profile.edited': 'Профиль изменён', 'brand_profile.confirmed': 'Профиль подтверждён',
  'integration.connected': 'Канал подключён', 'integration.revoked': 'Канал отключён', 'invite.created': 'Приглашение создано', 'member.joined': 'Участник подключился', 'member.revoked': 'Доступ отозван',
  'schedule.created': 'Расписание создано', 'schedule.updated': 'Расписание изменено', 'schedule.deleted': 'Расписание удалено', 'schedule.run_now': 'Ручной запуск',
  'post.created': 'Пост подготовлен', 'post.revised': 'Пост доработан', 'post.edited': 'Пост исправлен', 'post.sent_for_approval': 'На согласовании', 'post.rescheduled': 'Время изменено',
  'approval.approved': 'Одобрено', 'approval.rejected': 'Отклонено', 'approval.changes_requested': 'На доработку',
  'publication.published': 'Опубликовано', 'publication.failed': 'Ошибка публикации', 'publication.uncertain': 'Исход неизвестен', 'publication.retry': 'Повтор публикации', 'publication.marked_published': 'Отмечено опубликованным',
  'access.denied': 'Отказ в доступе', 'operator.alert': 'Уведомление оператору', 'plan.created': 'План предложен', 'plan.accepted': 'План принят', 'plan.skipped': 'План отклонён',
  'provider.tested': 'Проверка модели', 'competitor.added': 'Конкурент добавлен', 'competitor.analyzed': 'Конкурент изучен', 'comment.replied': 'Ответ на комментарий', 'site_monitor.new_item': 'Новость на сайте',
}
const ACTOR: Record<string, { label: string, icon: string }> = {
  operator: { label: 'Оператор', icon: 'i-lucide-user-cog' }, member: { label: 'Участник', icon: 'i-lucide-user' },
  system: { label: 'Система', icon: 'i-lucide-server' }, ai: { label: 'AI', icon: 'i-lucide-sparkles' },
}
const OP: Record<string, string> = {
  route_message: 'Разбор сообщения', generate_post: 'Текст поста', revise_post: 'Доработка поста', pick_topic: 'Выбор темы', build_brand_profile: 'Профиль бренда',
  create_plan: 'Контент-план', generate_report: 'Отчёт', video_script: 'Сценарий видео', analyze_competitor: 'Анализ конкурента', comment_reply: 'Ответ на комментарий',
  generate_image: 'Изображение', provider_test: 'Проверка модели',
}
const num = (n: number) => n.toLocaleString('ru-RU')
const dur = (r: any) => r.finishedAt ? `${Math.max(1, Math.round((new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()) / 1000))} с` : '—'
const details = (d: Record<string, any>) => Object.entries(d ?? {}).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ')

const runColumns: TableColumn<any>[] = [
  { accessorKey: 'type', header: 'Задача' },
  { accessorKey: 'status', header: 'Статус' },
  { accessorKey: 'attempts', header: 'Попытки', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { accessorKey: 'llmCalls', header: 'Вызовы', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { id: 'duration', header: 'Время', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { accessorKey: 'createdAt', header: 'Создана' },
]
const auditColumns: TableColumn<any>[] = [
  { accessorKey: 'createdAt', header: 'Когда' },
  { accessorKey: 'actorType', header: 'Кто' },
  { accessorKey: 'action', header: 'Действие' },
  { accessorKey: 'data', header: 'Детали' },
]
const usageColumns: TableColumn<any>[] = [
  { accessorKey: 'operation', header: 'Операция' },
  { accessorKey: 'provider', header: 'Модель' },
  { accessorKey: 'calls', header: 'Вызовы', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { accessorKey: 'input_tokens', header: 'Вход', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { accessorKey: 'output_tokens', header: 'Выход', meta: { class: { th: 'text-right', td: 'text-right' } } },
  { accessorKey: 'avg_ms', header: 'Среднее', meta: { class: { th: 'text-right', td: 'text-right' } } },
]
const usageStats = computed(() => usage.value
  ? [
      { label: 'Сегодня', value: num(usage.value.calls_today), sub: `из ${usage.value.daily_call_limit}`, progress: usage.value.daily_call_limit ? usage.value.calls_today / usage.value.daily_call_limit * 100 : 0 },
      { label: 'Вызовов за 30 дней', value: num(usage.value.total.calls) },
      { label: 'Токенов', value: num(usage.value.total.input_tokens + usage.value.total.output_tokens) },
      { label: 'На опубликованный пост', value: usage.value.published_posts ? (usage.value.total.calls / usage.value.published_posts).toFixed(1) : '—' },
      { label: 'По тарифам API', value: `$${usage.value.total.cost_estimate.toFixed(2)}` },
    ]
  : [])
</script>

<template>
  <div class="space-y-4">
    <div class="-mt-2 flex flex-wrap items-center gap-3">
      <UTabs v-model="view" :items="VIEWS" :content="false" variant="link" size="sm" />
      <USelect v-if="view === 'runs'" v-model="runStatus" :items="RUN_FILTER" size="sm" class="ms-auto w-44" />
    </div>

    <LoadState v-if="view === 'runs'" :loading="runsLoading" :error="runsError" :empty="!runs?.length" empty-icon="i-lucide-list-checks" empty-title="Задач нет" @retry="reloadRuns()">
      <UTable :data="runs ?? []" :columns="runColumns" class="rounded-xl border border-default">
        <template #type-cell="{ row }">
          <div class="max-w-md">
            <p class="font-medium text-highlighted">
              {{ JOB[row.original.type] ?? row.original.type }}
              <UIcon v-if="row.original.scheduledJobId" :name="row.original.payload?.manual ? 'i-lucide-hand' : 'i-lucide-calendar-clock'" class="ms-1 size-3.5 align-[-2px] text-dimmed" />
            </p>
            <p v-if="row.original.error" class="truncate text-xs text-error" :title="row.original.error">{{ row.original.error }}</p>
          </div>
        </template>
        <template #status-cell="{ row }"><UBadge :color="RUN_STATUS[row.original.status]?.color" variant="subtle">{{ RUN_STATUS[row.original.status]?.label }}</UBadge></template>
        <template #attempts-cell="{ row }"><span class="tabular-nums text-toned">{{ row.original.attempts }}/{{ row.original.maxAttempts }}</span></template>
        <template #llmCalls-cell="{ row }"><span class="tabular-nums text-toned">{{ row.original.llmCalls }}</span></template>
        <template #duration-cell="{ row }"><span class="tabular-nums text-toned">{{ dur(row.original) }}</span></template>
        <template #createdAt-cell="{ row }"><span class="whitespace-nowrap text-muted">{{ fmtDate(row.original.createdAt, tenant.timezone) }}</span></template>
      </UTable>
    </LoadState>

    <LoadState v-else-if="view === 'audit'" :loading="auditLoading" :error="auditError" :empty="!audit?.length" empty-icon="i-lucide-history" empty-title="Журнал пуст" @retry="reloadAudit()">
      <UTable :data="audit ?? []" :columns="auditColumns" class="rounded-xl border border-default">
        <template #createdAt-cell="{ row }"><span class="whitespace-nowrap text-muted">{{ fmtDate(row.original.createdAt, tenant.timezone) }}</span></template>
        <template #actorType-cell="{ row }">
          <span class="flex items-center gap-1.5 text-toned"><UIcon :name="ACTOR[row.original.actorType]?.icon ?? 'i-lucide-circle'" class="size-4 text-dimmed" />{{ ACTOR[row.original.actorType]?.label ?? row.original.actorType }}</span>
        </template>
        <template #action-cell="{ row }">
          <span class="font-medium" :class="row.original.action === 'access.denied' ? 'text-error' : 'text-highlighted'">{{ ACTION[row.original.action] ?? row.original.action }}</span>
        </template>
        <template #data-cell="{ row }">
          <p class="max-w-md truncate text-xs text-muted" :title="JSON.stringify(row.original.data)">{{ details(row.original.data) }}</p>
        </template>
      </UTable>
    </LoadState>

    <LoadState v-else :loading="usageLoading" :error="usageError" @retry="reloadUsage()">
      <div v-if="usage" class="space-y-4">
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-default bg-(--ui-border) md:grid-cols-5">
          <div v-for="s in usageStats" :key="s.label" class="bg-default p-4">
            <p class="mb-2 text-xs text-muted">{{ s.label }}</p>
            <p class="text-2xl font-semibold tabular-nums text-highlighted">{{ s.value }} <span v-if="s.sub" class="text-sm font-normal text-muted">{{ s.sub }}</span></p>
            <UProgress v-if="s.progress !== undefined" :model-value="Math.min(100, s.progress)" size="xs" class="mt-3" :color="s.progress > 85 ? 'warning' : 'primary'" />
          </div>
        </div>
        <UTable :data="usage.by_operation" :columns="usageColumns" class="rounded-xl border border-default">
          <template #operation-cell="{ row }"><span class="font-medium text-highlighted">{{ OP[row.original.operation] ?? row.original.operation }}</span></template>
          <template #provider-cell="{ row }"><span class="text-toned">{{ PROVIDER_NAMES[row.original.provider] ?? row.original.provider }}</span></template>
          <template #calls-cell="{ row }"><span class="tabular-nums">{{ num(row.original.calls) }}</span></template>
          <template #input_tokens-cell="{ row }"><span class="tabular-nums text-toned">{{ num(row.original.input_tokens) }}</span></template>
          <template #output_tokens-cell="{ row }"><span class="tabular-nums text-toned">{{ num(row.original.output_tokens) }}</span></template>
          <template #avg_ms-cell="{ row }"><span class="tabular-nums text-toned">{{ (row.original.avg_ms / 1000).toFixed(1) }} с</span></template>
        </UTable>
      </div>
    </LoadState>
  </div>
</template>
