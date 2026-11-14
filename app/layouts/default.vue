<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

const route = useRoute()
const { api } = useApi()
const colorMode = useColorMode()
const me = useState<string | null>('operator', () => null)
const { tenants, loadTenants } = useTenants()
const { tenant, setupDone, setupTotal } = useCurrentTenant()
const open = ref(false)

const tenantId = computed(() => route.params.id ? String(route.params.id) : null)
const current = computed(() => tenantId.value && tenant.value?.id === tenantId.value ? tenant.value : null)

onMounted(loadTenants)

const health = ref<{ status: string, worker: boolean, db: boolean } | null>(null)
async function loadHealth() {
  try { health.value = await $fetch('/api/v1/health') }
  catch { health.value = { status: 'degraded', worker: false, db: false } }
}
let healthTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => { loadHealth(); healthTimer = setInterval(loadHealth, 30000) })
onUnmounted(() => clearInterval(healthTimer))
const healthy = computed(() => health.value?.status === 'ok')
const healthLabel = computed(() => !health.value ? 'Проверка…' : healthy.value ? 'Сервис работает' : !health.value.db ? 'Нет связи с БД' : 'Worker не отвечает')

async function logout() {
  await api('/auth/logout', { method: 'POST' })
  me.value = null
  await navigateTo('/login')
}

const GROUP_LABEL = { work: 'Работа', setup: 'Настройка', system: 'Система' } as const

const nav = computed<NavigationMenuItem[][]>(() => {
  if (!current.value) {
    return [[{ label: 'Компании', icon: 'i-lucide-building-2', to: '/', exact: true, onSelect: () => { open.value = false } }]]
  }
  const id = current.value.id
  return (Object.keys(GROUP_LABEL) as Array<keyof typeof GROUP_LABEL>).map(group => [
    { label: GROUP_LABEL[group], type: 'label' as const },
    ...SECTIONS.filter(s => s.group === group).map(s => ({
      label: s.label,
      icon: s.icon,
      to: sectionPath(id, s.value),
      exact: !s.value,
      pending: s.step ? !current.value.setup?.[s.step] : false,
      onSelect: () => { open.value = false },
    })),
  ])
})

const tenantMenu = computed<DropdownMenuItem[][]>(() => [
  (tenants.value ?? []).map(t => ({
    label: t.name,
    avatar: { text: t.name[0], style: { background: tenantColor(t), color: '#fff' } },
    to: `/t/${t.id}`,
    active: t.id === tenantId.value,
    checked: t.id === tenantId.value,
    type: 'checkbox' as const,
  })),
  [
    { label: 'Все компании', icon: 'i-lucide-layout-grid', to: '/' },
    { label: 'Новая компания', icon: 'i-lucide-plus', to: '/?new=1' },
  ],
])

const userMenu = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: me.value ?? 'Оператор', avatar: { text: (me.value ?? 'О')[0]!.toUpperCase() } }],
  [{
    label: colorMode.value === 'dark' ? 'Светлая тема' : 'Тёмная тема',
    icon: colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
    onSelect: (e: Event) => { e.preventDefault(); colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark' },
  }],
  [{ label: 'Выйти', icon: 'i-lucide-log-out', color: 'error' as const, onSelect: logout }],
])

const searchGroups = computed(() => [
  ...(current.value
    ? [{
        id: 'sections',
        label: current.value.name,
        items: SECTIONS.map(s => ({ label: s.label, icon: s.icon, to: sectionPath(current.value.id, s.value) })),
      }]
    : []),
  {
    id: 'tenants',
    label: 'Компании',
    items: (tenants.value ?? []).map(t => ({
      label: t.name,
      suffix: t.timezone,
      avatar: { text: t.name[0], style: { background: tenantColor(t), color: '#fff' } },
      to: `/t/${t.id}`,
    })),
  },
])
</script>

