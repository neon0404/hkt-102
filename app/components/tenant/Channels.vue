<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/integrations`, { silent: true }))
const { data: system } = useLoad<any>(() => api('/system/providers', { silent: true }))

const open = ref(false)
const form = reactive({ channel: '', bot_token: '', token: '' })
const platform = ref<'telegram' | 'vk'>('telegram')
const PLATFORMS = [{ label: 'Telegram', value: 'telegram', icon: 'i-lucide-send' }, { label: 'ВКонтакте', value: 'vk', icon: 'i-lucide-users' }]
function openFor(p: 'telegram' | 'vk') { platform.value = p; open.value = true }
const ownBot = ref(false)
const saving = ref(false)
const checking = ref('')
const botName = computed(() => system.value?.bot?.username ? `@${system.value.bot.username}` : 'бота сервиса')

async function connect() {
  saving.value = true
  try {
    await api(`/tenants/${props.tenantId}/integrations`, { method: 'POST', body: platform.value === 'vk'
      ? { platform: 'vk', channel: form.channel, token: form.token }
      : { platform: 'telegram', channel: form.channel, bot_token: ownBot.value ? form.bot_token : null } })
    toast.add({ title: platform.value === 'vk' ? 'Сообщество подключено' : 'Канал подключён', color: 'success' })
    Object.assign(form, { channel: '', bot_token: '', token: '' })
    open.value = false
    await reload(true)
    await reloadTenant()
  }
  catch {}
  finally { saving.value = false }
}

async function check(id: string) {
  checking.value = id
  try {
    const res = await api(`/tenants/${props.tenantId}/integrations/${id}/check`, { method: 'POST' })
    toast.add(res.status === 'active' ? { title: 'Доступ есть', color: 'success' } : { title: res.error || 'Нет доступа к каналу', color: 'error' })
    await reload(true)
    await reloadTenant()
  }
  finally { checking.value = '' }
}

async function revoke(id: string) {
  await api(`/tenants/${props.tenantId}/integrations/${id}`, { method: 'DELETE' })
  toast.add({ title: 'Канал отключён', color: 'success' })
  await reload(true)
  await reloadTenant()
}
</script>

<template>
  <div>
    <Teleport defer to="#panel-actions">
      <UButton icon="i-lucide-plus" @click="openFor('telegram')">Канал</UButton>
    </Teleport>

    <LoadState :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-send" empty-title="Каналов нет" @retry="reload()">
      <template #action>
        <div class="flex gap-2">
          <UButton icon="i-lucide-send" @click="openFor('telegram')">Telegram-канал</UButton>
          <UButton icon="i-lucide-users" color="neutral" variant="outline" @click="openFor('vk')">Сообщество ВК</UButton>
        </div>
      </template>
      <div class="grid gap-4 xl:grid-cols-2">
        <UCard v-for="i in data" :key="i.id">
          <div class="flex items-start gap-4">
            <span v-if="i.platform === 'vk'" class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#0077FF]/10 text-[#0077FF] text-sm font-black">VK</span>
            <span v-else class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#2AABEE]/10 text-[#2AABEE]"><UIcon name="i-lucide-send" class="size-5" /></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="truncate font-semibold text-highlighted">{{ i.title || i.externalId }}</p>
                <UBadge :color="i.status === 'active' ? 'success' : 'error'" variant="subtle" size="sm">{{ i.status === 'active' ? 'Подключён' : 'Нет доступа' }}</UBadge>
              </div>
              <p v-if="i.platform === 'vk'" class="text-sm text-muted">vk.com/{{ i.username || `club${i.externalId}` }} · копия постов из Telegram</p>
              <p v-else class="text-sm text-muted">{{ i.username ? `@${i.username}` : `ID ${i.externalId}` }} · {{ i.own_bot ? 'свой бот' : `@${i.meta?.bot ?? system?.bot?.username}` }}</p>
              <p v-if="i.error" class="mt-1 text-sm text-error">{{ i.error }}</p>
              <p class="mt-1 text-xs text-dimmed">Проверен {{ fmtDate(i.checkedAt) }}</p>
            </div>
          </div>
          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plug-zap" :loading="checking === i.id" @click="check(i.id)">Проверить</UButton>
              <UButton size="sm" color="error" variant="ghost" icon="i-lucide-unplug" @click="revoke(i.id)">Отключить</UButton>
            </div>
          </template>
        </UCard>
      </div>
    </LoadState>

    <UModal v-model:open="open" :title="platform === 'vk' ? 'Сообщество ВКонтакте' : 'Telegram-канал'">
      <template #body>
        <UTabs v-model="platform" :items="PLATFORMS" :content="false" size="sm" class="mb-5" />
        <template v-if="platform === 'vk'">
          <ol class="mb-5 space-y-2.5 text-sm">
            <li v-for="(s, n) in ['Администратор сообщества получает ключ доступа с правами wall, photos, groups, offline', 'Вставьте ссылку на сообщество и ключ']" :key="n" class="flex items-center gap-3">
              <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{{ n + 1 }}</span>
              <span class="text-default">{{ s }}</span>
            </li>
          </ol>
          <form id="channel-form" class="space-y-4" @submit.prevent="connect">
            <UFormField label="Сообщество" hint="ссылка или ID">
              <UInput v-model="form.channel" class="w-full" placeholder="vk.com/salavatsteklo" required autofocus />
            </UFormField>
            <UFormField label="Ключ доступа">
              <UInput v-model="form.token" type="password" class="w-full" autocomplete="off" placeholder="vk1.a.…" required />
            </UFormField>
          </form>
        </template>
        <ol v-else class="mb-5 space-y-2.5 text-sm">
          <li v-for="(s, n) in [`Добавьте ${botName} в администраторы канала`, 'Оставьте ему только право «Публикация сообщений»']" :key="n" class="flex items-center gap-3">
            <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{{ n + 1 }}</span>
            <span class="text-default">{{ s }}</span>
          </li>
        </ol>
        <form v-if="platform === 'telegram'" id="channel-form" class="space-y-4" @submit.prevent="connect">
          <UFormField label="Канал" hint="@username или ID">
            <UInput v-model="form.channel" class="w-full" placeholder="@salavatsteklo" required autofocus />
          </UFormField>
          <USwitch v-model="ownBot" label="Публиковать от своего бота" />
          <UFormField v-if="ownBot" label="Токен бота">
            <UInput v-model="form.bot_token" type="password" class="w-full" autocomplete="off" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Отмена</UButton>
          <UButton type="submit" form="channel-form" :loading="saving" icon="i-lucide-plug">Подключить</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
