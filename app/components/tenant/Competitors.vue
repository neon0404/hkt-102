<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const tenant = inject<Ref<any>>('tenant')!
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/competitors`, { silent: true }), { poll: 6000 })

const open = ref(false)
const form = reactive({ name: '', url: '', notes: '' })
const saving = ref(false)

const confirm = useConfirm()
const analyzing = ref('')

async function add() {
  if (saving.value || !form.name.trim()) return
  saving.value = true
  try {
    await api(`/tenants/${props.tenantId}/competitors`, { method: 'POST', body: { name: form.name.trim(), url: form.url.trim(), notes: form.notes.trim() } })
    toast.add({ title: 'Конкурент добавлен', color: 'success' })
    Object.assign(form, { name: '', url: '', notes: '' })
    open.value = false
    await reload(true)
  }
  catch {}
  finally { saving.value = false }
}
async function analyze(id: string) {
  if (analyzing.value) return
  analyzing.value = id
  try {
    await api(`/tenants/${props.tenantId}/competitors/${id}/analyze`, { method: 'POST' })
    toast.add({ title: 'Анализ запущен', color: 'info' })
  }
  catch {}
  finally { analyzing.value = '' }
}
function remove(c: any) {
  confirm({
    title: `Удалить конкурента «${c.name}»?`,
    action: async () => {
      await api(`/tenants/${props.tenantId}/competitors/${c.id}`, { method: 'DELETE' })
      toast.add({ title: 'Конкурент удалён', color: 'success' })
      await reload(true)
    },
  })
}
const BLOCKS = [
  { k: 'content_themes', t: 'Темы', icon: 'i-lucide-hash' },
  { k: 'strengths', t: 'Сильные стороны', icon: 'i-lucide-trending-up' },
  { k: 'gaps', t: 'Пробелы', icon: 'i-lucide-scan-search' },
  { k: 'ideas_for_us', t: 'Идеи для нас', icon: 'i-lucide-lightbulb' },
]
const host = (u: string) => { try { return new URL(u).host } catch { return u } }
</script>

<template>
  <div>
    <Teleport defer to="#panel-actions">
      <UButton icon="i-lucide-plus" @click="open = true">Конкурент</UButton>
    </Teleport>

    <LoadState :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-radar" empty-title="Конкурентов нет" @retry="reload()">
      <template #action><UButton icon="i-lucide-plus" @click="open = true">Добавить конкурента</UButton></template>
      <div class="grid gap-4 xl:grid-cols-2">
        <UCard v-for="c in data" :key="c.id" :ui="{ header: 'flex items-center gap-3' }">
          <template #header>
            <UAvatar :text="c.name[0]" size="md" class="bg-primary/10 text-primary" />
            <div class="min-w-0 flex-1">
              <h3 class="truncate font-semibold text-highlighted">{{ c.name }}</h3>
              <a v-if="c.url" :href="c.url" target="_blank" rel="noopener" class="block truncate text-xs text-muted hover:text-primary">{{ host(c.url) }}</a>
            </div>
            <UTooltip text="Обновить анализ"><UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Обновить анализ" :loading="analyzing === c.id" :disabled="!!analyzing" @click="analyze(c.id)" /></UTooltip>
            <UTooltip text="Удалить"><UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" aria-label="Удалить" @click="remove(c)" /></UTooltip>
          </template>

          <div v-if="c.analysis" class="space-y-4 text-sm">
            <p class="break-words text-default">{{ c.analysis.summary }}</p>
            <div class="grid gap-4 sm:grid-cols-2">
              <div v-for="b in BLOCKS.filter(b => c.analysis[b.k]?.length)" :key="b.k">
                <p class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted"><UIcon :name="b.icon" class="size-3.5" />{{ b.t }}</p>
                <ul class="space-y-1 text-toned">
                  <li v-for="x in c.analysis[b.k]" :key="x" class="flex gap-2"><span class="mt-2 size-1 shrink-0 rounded-full bg-primary" />{{ x }}</li>
                </ul>
              </div>
            </div>
            <p class="text-xs text-dimmed">{{ fmtDate(c.analyzedAt, tenant.timezone) }}</p>
          </div>
          <div v-else class="flex items-center gap-2 text-sm text-muted"><UIcon name="i-lucide-loader-circle" class="animate-spin" />Идёт анализ…</div>
        </UCard>
      </div>
    </LoadState>

    <UModal v-model:open="open" title="Новый конкурент">
      <template #body>
        <form id="competitor-form" class="space-y-4" @submit.prevent="add">
          <UFormField label="Название" required><UInput v-model="form.name" class="w-full" maxlength="120" required autofocus /></UFormField>
          <UFormField label="Сайт или канал"><UInput v-model="form.url" class="w-full" maxlength="500" placeholder="https://" /></UFormField>
          <UFormField label="Заметки"><UTextarea v-model="form.notes" class="w-full" :rows="3" maxlength="5000" /></UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Отмена</UButton>
          <UButton type="submit" form="competitor-form" :loading="saving" :disabled="!form.name.trim()">Добавить</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
