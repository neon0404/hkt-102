<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const tenant = inject<Ref<any>>('tenant')!
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!
const { data, error, loading, reload } = useLoad<any>(() => api('/system/providers', { silent: true }))

const selected = ref<string>(tenant.value.settings.provider ?? 'default')
const saving = ref(false)
const testing = ref('')
const results = reactive<Record<string, any>>({})

const ICON: Record<string, string> = { chatgpt_account: 'i-lucide-user-round-check', api: 'i-lucide-key-round', mock: 'i-lucide-flask-conical' }
const options = computed(() => [
  { label: `По умолчанию · ${PROVIDER_NAMES[data.value?.default_provider] ?? '…'}`, value: 'default', icon: 'i-lucide-settings' },
  { label: 'Аккаунт ChatGPT', value: 'chatgpt_account', icon: ICON.chatgpt_account },
  { label: 'API-ключ', value: 'api', icon: ICON.api },
  { label: 'Заглушка', value: 'mock', icon: ICON.mock },
])
const dirty = computed(() => selected.value !== (tenant.value.settings.provider ?? 'default'))

async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  try {
    await api(`/tenants/${props.tenantId}`, { method: 'PATCH', body: { settings: { provider: selected.value === 'default' ? null : selected.value } } })
    await reloadTenant()
    toast.add({ title: 'Модель применена', color: 'success' })
  }
  catch {}
  finally { saving.value = false }
}

async function test(name: string) {
  testing.value = name
  try { results[name] = await api(`/tenants/${props.tenantId}/provider-test`, { method: 'POST', body: { provider: name } }) }
  catch (e: any) { results[name] = { ok: false, error: e.message } }
  finally { testing.value = '' }
}
</script>

<template>
  <LoadState :loading="loading" :error="error" @retry="reload()">
    <div v-if="data" class="space-y-6">
      <UCard>
        <div class="flex flex-wrap items-end gap-3">
          <UFormField label="Модель компании" class="min-w-0 flex-1 sm:min-w-72">
            <USelect v-model="selected" :items="options" class="w-full" />
          </UFormField>
          <UButton :loading="saving" :disabled="!dirty" icon="i-lucide-check" @click="save">Применить</UButton>
        </div>
      </UCard>

      <div class="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        <UCard
          v-for="p in data.providers" :key="p.name"
          :class="tenant.provider_effective === p.name ? 'ring-2 ring-primary' : ''"
          :ui="{ body: 'space-y-4' }"
        >
          <div class="flex items-center gap-3">
            <span class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><UIcon :name="ICON[p.name] ?? 'i-lucide-bot'" class="size-5" /></span>
            <div class="min-w-0 flex-1">
              <h3 class="font-semibold text-highlighted">{{ PROVIDER_NAMES[p.name] ?? p.label }}</h3>
              <p class="truncate text-xs text-muted">{{ p.model }}</p>
            </div>
            <UBadge v-if="tenant.provider_effective === p.name" color="primary" variant="subtle">Активна</UBadge>
            <UBadge v-else :color="p.ready ? 'success' : 'neutral'" variant="subtle">{{ p.ready ? 'Готова' : 'Не настроена' }}</UBadge>
          </div>

          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-muted">Статус</dt><dd class="min-w-0 break-words text-toned">{{ p.status }}</dd>
            <dt class="text-muted">Оплата</dt><dd class="text-toned">{{ p.billing }}</dd>
          </dl>

          <UButton block size="sm" color="neutral" variant="outline" icon="i-lucide-play" :loading="testing === p.name" :disabled="!!testing" @click="test(p.name)">Проверить</UButton>

          <div v-if="results[p.name]" class="rounded-lg p-3 text-sm" :class="results[p.name].ok ? 'bg-success/10' : 'bg-error/10'">
            <template v-if="results[p.name].ok">
              <p class="break-words font-medium text-highlighted">«{{ results[p.name].answer }}»</p>
              <p class="mt-1 text-xs text-muted">{{ (results[p.name].duration_ms / 1000).toFixed(1) }} с · {{ results[p.name].input_tokens }} + {{ results[p.name].output_tokens }} токенов</p>
            </template>
            <p v-else class="break-words text-error">{{ results[p.name].error }}</p>
          </div>
        </UCard>
      </div>
    </div>
  </LoadState>
</template>
