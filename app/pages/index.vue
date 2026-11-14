<script setup lang="ts">
const { api } = useApi()
const toast = useToast()
const route = useRoute()
const router = useRouter()
const { tenants, loadTenants } = useTenants()
const loading = ref(tenants.value === null)
const open = ref(route.query.new === '1')
const saving = ref(false)
const form = reactive({ name: '', timezone: 'Asia/Yekaterinburg', description: '', tone: 'дружелюбно, по делу, без канцелярита' })

const TIMEZONES = [
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk',
  'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka',
]

onMounted(async () => { await loadTenants(); loading.value = false })
watch(() => route.query.new, (v) => { if (v === '1') open.value = true })
watch(open, (v) => { if (!v && route.query.new) router.replace({ query: {} }) })

async function create() {
  saving.value = true
  try {
    const t = await api('/tenants', { method: 'POST', body: { name: form.name, timezone: form.timezone, settings: { description: form.description, tone: form.tone } } })
    toast.add({ title: 'Компания создана', color: 'success' })
    open.value = false
    await loadTenants()
    await navigateTo(`/t/${t.id}/sources`)
  }
  catch {}
  finally { saving.value = false }
}
const done = (t: any) => SETUP_STEPS.filter(s => t.setup?.[s.step!]).length
</script>

<template>
  <AppPanel id="tenants" title="Компании">
    <template #actions>
      <UButton icon="i-lucide-plus" @click="open = true">Компания</UButton>
    </template>

    <div v-if="loading" class="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      <USkeleton v-for="i in 3" :key="i" class="h-44 rounded-xl" />
    </div>

    <UEmpty v-else-if="!tenants?.length" variant="outline" icon="i-lucide-building-2" title="Компаний пока нет" class="py-16">
      <template #actions><UButton icon="i-lucide-plus" @click="open = true">Добавить компанию</UButton></template>
    </UEmpty>

    <div v-else class="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      <NuxtLink
        v-for="t in tenants" :key="t.id" :to="`/t/${t.id}`"
        class="group relative flex flex-col overflow-hidden rounded-xl border border-default bg-default p-5 transition hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
      >
        <span class="absolute inset-x-0 top-0 h-1" :style="{ background: tenantColor(t) }" />
        <div class="flex items-start gap-3">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold text-white" :style="{ background: tenantColor(t) }">{{ t.name[0] }}</span>
          <div class="min-w-0 flex-1">
            <h2 class="truncate text-base font-semibold text-highlighted">{{ t.name }}</h2>
            <p class="text-xs text-muted">{{ t.timezone }}</p>
          </div>
          <UBadge :color="tenantStatus(t).color" variant="subtle">{{ tenantStatus(t).label }}</UBadge>
        </div>
        <p v-if="t.settings?.description" class="mt-3 line-clamp-2 text-sm text-toned">{{ t.settings.description }}</p>
        <div class="mt-auto flex items-center gap-3 pt-5">
          <UProgress :model-value="done(t)" :max="SETUP_STEPS.length" size="xs" class="flex-1" :color="done(t) === SETUP_STEPS.length ? 'success' : 'primary'" />
          <span class="text-xs tabular-nums text-muted">{{ done(t) }}/{{ SETUP_STEPS.length }}</span>
          <UIcon name="i-lucide-arrow-right" class="size-4 text-dimmed transition group-hover:translate-x-0.5 group-hover:text-primary" />
        </div>
      </NuxtLink>
    </div>

    <UModal v-model:open="open" title="Новая компания">
      <template #body>
        <form id="tenant-form" class="space-y-4" @submit.prevent="create">
          <UFormField label="Название" required>
            <UInput v-model="form.name" class="w-full" maxlength="120" required autofocus placeholder="Салаватстекло" />
          </UFormField>
          <UFormField label="Часовой пояс">
            <USelect v-model="form.timezone" :items="TIMEZONES" class="w-full" />
          </UFormField>
          <UFormField label="Чем занимается">
            <UTextarea v-model="form.description" class="w-full" :rows="3" />
          </UFormField>
          <UFormField label="Тон">
            <UInput v-model="form.tone" class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Отмена</UButton>
          <UButton type="submit" form="tenant-form" :loading="saving">Создать</UButton>
        </div>
      </template>
    </UModal>
  </AppPanel>
</template>
