<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const tenant = inject<Ref<any>>('tenant')!
const { data, error, loading, reload } = useLoad(() => api(`/tenants/${props.tenantId}/analytics/summary`, { query: { days: 7 }, silent: true }), { poll: 20000 })
const { data: posts, error: postsError, reload: reloadPosts } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/posts`, { query: { limit: 6 }, silent: true }), { poll: 15000 })

const mins = (s: number) => s ? `${Math.max(1, Math.round(s / 60))} мин` : '—'
const stats = computed(() => data.value
  ? [
      { label: 'Подготовлено', value: data.value.created, icon: 'i-lucide-file-pen-line' },
      { label: 'Опубликовано', value: data.value.published, icon: 'i-lucide-send' },
      { label: 'Ждут согласования', value: data.value.waiting, icon: 'i-lucide-hourglass', accent: data.value.waiting > 0 },
      { label: 'Запланировано', value: data.value.scheduled, icon: 'i-lucide-calendar-clock' },
      { label: 'Отклонено', value: data.value.rejected, icon: 'i-lucide-ban' },
      { label: 'Время согласования', value: mins(data.value.approvals.avgApproveSec), icon: 'i-lucide-timer' },
    ]
  : [])
</script>

<template>
  <div class="space-y-6">
    <div v-if="tenant.status !== 'active'" class="overflow-hidden rounded-xl border border-default">
      <ol class="grid grid-cols-1 gap-px bg-(--ui-border) sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <li v-for="(s, i) in SETUP_STEPS" :key="s.value" class="bg-default last:sm:col-span-2 last:2xl:col-span-1">
          <NuxtLink :to="sectionPath(tenantId, s.value)" class="flex h-full items-center gap-3 px-4 py-3 transition hover:bg-elevated/50">
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              :class="tenant.setup[s.step!] ? 'bg-success/10 text-success' : 'bg-elevated text-muted'"
            >
              <UIcon v-if="tenant.setup[s.step!]" name="i-lucide-check" class="size-4" />
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span class="text-sm font-medium" :class="tenant.setup[s.step!] ? 'text-muted' : 'text-highlighted'">{{ s.label }}</span>
          </NuxtLink>
        </li>
      </ol>
    </div>

    <section>
      <div class="mb-3 flex items-baseline justify-between">
        <h2 class="text-sm font-semibold text-highlighted">За 7 дней</h2>
      </div>
      <LoadState :loading="loading" :error="error" @retry="reload()">
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-default bg-(--ui-border) md:grid-cols-3 xl:grid-cols-6">
          <div v-for="s in stats" :key="s.label" class="bg-default p-4">
            <div class="mb-3 flex items-center gap-2 text-xs text-muted">
              <UIcon :name="s.icon" class="size-4" :class="s.accent ? 'text-warning' : 'text-dimmed'" />
              {{ s.label }}
            </div>
            <p class="text-2xl font-semibold tabular-nums text-highlighted">{{ s.value }}</p>
          </div>
        </div>
        <div v-if="data" class="mt-3 grid gap-3 sm:grid-cols-2">
          <div class="flex items-center gap-4 rounded-xl border border-default p-4">
            <span class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><UIcon name="i-lucide-users-round" class="size-5" /></span>
            <div>
              <p class="text-xs text-muted">Подписчики канала</p>
              <p class="text-xl font-semibold tabular-nums text-highlighted">
                {{ data.subscribers?.toLocaleString('ru-RU') ?? '—' }}
                <span v-if="data.subscribersDelta !== null" class="text-sm font-medium" :class="data.subscribersDelta >= 0 ? 'text-success' : 'text-error'">{{ data.subscribersDelta >= 0 ? '+' : '' }}{{ data.subscribersDelta }}</span>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-4 rounded-xl border border-default p-4">
            <span class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><UIcon name="i-lucide-cpu" class="size-5" /></span>
            <div>
              <p class="text-xs text-muted">Обращения к модели</p>
              <p class="text-xl font-semibold tabular-nums text-highlighted">
                {{ data.usage.calls }}
                <span class="text-sm font-normal text-muted">· {{ (data.usage.tokensIn + data.usage.tokensOut).toLocaleString('ru-RU') }} токенов</span>
              </p>
            </div>
          </div>
        </div>
      </LoadState>
    </section>

    <TenantPerformance :tenant-id="tenantId" />

    <section>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Последние посты</h2>
        <UButton size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" :to="sectionPath(tenantId, 'posts')">Все</UButton>
      </div>
      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <div v-if="!posts && postsError" class="flex items-center justify-between gap-3 p-4 text-sm text-error">{{ postsError }}<UButton size="xs" color="error" variant="outline" @click="reloadPosts()">Повторить</UButton></div>
        <div v-else-if="!posts" class="space-y-2 p-4"><USkeleton v-for="i in 3" :key="i" class="h-10" /></div>
        <p v-else-if="!posts.length" class="p-6 text-center text-sm text-muted">Постов нет</p>
        <ul v-else class="divide-y divide-default">
          <li v-for="p in posts" :key="p.id">
            <NuxtLink :to="`${sectionPath(tenantId, 'posts')}?post=${p.id}`" class="flex items-center gap-3 px-4 py-3 transition hover:bg-elevated/50">
              <img v-if="p.image_url" :src="p.image_url" alt="" class="size-10 shrink-0 rounded-md object-cover">
              <span v-else class="flex size-10 shrink-0 items-center justify-center rounded-md bg-elevated text-dimmed"><UIcon name="i-lucide-file-text" class="size-4" /></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-highlighted">{{ p.title || p.topic }}</p>
                <p class="truncate text-xs text-muted">{{ fmtDate(p.created_at, tenant.timezone) }}<template v-if="POST_ORIGIN[p.origin]"> · {{ POST_ORIGIN[p.origin] }}</template></p>
              </div>
              <UBadge :color="statusOf(p).color" variant="subtle" size="sm">{{ statusOf(p).label }}</UBadge>
            </NuxtLink>
          </li>
        </ul>
      </UCard>
    </section>
  </div>
</template>