<template>
  <UDashboardGroup unit="rem" storage="local">
    <UDashboardSidebar
      id="main"
      v-model:open="open"
      collapsible
      resizable
      :default-size="17"
      :min-size="15"
      :max-size="22"
      :collapsed-size="4.5"
      :ui="{
        root: 'bg-muted',
        content: 'bg-muted',
        header: 'h-auto px-4 pt-5 pb-4',
        body: 'gap-3 pt-1',
        footer: 'flex-col items-stretch gap-1 border-t border-default py-3',
      }"
    >
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex w-full items-center gap-3" :class="collapsed ? 'justify-center' : ''" aria-label="На главную">
          <template v-if="collapsed">
            <img src="/brand/icon.png" alt="Салаватстекло" class="h-9 w-auto dark:hidden">
            <img src="/brand/icon-white.png" alt="Салаватстекло" class="hidden h-9 w-auto dark:block">
          </template>
          <template v-else>
            <img src="/brand/logo.png" alt="Салаватстекло" class="h-11 w-auto shrink-0 dark:hidden">
            <img src="/brand/logo-white.png" alt="Салаватстекло" class="hidden h-11 w-auto shrink-0 dark:block">
            <span class="border-s border-accented ps-3 text-xs font-bold uppercase leading-tight tracking-wider text-primary">AI<br>маркетолог</span>
          </template>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UDropdownMenu :items="tenantMenu" :content="{ align: 'start', collisionPadding: 12 }" :ui="{ content: collapsed ? 'w-64' : 'w-(--reka-dropdown-menu-trigger-width) min-w-56' }">
          <UButton
            color="neutral"
            variant="outline"
            block
            :square="collapsed"
            :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
            class="bg-default py-2 data-[state=open]:bg-elevated"
            :class="collapsed ? 'justify-center' : 'justify-between'"
            :ui="{ trailingIcon: 'text-muted' }"
          >
            <span class="flex min-w-0 items-center gap-2.5">
              <span
                class="flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-bold text-white"
                :style="{ background: current ? tenantColor(current) : 'var(--ui-primary)' }"
              >
                <template v-if="current">{{ current.name[0] }}</template>
                <UIcon v-else name="i-lucide-building-2" class="size-4" />
              </span>
              <span v-if="!collapsed" class="min-w-0 text-start">
                <span class="block truncate text-sm font-semibold text-highlighted">{{ current?.name ?? 'Все компании' }}</span>
                <span class="block truncate text-xs font-medium text-toned">{{ current ? tenantStatus(current).label : `${tenants?.length ?? 0} в работе` }}</span>
              </span>
            </span>
          </UButton>
        </UDropdownMenu>

        <UDashboardSearchButton :collapsed="collapsed" label="Поиск" :kbds="['meta', 'K']" class="bg-default" />

        <NuxtLink
          v-if="current && current.status !== 'active' && !collapsed"
          :to="sectionPath(current.id, '')"
          class="block rounded-md border border-default bg-default p-3 transition hover:border-primary"
        >
          <span class="mb-2 flex items-center justify-between text-sm font-semibold text-highlighted">
            Настройка компании
            <span class="tabular-nums text-toned">{{ setupDone }} из {{ setupTotal }}</span>
          </span>
          <UProgress :model-value="setupDone" :max="setupTotal" size="sm" />
        </NuxtLink>

        <UNavigationMenu
          :items="nav"
          :collapsed="collapsed"
          orientation="vertical"
          tooltip
          popover
          :ui="{
            label: 'px-2.5 pt-4 pb-1 text-xs font-bold uppercase tracking-wider text-toned',
            link: 'py-2 text-[15px] font-medium text-highlighted hover:before:bg-accented/60 aria-[current=page]:text-white aria-[current=page]:before:bg-petrol-500',
            linkLeadingIcon: 'size-5 text-toned group-hover:text-highlighted group-aria-[current=page]:text-white',
          }"
        >
          <template #item-trailing="{ item }">
            <span v-if="(item as any).pending" class="ms-auto size-2 rounded-full bg-warning ring-2 ring-(--ui-bg-muted)" title="Не настроено" />
          </template>
        </UNavigationMenu>
      </template>

      <template #footer="{ collapsed }">
        <UTooltip :text="healthLabel" :disabled="!collapsed">
          <div class="flex items-center gap-2 px-2.5 py-1.5 text-sm font-medium" :class="[collapsed ? 'justify-center' : '', healthy ? 'text-toned' : 'text-error']">
            <span class="relative flex size-2.5">
              <span v-if="healthy" class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50" />
              <span class="relative inline-flex size-2.5 rounded-full" :class="!health ? 'bg-accented' : healthy ? 'bg-success' : 'bg-error'" />
            </span>
            <span v-if="!collapsed">{{ healthLabel }}</span>
          </div>
        </UTooltip>

        <UDropdownMenu :items="userMenu" :content="{ align: 'start', side: 'top', collisionPadding: 12 }" :ui="{ content: collapsed ? 'w-56' : 'w-(--reka-dropdown-menu-trigger-width)' }">
          <UButton
            color="neutral"
            variant="ghost"
            block
            :square="collapsed"
            :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
            :class="collapsed ? 'justify-center' : 'justify-between'"
            class="data-[state=open]:bg-elevated"
            :ui="{ trailingIcon: 'text-muted' }"
          >
            <span class="flex min-w-0 items-center gap-2.5">
              <UAvatar :text="(me ?? 'О')[0]!.toUpperCase()" size="sm" class="bg-primary text-white" :ui="{ fallback: 'text-white' }" />
              <span v-if="!collapsed" class="truncate text-sm font-medium text-highlighted">{{ me }}</span>
            </span>
          </UButton>
        </UDropdownMenu>
      </template>
    </UDashboardSidebar>

    <UDashboardSearch :groups="searchGroups" placeholder="Раздел или компания…" :color-mode="false" />

    <slot />
  </UDashboardGroup>
</template>
