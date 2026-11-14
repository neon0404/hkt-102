<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/sources`, { silent: true }), { poll: 4000 })

const open = ref(false)
const mode = ref<'url' | 'file' | 'text'>('url')
const saving = ref(false)
const form = reactive({ urls: '', title: '', text: '' })
const file = ref<File | null>(null)

const MODES = [
  { label: 'Ссылки', value: 'url', icon: 'i-lucide-globe' },
  { label: 'Файл', value: 'file', icon: 'i-lucide-file-text' },
  { label: 'Текст', value: 'text', icon: 'i-lucide-type' },
]
const STATUS: Record<string, { label: string, color: any }> = {
  pending: { label: 'В очереди', color: 'neutral' }, processing: { label: 'Обработка', color: 'info' },
  ready: { label: 'Готов', color: 'success' }, failed: { label: 'Ошибка', color: 'error' },
}
const KIND: Record<string, { label: string, icon: string }> = {
  url: { label: 'Страница', icon: 'i-lucide-globe' }, file: { label: 'Файл', icon: 'i-lucide-file-text' }, text: { label: 'Текст', icon: 'i-lucide-type' },
}
const columns: TableColumn<any>[] = [
  { id: 'source', header: 'Источник' },
  { accessorKey: 'status', header: 'Статус' },
  { accessorKey: 'chunks_count', header: 'Фрагменты', meta: { class: { th: 'hidden md:table-cell text-right', td: 'hidden md:table-cell text-right' } } },
  { id: 'actions', meta: { class: { td: 'text-right w-0' } } },
]

watch(() => data.value?.some(s => s.status === 'ready'), (v, old) => { if (v && !old) reloadTenant() })

const urlList = computed(() => form.urls.split(/\s+/).map(u => u.trim()).filter(Boolean))
const urlsError = computed(() => urlList.value.length > 20 ? 'Не больше 20 адресов' : undefined)
const canSubmit = computed(() => mode.value === 'url'
  ? urlList.value.length > 0 && !urlsError.value
  : mode.value === 'text' ? !!form.text.trim() : !!file.value)

async function submit() {
  if (saving.value || !canSubmit.value) return
  saving.value = true
  try {
    if (mode.value === 'url') {
      const res = await api(`/tenants/${props.tenantId}/sources`, { method: 'POST', body: { urls: urlList.value } })
      const failed = res.results.filter((r: any) => !r.ok)
      for (const f of failed) toast.add({ title: f.error, description: f.uri, color: 'warning' })
      if (failed.length === res.results.length) return
      toast.add({ title: `Добавлено: ${res.results.length - failed.length}`, color: 'success' })
    }
    else if (mode.value === 'text') {
      await api(`/tenants/${props.tenantId}/sources`, { method: 'POST', body: { kind: 'text', title: form.title.trim(), text: form.text } })
      toast.add({ title: 'Текст добавлен', color: 'success' })
    }
    else {
      if (!file.value) return
      const fd = new FormData()
      fd.append('file', file.value)
      if (form.title.trim()) fd.append('title', form.title.trim())
      await api(`/tenants/${props.tenantId}/sources`, { method: 'POST', body: fd })
      toast.add({ title: 'Файл добавлен', color: 'success' })
    }
    open.value = false
    Object.assign(form, { urls: '', title: '', text: '' })
    file.value = null
    await reload(true)
  }
  catch {}
  finally { saving.value = false }
}

const confirm = useConfirm()
const reprocessing = ref('')
async function reprocess(id: string) {
  if (reprocessing.value) return
  reprocessing.value = id
  try {
    await api(`/tenants/${props.tenantId}/sources/${id}/reprocess`, { method: 'POST' })
    await reload(true)
  }
  catch {}
  finally { reprocessing.value = '' }
}
function remove(s: any) {
  confirm({
    title: 'Удалить источник?',
    description: s.title || s.uri || undefined,
    action: async () => {
      await api(`/tenants/${props.tenantId}/sources/${s.id}`, { method: 'DELETE' })
      toast.add({ title: 'Источник удалён', color: 'success' })
      await reload(true)
      await reloadTenant()
    },
  })
}
</script>

<template>
  <div>
    <Teleport defer to="#panel-actions">
      <UButton icon="i-lucide-plus" @click="open = true">Источник</UButton>
    </Teleport>

    <LoadState :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-library" empty-title="Источников нет" @retry="reload()">
      <template #action><UButton icon="i-lucide-plus" @click="open = true">Добавить источник</UButton></template>
      <UTable :data="data ?? []" :columns="columns" class="rounded-xl border border-default" :ui="{ td: 'py-2.5' }">
        <template #source-cell="{ row }">
          <div class="flex items-center gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"><UIcon :name="KIND[row.original.kind]?.icon ?? 'i-lucide-file'" class="size-4" /></span>
            <div class="min-w-0 max-w-[14rem] sm:max-w-xs lg:max-w-md 2xl:max-w-xl">
              <p class="truncate font-medium text-highlighted" :title="row.original.title || row.original.uri">{{ row.original.title || row.original.uri }}</p>
              <a v-if="row.original.kind === 'url'" :href="row.original.uri" target="_blank" rel="noopener" class="block truncate text-xs text-muted hover:text-primary">{{ row.original.uri }}</a>
              <p v-else class="text-xs text-muted">{{ KIND[row.original.kind]?.label }}</p>
              <p v-if="row.original.error" class="truncate text-xs text-error" :title="row.original.error">{{ row.original.error }}</p>
            </div>
          </div>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="STATUS[row.original.status]?.color ?? 'neutral'" variant="subtle" :icon="row.original.status === 'processing' ? 'i-lucide-loader-circle' : undefined" :ui="{ leadingIcon: 'animate-spin' }">{{ STATUS[row.original.status]?.label }}</UBadge>
        </template>
        <template #chunks_count-cell="{ row }">
          <span class="tabular-nums text-toned">{{ row.original.chunks_count || '—' }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UTooltip v-if="row.original.status === 'failed'" text="Повторить"><UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Повторить" :loading="reprocessing === row.original.id" :disabled="!!reprocessing" @click="reprocess(row.original.id)" /></UTooltip>
            <UTooltip text="Удалить"><UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" aria-label="Удалить" @click="remove(row.original)" /></UTooltip>
          </div>
        </template>
      </UTable>
    </LoadState>

    <UModal v-model:open="open" title="Новый источник">
      <template #body>
        <UTabs v-model="mode" :items="MODES" :content="false" class="mb-4" />
        <form id="source-form" class="space-y-4" @submit.prevent="submit">
          <UFormField v-if="mode === 'url'" label="Адреса страниц" hint="по одному в строке, до 20" :error="urlsError">
            <UTextarea v-model="form.urls" class="w-full" :rows="5" placeholder="https://salavatsteklo.ru/about/" required autofocus />
          </UFormField>
          <template v-else-if="mode === 'file'">
            <UFileUpload v-model="file" accept=".pdf,.docx,.txt,.md" label="Перетащите файл" description="PDF, DOCX, TXT, MD · до 20 МБ" icon="i-lucide-upload" class="min-h-36 w-full" />
            <UFormField label="Название"><UInput v-model="form.title" class="w-full" maxlength="200" /></UFormField>
          </template>
          <template v-else>
            <UFormField label="Название"><UInput v-model="form.title" class="w-full" maxlength="200" placeholder="О компании" /></UFormField>
            <UFormField label="Текст" hint="до 50 000 знаков"><UTextarea v-model="form.text" class="w-full" :rows="8" maxlength="50000" required /></UFormField>
          </template>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Отмена</UButton>
          <UButton type="submit" form="source-form" :loading="saving" :disabled="!canSubmit">Добавить</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
