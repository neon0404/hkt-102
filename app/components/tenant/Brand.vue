<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const tenant = inject<Ref<any>>('tenant')!
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!

const state = ref<any | null>(null)
const error = ref('')
const loading = ref(true)
const busy = ref('')
const form = ref<any | null>(null)
const dirty = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function load(resetForm = true) {
  try {
    const res = await api(`/tenants/${props.tenantId}/brand-profile`, { silent: true })
    const changed = res.current?.version !== state.value?.current?.version
    state.value = res
    error.value = ''
    if (res.current && (resetForm || changed) && !dirty.value) {
      form.value = JSON.parse(JSON.stringify({ strategy: '', ...res.current.data }))
    }
  }
  catch (e: any) { error.value = e.message }
  finally { loading.value = false }
}
onMounted(() => { load(); timer = setInterval(() => { if (generating.value) load(false) }, 4000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

const generating = computed(() => ['queued', 'running'].includes(state.value?.last_job?.status))
const jobFailed = computed(() => state.value?.last_job?.status === 'failed' ? state.value.last_job.error : '')
watch(form, () => { dirty.value = true }, { deep: true })
watch(() => state.value?.current?.version, () => nextTick(() => { dirty.value = false }))

async function generate() {
  busy.value = 'generate'
  try {
    await api(`/tenants/${props.tenantId}/brand-profile/generate`, { method: 'POST' })
    toast.add({ title: 'Формирую профиль', color: 'info' })
    dirty.value = false
    await load(false)
  }
  catch {}
  finally { busy.value = '' }
}

async function save(confirm = false) {
  busy.value = confirm ? 'confirm' : 'save'
  try {
    if (dirty.value || !confirm) {
      await api(`/tenants/${props.tenantId}/brand-profile`, { method: 'PUT', body: form.value })
      dirty.value = false
    }
    if (confirm) {
      await api(`/tenants/${props.tenantId}/brand-profile/confirm`, { method: 'POST' })
      toast.add({ title: 'Профиль подтверждён', color: 'success' })
      await reloadTenant()
    }
    else toast.add({ title: 'Черновик сохранён', color: 'success' })
    await load(true)
    nextTick(() => { dirty.value = false })
  }
  catch {}
  finally { busy.value = '' }
}

const LISTS = [
  { key: 'products', label: 'Продукты и услуги' }, { key: 'audiences', label: 'Аудитории' }, { key: 'advantages', label: 'Преимущества' },
  { key: 'rubrics', label: 'Рубрики' }, { key: 'forbidden', label: 'Запреты' }, { key: 'required_phrases', label: 'Обязательные формулировки' },
]
const statusBadge = computed(() => {
  if (!state.value?.current) return null
  if (dirty.value) return { label: 'Не сохранено', color: 'warning' }
  return state.value.current.status === 'confirmed'
    ? { label: `Подтверждён · v${state.value.current.version}`, color: 'success' }
    : { label: `Черновик · v${state.value.current.version}`, color: 'warning' }
})
</script>

<template>
  <LoadState :loading="loading" :error="error" @retry="load()">
    <UEmpty
      v-if="!state?.current"
      variant="outline"
      :icon="generating ? 'i-lucide-loader-circle' : 'i-lucide-sparkles'"
      :title="generating ? 'Изучаю материалы компании…' : 'Профиля ещё нет'"
      :description="!tenant.setup.sources ? 'Сначала добавьте источники' : undefined"
      :ui="{ avatar: generating ? 'animate-spin' : '' }"
      class="py-14"
    >
      <template #actions>
        <UAlert v-if="jobFailed" color="error" variant="subtle" :title="jobFailed" class="mb-2 max-w-md text-start" />
        <UButton v-if="!tenant.setup.sources" color="neutral" variant="outline" :to="sectionPath(tenantId, 'sources')">К источникам</UButton>
        <UButton v-else icon="i-lucide-sparkles" :loading="generating || busy === 'generate'" @click="generate">Сформировать профиль</UButton>
      </template>
    </UEmpty>

    <div v-else-if="form" class="space-y-4">
      <Teleport defer to="#panel-actions">
        <UBadge v-if="statusBadge" :color="statusBadge.color" variant="subtle" class="hidden sm:inline-flex">{{ statusBadge.label }}</UBadge>
        <UTooltip text="Сформировать заново">
          <UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Сформировать заново" :loading="generating || busy === 'generate'" @click="generate" />
        </UTooltip>
        <UButton color="neutral" variant="outline" :loading="busy === 'save'" :disabled="!dirty" @click="save(false)">Сохранить</UButton>
        <UButton icon="i-lucide-check" :loading="busy === 'confirm'" :disabled="state.current.status === 'confirmed' && !dirty" @click="save(true)">Подтвердить</UButton>
      </Teleport>

      <UAlert v-if="state.confirmed && state.current.status !== 'confirmed'" color="info" variant="subtle" icon="i-lucide-info" :title="`В работе версия ${state.confirmed.version}`" />
      <UAlert v-if="jobFailed" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="jobFailed" />

      <div class="grid gap-4 xl:grid-cols-2">
        <UCard>
          <div class="space-y-4">
            <UFormField label="Описание компании"><UTextarea v-model="form.description" class="w-full" :rows="5" autoresize /></UFormField>
            <UFormField label="Тон коммуникации"><UTextarea v-model="form.tone" class="w-full" :rows="3" autoresize /></UFormField>
            <UFormField label="Стратегия"><UTextarea v-model="form.strategy" class="w-full" :rows="5" autoresize placeholder="Цели, акценты, частота публикаций" /></UFormField>
          </div>
        </UCard>
        <UCard>
          <div class="space-y-4">
            <UFormField v-for="l in LISTS" :key="l.key" :label="l.label">
              <UInputTags v-model="form[l.key]" class="w-full" placeholder="Добавить…" />
            </UFormField>
          </div>
        </UCard>
      </div>

      <UCard :ui="{ body: 'p-0 sm:p-0', header: 'flex items-center justify-between' }">
        <template #header>
          <h3 class="font-semibold text-highlighted">Факты <span class="ms-1 font-normal text-muted">{{ form.facts.length }}</span></h3>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" @click="form.facts.push({ claim: '', chunk_id: null })">Факт</UButton>
        </template>
        <ul class="divide-y divide-default">
          <li v-for="(f, i) in form.facts" :key="i" class="group flex items-start gap-3 px-4 py-2.5">
            <UIcon :name="f.chunk_id && state.fact_sources[f.chunk_id] ? 'i-lucide-book-open-check' : 'i-lucide-pencil-line'" class="mt-2.5 size-4 shrink-0" :class="f.chunk_id && state.fact_sources[f.chunk_id] ? 'text-success' : 'text-warning'" />
            <div class="min-w-0 flex-1">
              <UInput v-model="f.claim" class="w-full" variant="ghost" :ui="{ base: 'px-0 text-highlighted' }" />
              <p v-if="f.chunk_id && state.fact_sources[f.chunk_id]" class="truncate text-xs text-muted" :title="state.fact_sources[f.chunk_id].excerpt">
                {{ state.fact_sources[f.chunk_id].title }}
              </p>
              <p v-else class="text-xs text-warning">Без источника</p>
            </div>
            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Убрать факт" class="opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100" @click="form.facts.splice(i, 1)" />
          </li>
        </ul>
      </UCard>
    </div>
  </LoadState>
</template>
