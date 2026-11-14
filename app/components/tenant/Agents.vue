<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const { data, error, loading, reload } = useLoad<any>(() => api(`/tenants/${props.tenantId}/mcp-tokens`, { silent: true }))

const open = ref(false)
const name = ref('')
const creating = ref(false)
const issued = ref<{ name: string, token: string, url: string } | null>(null)
const client = ref<'claude-code' | 'claude-desktop' | 'cursor' | 'http'>('claude-code')

const active = computed(() => (data.value?.tokens ?? []).filter((t: any) => !t.revoked_at))
const revoked = computed(() => (data.value?.tokens ?? []).filter((t: any) => t.revoked_at))

const tenant = inject<Ref<any>>('tenant')!
const confirm = useConfirm()

async function create() {
  if (creating.value || name.value.trim().length < 2) return
  creating.value = true
  try {
    issued.value = await api(`/tenants/${props.tenantId}/mcp-tokens`, { method: 'POST', body: { name: name.value.trim() } })
    name.value = ''
    open.value = false
    await reload(true)
  }
  catch {}
  finally { creating.value = false }
}
function revoke(t: any) {
  confirm({
    title: `Отозвать доступ «${t.name}»?`,
    description: 'Агент больше не сможет подключиться',
    confirmLabel: 'Отозвать',
    confirmIcon: 'i-lucide-ban',
    action: async () => {
      await api(`/tenants/${props.tenantId}/mcp-tokens/${t.id}`, { method: 'DELETE' })
      toast.add({ title: 'Доступ агента отозван', color: 'success' })
      await reload(true)
    },
  })
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: 'Скопировано', color: 'success', icon: 'i-lucide-copy-check' })
  }
  catch { toast.add({ title: 'Не удалось скопировать', color: 'error' }) }
}
const TOOL: Record<string, string> = {
  company_overview: 'Профиль компании', list_posts: 'Список постов', get_post: 'Пост целиком', create_post: 'Написать пост с AI',
  write_post: 'Добавить свой пост', revise_post: 'Доработать пост', edit_post: 'Поправить текст', set_post_layout: 'Формат и карусель',
  schedule_post: 'Время публикации', send_for_approval: 'Отправить на согласование', get_plan: 'Контент-план', create_plan: 'Составить контент-план',
  get_analytics: 'Аналитика', search_knowledge: 'Поиск по материалам', list_sources: 'Источники', add_source: 'Добавить источник',
  run_task: 'Задача словами', get_job: 'Статус задачи',
}
const toolLabel = (t: any) => TOOL[t.name] ?? String(t.description ?? '').split(/[.:(]/)[0]!.trim()

const CLIENTS = [
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Claude Desktop', value: 'claude-desktop' },
  { label: 'Cursor', value: 'cursor' },
  { label: 'HTTP', value: 'http' },
]
function snippet(url: string, token: string) {
  const header = `Bearer ${token}`
  if (client.value === 'claude-code') return `claude mcp add --transport http ai-smm ${url} --header "Authorization: ${header}"`
  const json = (v: unknown) => JSON.stringify(v, null, 2)
  if (client.value === 'claude-desktop') return json({ mcpServers: { 'ai-smm': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: header } } } })
  if (client.value === 'cursor') return json({ mcpServers: { 'ai-smm': { url, headers: { Authorization: header } } } })
  return `curl -s ${url} \\\n  -H "Authorization: ${header}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
}
</script>

<template>
  <div>
    <Teleport defer to="#panel-actions">
      <UButton icon="i-lucide-key-round" @click="open = true">Подключить агента</UButton>
    </Teleport>

    <LoadState :loading="loading" :error="error" @retry="reload()">
      <div v-if="data" class="space-y-6">
        <UCard v-if="issued" variant="subtle" :ui="{ body: 'space-y-4' }">
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-shield-check" class="mt-0.5 size-5 shrink-0 text-success" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-highlighted">Токен «{{ issued.name }}» создан</p>
              <p class="text-sm text-muted">Показывается один раз</p>
            </div>
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" aria-label="Закрыть" @click="issued = null" />
          </div>
          <div class="flex items-center gap-2 rounded-lg bg-default p-2 ring-1 ring-default">
            <code class="min-w-0 flex-1 truncate px-1 font-mono text-sm text-highlighted">{{ issued.token }}</code>
            <UButton icon="i-lucide-copy" size="sm" color="neutral" variant="outline" @click="copy(issued.token)">Копировать</UButton>
          </div>
          <UTabs v-model="client" :items="CLIENTS" :content="false" size="sm" variant="link" />
          <div class="relative">
            <pre class="overflow-x-auto rounded-lg bg-default p-3 pr-12 font-mono text-xs leading-relaxed text-highlighted ring-1 ring-default">{{ snippet(issued.url, issued.token) }}</pre>
            <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" class="absolute right-2 top-2" aria-label="Копировать настройки" @click="copy(snippet(issued.url, issued.token))" />
          </div>
        </UCard>

        <section>
          <div class="mb-3 flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold text-highlighted">Адрес сервера</h2>
          </div>
          <div class="flex items-center gap-2 rounded-xl border border-default p-3">
            <UIcon name="i-lucide-plug-zap" class="size-4 shrink-0 text-primary" />
            <code class="min-w-0 flex-1 truncate font-mono text-sm text-highlighted">{{ data.url }}</code>
            <UButton size="sm" icon="i-lucide-copy" color="neutral" variant="outline" aria-label="Копировать адрес" @click="copy(data.url)" />
          </div>
        </section>

        <section>
          <h2 class="mb-3 text-sm font-semibold text-highlighted">Подключения</h2>
          <UEmpty v-if="!active.length" variant="outline" icon="i-lucide-bot" title="Агентов нет" class="py-10">
            <template #actions><UButton icon="i-lucide-key-round" @click="open = true">Подключить агента</UButton></template>
          </UEmpty>
          <div v-else class="divide-y divide-default rounded-xl border border-default">
            <div v-for="t in active" :key="t.id" class="flex items-center gap-3 p-3">
              <UAvatar icon="i-lucide-bot" size="sm" />
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium text-highlighted">{{ t.name }}</p>
                <p class="text-xs text-muted">
                  Выпущен {{ fmtDate(t.created_at, tenant.timezone) }} ·
                  {{ t.last_used_at ? `последний запрос ${fmtDate(t.last_used_at, tenant.timezone)}` : 'ещё не подключался' }}
                </p>
              </div>
              <UButton size="sm" color="error" variant="ghost" icon="i-lucide-ban" @click="revoke(t)">Отозвать</UButton>
            </div>
          </div>
          <p v-if="revoked.length" class="mt-2 text-xs text-muted">Отозвано: {{ revoked.map((t: any) => t.name).join(', ') }}</p>
        </section>

        <section>
          <h2 class="mb-3 text-sm font-semibold text-highlighted">Что умеет агент</h2>
          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div v-for="t in data.tools" :key="t.name" class="flex items-center gap-3 rounded-xl border border-default p-3" :title="t.description">
              <UIcon :name="t.read_only ? 'i-lucide-eye' : 'i-lucide-pencil-line'" class="size-4 shrink-0" :class="t.read_only ? 'text-muted' : 'text-primary'" />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-highlighted">{{ toolLabel(t) }}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </LoadState>

    <UModal v-model:open="open" title="Подключить агента">
      <template #body>
        <form id="token-form" @submit.prevent="create">
          <UFormField label="Название подключения" required>
            <UInput v-model="name" placeholder="Claude маркетолога" maxlength="60" autofocus class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-xs text-muted">Доступ только к этой компании</span>
          <UButton type="submit" form="token-form" icon="i-lucide-key-round" :loading="creating" :disabled="name.trim().length < 2">Выпустить токен</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
