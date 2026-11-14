<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const route = useRoute()
const router = useRouter()
const tenant = inject<Ref<any>>('tenant')!
const status = ref('all')
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/posts`, { query: { status: status.value === 'all' ? undefined : status.value, limit: 100 }, silent: true }), { poll: 8000 })
watch(status, () => reload())

const FILTERS = [
  { label: 'Все', value: 'all' }, { label: 'На согласовании', value: 'in_review' }, { label: 'Запланированы', value: 'approved,scheduled' },
  { label: 'Опубликованы', value: 'published' }, { label: 'Черновики', value: 'draft' }, { label: 'Отклонены', value: 'rejected' }, { label: 'Ошибки', value: 'failed' },
]
const ORIGIN: Record<string, string> = { user_request: 'По запросу', schedule: 'Автономно', plan: 'По плану', operator: 'Оператор' }
const DECISION: Record<string, { label: string, color: any }> = {
  pending: { label: 'Ждёт решения', color: 'warning' }, approved: { label: 'Одобрено', color: 'success' }, rejected: { label: 'Отклонено', color: 'error' },
  changes_requested: { label: 'На доработку', color: 'info' }, superseded: { label: 'Закрыто', color: 'neutral' },
}

const columns: TableColumn<any>[] = [
  { id: 'post', header: 'Материал' },
  { accessorKey: 'origin', header: 'Источник', meta: { class: { th: 'hidden xl:table-cell', td: 'hidden xl:table-cell' } } },
  { id: 'when', header: 'Публикация' },
  { accessorKey: 'status', header: 'Статус' },
]

const openDetail = ref(false)
const detail = ref<any | null>(null)
const shownVersion = ref<any | null>(null)
const editing = ref(false)
const edit = reactive({ title: '', text: '', scheduled_at: '' })
const busy = ref('')
const timeInput = ref('')

async function show(id: string) {
  openDetail.value = true
  detail.value = null
  editing.value = false
  try {
    detail.value = await api(`/tenants/${props.tenantId}/posts/${id}`)
    shownVersion.value = detail.value.current_version
    timeInput.value = toLocalInput(detail.value.scheduled_at)
  }
  catch { openDetail.value = false }
}
onMounted(() => { if (route.query.post) show(String(route.query.post)) })
watch(openDetail, (v) => { if (!v && route.query.post) router.replace({ query: {} }) })

const toLocalInput = (v: string | null) => {
  if (!v) return ''
  const d = new Date(v)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function startEdit() {
  Object.assign(edit, { title: detail.value.current_version.title, text: detail.value.current_version.text, scheduled_at: toLocalInput(detail.value.scheduled_at) })
  editing.value = true
}
async function saveEdit() {
  busy.value = 'edit'
  try {
    const body: any = { title: edit.title, text: edit.text }
    if (edit.scheduled_at !== toLocalInput(detail.value.scheduled_at)) body.scheduled_at = edit.scheduled_at ? new Date(edit.scheduled_at).toISOString() : null
    detail.value = await api(`/tenants/${props.tenantId}/posts/${detail.value.id}`, { method: 'PATCH', body })
    shownVersion.value = detail.value.current_version
    editing.value = false
    toast.add({ title: 'Сохранено, отправлено на согласование', color: 'success' })
    await reload(true)
  }
  catch {}
  finally { busy.value = '' }
}
async function retry() {
  busy.value = 'retry'
  try {
    await api(`/tenants/${props.tenantId}/posts/${detail.value.id}/retry-publication`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } })
    toast.add({ title: 'Публикация в очереди', color: 'info' })
    setTimeout(() => show(detail.value.id), 4000)
  }
  catch {}
  finally { busy.value = '' }
}
async function markPublished() {
  busy.value = 'mark'
  try {
    detail.value = await api(`/tenants/${props.tenantId}/posts/${detail.value.id}/mark-published`, { method: 'POST', body: {} })
    await reload(true)
  }
  catch {}
  finally { busy.value = '' }
}
async function saveTime() {
  busy.value = 'time'
  try {
    detail.value = await api(`/tenants/${props.tenantId}/posts/${detail.value.id}`, { method: 'PATCH', body: { scheduled_at: timeInput.value ? new Date(timeInput.value).toISOString() : null } })
    timeInput.value = toLocalInput(detail.value.scheduled_at)
    toast.add({ title: 'Время сохранено, пост снова на согласовании', color: 'success' })
    await reload(true)
  }
  catch {}
  finally { busy.value = '' }
}
async function sendNow() {
  busy.value = 'now'
  try {
    await api(`/tenants/${props.tenantId}/posts/${detail.value.id}/publish-now`, { method: 'POST' })
    toast.add({ title: 'Публикую', color: 'info', icon: 'i-lucide-send' })
    setTimeout(() => { show(detail.value.id); reload(true) }, 5000)
  }
  catch {}
  finally { busy.value = '' }
}
async function resend() {
  busy.value = 'resend'
  try {
    detail.value = await api(`/tenants/${props.tenantId}/posts/${detail.value.id}/send-for-approval`, { method: 'POST' })
    shownVersion.value = detail.value.current_version
    toast.add({ title: 'Отправлено согласующим', color: 'success', icon: 'i-lucide-send' })
    await reload(true)
  }
  catch {}
  finally { busy.value = '' }
}
const reviewable = computed(() => detail.value && ['draft', 'in_review'].includes(detail.value.status) && !detail.value.revising)
const approved = computed(() => detail.value && ['approved', 'scheduled'].includes(detail.value.status))
function onCardUpdated(p: any) {
  detail.value = p
  shownVersion.value = p.current_version
  reload(true)
}
const editable = computed(() => detail.value && ['draft', 'in_review', 'approved', 'scheduled'].includes(detail.value.status))
const when = (p: any) => p.kind === 'video_script' ? '—' : p.scheduled_at ? fmtDate(p.scheduled_at, tenant.value.timezone) : 'После согласования'
</script>

<template>
  <div class="space-y-4">
    <UTabs v-model="status" :items="FILTERS" :content="false" variant="link" size="sm" class="-mt-2" />

    <LoadState :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-newspaper" empty-title="Постов нет" empty-text="Напишите боту задачу или включите расписание" @retry="reload()">
      <UTable
        :data="data ?? []"
        :columns="columns"
        class="rounded-xl border border-default"
        :ui="{ tr: 'cursor-pointer', td: 'py-2.5' }"
        @select="(_e: Event, row: any) => show(row.original.id)"
      >
        <template #post-cell="{ row }">
          <div class="flex items-center gap-3">
            <img v-if="row.original.image_url" :src="row.original.image_url" alt="" class="size-11 shrink-0 rounded-md object-cover">
            <span v-else class="flex size-11 shrink-0 items-center justify-center rounded-md bg-elevated text-dimmed">
              <UIcon :name="row.original.kind === 'video_script' ? 'i-lucide-clapperboard' : 'i-lucide-file-text'" class="size-4" />
            </span>
            <div class="min-w-0 max-w-xs xl:max-w-sm 2xl:max-w-xl">
              <p class="truncate font-medium text-highlighted">{{ row.original.title || row.original.topic }}</p>
              <p class="truncate text-xs text-muted">{{ row.original.text }}</p>
            </div>
          </div>
        </template>
        <template #origin-cell="{ row }">
          <p class="text-toned">{{ ORIGIN[row.original.origin] ?? row.original.origin }}</p>
          <p class="text-xs text-dimmed">{{ fmtDate(row.original.created_at, tenant.timezone) }}</p>
        </template>
        <template #when-cell="{ row }">
          <UButton v-if="row.original.url" :to="row.original.url" target="_blank" size="xs" variant="link" trailing-icon="i-lucide-arrow-up-right" class="px-0" @click.stop>Открыть</UButton>
          <span v-else class="text-toned">{{ when(row.original) }}</span>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="statusOf(row.original).color" variant="subtle">{{ statusOf(row.original).label }}</UBadge>
        </template>
      </UTable>
    </LoadState>

    <USlideover v-model:open="openDetail" :title="detail?.current_version?.title || 'Публикация'" :ui="{ content: 'sm:max-w-4xl' }">
      <template #description>
        <div v-if="detail" class="flex flex-wrap items-center gap-1.5">
          <UBadge :color="statusOf(detail).color" variant="subtle">{{ statusOf(detail).label }}</UBadge>
          <UBadge color="neutral" variant="subtle">{{ ORIGIN[detail.origin] }}</UBadge>
          <UBadge v-if="detail.rubric" color="neutral" variant="outline">{{ detail.rubric }}</UBadge>
          <span class="ms-1 text-xs text-muted">{{ detail.channel ?? 'Канал не подключён' }} · {{ detail.scheduled_at ? fmtDate(detail.scheduled_at, tenant.timezone) : 'после согласования' }}</span>
        </div>
      </template>
      <template #body>
        <div v-if="!detail" class="space-y-3"><USkeleton class="h-64" /><USkeleton class="h-24" /></div>
        <div v-else class="space-y-6">
          <UAlert v-if="detail.publication?.status === 'published'" color="success" variant="subtle" icon="i-lucide-circle-check" :title="`Опубликовано ${fmtDate(detail.publication.published_at, tenant.timezone)}`">
            <template v-if="detail.publication.url" #description>
              <a :href="detail.publication.url" target="_blank" class="underline">{{ detail.publication.url }}</a>
              <span class="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-medium tabular-nums">
                <span class="flex items-center gap-1"><UIcon name="i-lucide-eye" class="size-4" />{{ detail.publication.views ?? '—' }}</span>
                <span class="flex items-center gap-1"><UIcon name="i-lucide-heart" class="size-4" />{{ detail.publication.reactions ?? '—' }}</span>
                <span class="flex items-center gap-1"><UIcon name="i-lucide-mouse-pointer-click" class="size-4" />{{ detail.publication.clicks ?? 0 }}</span>
              </span>
              <span v-for="c in detail.copies ?? []" :key="c.url ?? c.error" class="mt-2 block">
                ВКонтакте:
                <a v-if="c.url" :href="c.url" target="_blank" class="underline">{{ c.url }}</a>
                <span v-else class="text-error">{{ c.error || 'не опубликовано' }}</span>
              </span>
            </template>
          </UAlert>
          <UAlert v-else-if="detail.status === 'failed'" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="detail.publication?.status === 'uncertain' ? 'Исход публикации неизвестен' : 'Публикация не удалась'" :description="detail.publication?.error">
            <template #actions>
              <UButton size="xs" color="error" variant="outline" :loading="busy === 'retry'" @click="retry">Повторить</UButton>
              <UButton size="xs" color="neutral" variant="outline" :loading="busy === 'mark'" @click="markPublished">Отметить опубликованным</UButton>
            </template>
          </UAlert>
          <UAlert v-else-if="detail.status === 'rejected'" color="error" variant="subtle" icon="i-lucide-ban" title="Отклонён согласующим" />

          <div v-if="editable && detail.kind === 'post'" class="flex flex-wrap items-end gap-2 rounded-xl border border-default p-3">
            <UFormField label="Время выхода" class="min-w-56 flex-1">
              <UInput v-model="timeInput" type="datetime-local" class="w-full" />
            </UFormField>
            <UButton color="neutral" variant="outline" icon="i-lucide-calendar-check" :loading="busy === 'time'" :disabled="timeInput === toLocalInput(detail.scheduled_at)" @click="saveTime">Сохранить время</UButton>
            <UButton v-if="reviewable" color="neutral" variant="outline" icon="i-lucide-send-to-back" :loading="busy === 'resend'" @click="resend">Отправить на согласование</UButton>
            <UButton icon="i-lucide-send" :loading="busy === 'now'" :disabled="!approved" @click="sendNow">Опубликовать сейчас</UButton>
          </div>

          <template v-if="shownVersion && detail.kind === 'post'">
            <TenantPostCardEditor
              v-if="shownVersion.id === detail.current_version?.id"
              :tenant-id="tenantId" :post="detail" :version="shownVersion" :editable="editable" @updated="onCardUpdated"
            />
            <img v-else-if="shownVersion.image_url" :src="shownVersion.image_url" alt="" class="w-full max-w-72 rounded-lg ring-1 ring-default">
            <TenantPostLayout
              v-if="shownVersion.id === detail.current_version?.id"
              :tenant-id="tenantId" :post="detail" :version="shownVersion" :editable="editable" @updated="onCardUpdated"
            />
          </template>
          <div v-else-if="shownVersion?.video" class="grid gap-5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <video
              v-if="shownVersion.video.url" :src="shownVersion.video.url" :poster="shownVersion.image_url ?? undefined"
              controls playsinline preload="metadata" class="aspect-9/16 w-full rounded-lg bg-black ring-1 ring-default"
            />
            <div v-else class="flex aspect-9/16 w-full items-center justify-center rounded-lg bg-elevated text-sm text-muted ring-1 ring-default">
              <UIcon name="i-lucide-clapperboard" class="size-8" />
            </div>
            <div class="space-y-3">
              <UAlert v-if="shownVersion.video.status === 'failed'" color="error" variant="subtle" icon="i-lucide-triangle-alert" title="Ролик не собран" :description="shownVersion.video.error" />
              <div>
                <h3 class="mb-1 text-sm font-semibold text-highlighted">Подпись к ролику</h3>
                <p class="whitespace-pre-line text-sm text-default">{{ shownVersion.video.caption }}</p>
              </div>
              <p class="text-xs text-muted">{{ shownVersion.video.duration_sec }} с · 720×1280</p>
            </div>
          </div>

          <div v-if="shownVersion">
            <h3 class="mb-2 text-sm font-semibold text-highlighted">{{ detail.kind === 'video_script' ? 'Сценарий' : 'Текст поста' }}</h3>
            <div>
              <form v-if="editing" class="space-y-3" @submit.prevent="saveEdit">
                <UFormField label="Заголовок"><UInput v-model="edit.title" class="w-full" maxlength="90" /></UFormField>
                <UFormField label="Текст"><UTextarea v-model="edit.text" class="w-full" :rows="10" autoresize /></UFormField>
                <div class="flex items-center gap-2 pt-1">
                  <UButton type="submit" :loading="busy === 'edit'">Сохранить и отправить</UButton>
                  <UButton color="neutral" variant="ghost" @click="editing = false">Отмена</UButton>
                </div>
              </form>
              <template v-else>
                <div v-if="shownVersion.format === 'rich' && detail.kind === 'post'" class="max-w-2xl space-y-3 text-sm leading-relaxed text-default" v-html="renderMarkdown(shownVersion.text)" />
                <p v-else class="whitespace-pre-line text-sm leading-relaxed text-default">{{ shownVersion.text }}</p>
                <p v-if="shownVersion.hashtags?.length" class="mt-2 text-sm text-primary">{{ shownVersion.hashtags.join(' ') }}</p>
                <UButton v-if="editable && shownVersion.id === detail.current_version.id" class="mt-4" size="sm" color="neutral" variant="outline" icon="i-lucide-pencil" @click="startEdit">Редактировать</UButton>
              </template>
            </div>
          </div>

          <div v-if="shownVersion?.warnings?.length" class="space-y-2">
            <UAlert v-for="w in shownVersion.warnings" :key="w" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="w" />
          </div>

          <section v-if="shownVersion?.facts?.length">
            <h3 class="mb-2 text-sm font-semibold text-highlighted">Факты</h3>
            <ul class="divide-y divide-default rounded-lg border border-default">
              <li v-for="(f, i) in shownVersion.facts" :key="i" class="flex items-start gap-2.5 px-3 py-2.5 text-sm">
                <UIcon :name="f.chunk_id ? 'i-lucide-circle-check' : 'i-lucide-circle-help'" class="mt-0.5 size-4 shrink-0" :class="f.chunk_id ? 'text-success' : 'text-warning'" />
                <div>
                  <p class="text-default">{{ f.claim }}</p>
                  <p class="text-xs" :class="f.chunk_id ? 'text-muted' : 'text-warning'">{{ f.chunk_id ? f.source_title : f.general ? 'Общеизвестный факт — сверьте' : 'Нет в материалах — проверьте' }}</p>
                </div>
              </li>
            </ul>
          </section>

          <section>
            <h3 class="mb-2 text-sm font-semibold text-highlighted">Версии</h3>
            <ul class="space-y-2">
              <li
                v-for="v in detail.versions" :key="v.id"
                class="rounded-lg border p-3 text-sm transition"
                :class="shownVersion?.id === v.id ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated/50'"
              >
                <button type="button" class="flex w-full flex-wrap items-center gap-2 text-left" @click="shownVersion = v; editing = false">
                  <span class="font-semibold text-highlighted">v{{ v.n }}</span>
                  <UBadge v-if="detail.approved_version_n === v.n" color="success" variant="subtle" size="sm">одобрена</UBadge>
                  <UBadge v-if="v.author === 'human'" color="neutral" variant="subtle" size="sm">правка</UBadge>
                  <span class="ms-auto text-xs text-dimmed">{{ v.generation_meta?.model ?? PROVIDER_NAMES[v.generation_meta?.provider] ?? '' }} · {{ fmtDate(v.created_at, tenant.timezone) }}</span>
                </button>
                <p v-if="v.comment" class="mt-1.5 text-xs text-toned">«{{ v.comment }}»</p>
                <div v-for="a in detail.approvals.filter((x: any) => x.version_n === v.n)" :key="a.id" class="mt-1.5 flex items-center gap-2 text-xs">
                  <UBadge :color="DECISION[a.decision]?.color" variant="subtle" size="sm">{{ DECISION[a.decision]?.label }}</UBadge>
                  <span class="text-toned">{{ a.member }}</span>
                  <span v-if="a.comment" class="truncate text-muted">«{{ a.comment }}»</span>
                  <span class="ms-auto shrink-0 text-dimmed">{{ fmtDate(a.decided_at || a.created_at, tenant.timezone) }}</span>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </template>
    </USlideover>
  </div>
</template>
