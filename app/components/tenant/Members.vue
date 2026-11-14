<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!
const { data, error, loading, reload } = useLoad<any>(() => api(`/tenants/${props.tenantId}/members`, { silent: true }), { poll: 5000 })

const open = ref(false)
const roles = ref<Array<'client' | 'approver'>>(['client', 'approver'])
const creating = ref(false)
const ROLE: Record<string, { label: string, icon: string }> = {
  client: { label: 'Клиент', icon: 'i-lucide-message-square-plus' },
  approver: { label: 'Согласующий', icon: 'i-lucide-stamp' },
}
const columns: TableColumn<any>[] = [
  { id: 'name', header: 'Участник' },
  { accessorKey: 'roles', header: 'Роли' },
  { accessorKey: 'created_at', header: 'Подключён', meta: { class: { th: 'hidden md:table-cell', td: 'hidden md:table-cell' } } },
  { id: 'actions', meta: { class: { td: 'text-right w-0' } } },
]

watch(() => data.value?.members.filter((m: any) => m.status === 'active').length, (n, old) => { if (n !== old && old !== undefined) reloadTenant() })

const tenant = inject<Ref<any>>('tenant')!
const confirm = useConfirm()
const dropping = ref('')

async function invite() {
  if (creating.value || !roles.value.length) return
  creating.value = true
  try {
    await api(`/tenants/${props.tenantId}/invites`, { method: 'POST', body: { roles: roles.value } })
    await reload(true)
    open.value = false
    toast.add({ title: 'Ссылка создана', color: 'success' })
  }
  catch {}
  finally { creating.value = false }
}

async function copy(link: string) {
  try {
    await navigator.clipboard.writeText(link)
    toast.add({ title: 'Скопировано', color: 'success', icon: 'i-lucide-copy-check' })
  }
  catch { toast.add({ title: 'Не удалось скопировать', color: 'error' }) }
}
async function dropInvite(id: string) {
  if (dropping.value) return
  dropping.value = id
  try {
    await api(`/tenants/${props.tenantId}/invites/${id}`, { method: 'DELETE' })
    await reload(true)
  }
  catch {}
  finally { dropping.value = '' }
}
const memberName = (m: any) => m.display_name || 'Участник'
function revoke(m: any) {
  confirm({
    title: `Отозвать доступ у «${memberName(m)}»?`,
    description: 'Открытые согласования закроются',
    confirmLabel: 'Отозвать',
    confirmIcon: 'i-lucide-user-x',
    action: async () => {
      await api(`/tenants/${props.tenantId}/members/${m.id}`, { method: 'DELETE' })
      toast.add({ title: 'Доступ отозван', color: 'success' })
      await reload(true)
      await reloadTenant()
    },
  })
}
</script>

<template>
  <div>
    <Teleport defer to="#panel-actions">
      <UButton icon="i-lucide-user-plus" @click="open = true">Пригласить</UButton>
    </Teleport>

    <LoadState :loading="loading" :error="error" @retry="reload()">
      <div v-if="data" class="space-y-6">
        <section v-if="data.invites.length">
          <h2 class="mb-3 text-sm font-semibold text-highlighted">Приглашения</h2>
          <div class="grid gap-3 lg:grid-cols-2">
            <div v-for="i in data.invites" :key="i.id" class="flex items-center gap-3 rounded-xl border border-dashed border-accented p-3">
              <UIcon name="i-lucide-link" class="size-4 shrink-0 text-primary" />
              <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-xs text-highlighted">{{ i.link }}</p>
                <p class="text-xs text-muted">{{ i.roles.map((r: string) => ROLE[r]?.label).join(', ') }} · до {{ fmtDate(i.expires_at, tenant.timezone) }}</p>
              </div>
              <UTooltip text="Копировать"><UButton size="sm" icon="i-lucide-copy" color="neutral" variant="outline" aria-label="Копировать" @click="copy(i.link)" /></UTooltip>
              <UTooltip text="Отменить"><UButton size="sm" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Отменить приглашение" :loading="dropping === i.id" :disabled="!!dropping" @click="dropInvite(i.id)" /></UTooltip>
            </div>
          </div>
        </section>

        <UEmpty v-if="!data.members.length" variant="outline" icon="i-lucide-users" title="Участников нет" class="py-12">
          <template #actions><UButton icon="i-lucide-user-plus" @click="open = true">Пригласить</UButton></template>
        </UEmpty>
        <UTable v-else :data="data.members" :columns="columns" class="rounded-xl border border-default" :ui="{ td: 'py-2.5' }">
          <template #name-cell="{ row }">
            <div class="flex items-center gap-3" :class="row.original.status !== 'active' ? 'opacity-50' : ''">
              <UAvatar :text="memberName(row.original)[0]" size="sm" />
              <div class="min-w-0">
                <p class="max-w-[14rem] truncate font-medium text-highlighted sm:max-w-xs">{{ memberName(row.original) }}</p>
                <p v-if="row.original.status !== 'active'" class="text-xs text-muted">Доступ отозван</p>
              </div>
            </div>
          </template>
          <template #roles-cell="{ row }">
            <div class="flex flex-wrap gap-1">
              <UBadge v-for="r in row.original.roles" :key="r" color="neutral" variant="subtle" :icon="ROLE[r]?.icon">{{ ROLE[r]?.label }}</UBadge>
            </div>
          </template>
          <template #created_at-cell="{ row }">
            <span class="whitespace-nowrap text-muted">{{ fmtDate(row.original.created_at, tenant.timezone) }}</span>
          </template>
          <template #actions-cell="{ row }">
            <UButton v-if="row.original.status === 'active'" size="sm" color="error" variant="ghost" icon="i-lucide-user-x" @click="revoke(row.original)">Отозвать</UButton>
          </template>
        </UTable>
      </div>
    </LoadState>

    <UModal v-model:open="open" title="Новое приглашение">
      <template #body>
        <UCheckboxGroup
          v-model="roles"
          variant="card"
          :items="[
            { value: 'client', label: 'Клиент', description: 'Ставит задачи боту' },
            { value: 'approver', label: 'Согласующий', description: 'Одобряет публикации' },
          ]"
        />
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <span class="text-xs text-muted">Одноразовая ссылка на 72 часа</span>
          <UButton icon="i-lucide-link" :loading="creating" :disabled="!roles.length" @click="invite">Создать ссылку</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
