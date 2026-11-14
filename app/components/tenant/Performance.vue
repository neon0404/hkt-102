<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const tenant = inject<Ref<any>>('tenant')!
const days = ref(30)
const { data, error, loading, reload } = useLoad<any>(() => api(`/tenants/${props.tenantId}/analytics/performance`, { query: { days: days.value }, silent: true }), { poll: 60000 })
watch(days, () => reload())

const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try {
    const r = await api<any>(`/tenants/${props.tenantId}/analytics/refresh`, { method: 'POST' })
    toast.add({ title: r.available ? `Обновлено постов: ${r.updated}` : 'Канал закрытый — просмотры недоступны', color: r.available ? 'success' : 'warning' })
    await reload()
  }
  catch {}
  finally { refreshing.value = false }
}

const n = (v: number | null | undefined) => v === null || v === undefined ? '—' : v.toLocaleString('ru-RU')
const kpis = computed(() => data.value
  ? [
      { label: 'Просмотры', value: n(data.value.totals.views), icon: 'i-lucide-eye' },
      { label: 'В среднем на пост', value: n(data.value.totals.avgViews), icon: 'i-lucide-gauge' },
      { label: 'Реакции', value: n(data.value.totals.reactions), icon: 'i-lucide-heart' },
      { label: 'Переходы на сайт', value: n(data.value.totals.clicks), icon: 'i-lucide-mouse-pointer-click' },
    ]
  : [])
const groups = computed(() => data.value
  ? [
      { title: 'Макеты', items: data.value.byTemplate },
      { title: 'Рубрики', items: data.value.byRubric },
      { title: 'Время выхода', items: data.value.byDaypart },
    ].filter(g => g.items.length)
  : [])
const maxOf = (items: any[]) => Math.max(1, ...items.map(i => i.avgViews ?? 0))
const top = computed(() => [...(data.value?.posts ?? [])].sort((a, b) => (b.views ?? -1) - (a.views ?? -1)).slice(0, 6))
</script>

<template>
  <section>
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-highlighted">Эффективность публикаций</h2>
      <div class="flex items-center gap-1">
        <UFieldGroup size="xs">
          <UButton v-for="d in [7, 30, 90]" :key="d" :color="days === d ? 'primary' : 'neutral'" :variant="days === d ? 'soft' : 'ghost'" @click="days = d">{{ d }} дн</UButton>
        </UFieldGroup>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="refreshing" aria-label="Обновить показатели" @click="refresh" />
      </div>
    </div>
    <LoadState :loading="loading && !data" :error="error" @retry="reload()">
      <UEmpty v-if="data && !data.posts.length" icon="i-lucide-chart-no-axes-column" title="Публикаций за период нет" variant="naked" class="rounded-xl border border-default py-8" />
      <div v-else-if="data" class="space-y-3">
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-default bg-(--ui-border) md:grid-cols-4">
          <div v-for="k in kpis" :key="k.label" class="bg-default p-4">
            <div class="mb-3 flex items-center gap-2 text-xs text-muted">
              <UIcon :name="k.icon" class="size-4 text-dimmed" />{{ k.label }}
            </div>
            <p class="text-2xl font-semibold tabular-nums text-highlighted">{{ k.value }}</p>
          </div>
        </div>

        <div class="grid gap-3 lg:grid-cols-3">
          <UCard v-for="g in groups" :key="g.title" :ui="{ body: 'p-4 sm:p-4' }">
            <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{{ g.title }}</p>
            <ul class="space-y-3">
              <li v-for="(s, i) in g.items" :key="s.key">
                <div class="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span class="truncate" :class="i === 0 && g.items.length > 1 ? 'font-semibold text-highlighted' : 'text-toned'">{{ s.label }}</span>
                  <span class="shrink-0 tabular-nums text-muted">
                    <span class="font-medium text-highlighted">{{ n(s.avgViews) }}</span>
                    <template v-if="s.clicks"> · {{ s.clicks }} перех.</template>
                  </span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-elevated">
                  <div class="h-full rounded-full" :class="i === 0 ? 'bg-primary' : 'bg-primary/40'" :style="{ width: `${Math.round(((s.avgViews ?? 0) / maxOf(g.items)) * 100)}%` }" />
                </div>
                <p class="mt-1 text-[11px] text-dimmed">{{ s.posts }} {{ s.posts === 1 ? 'пост' : s.posts < 5 ? 'поста' : 'постов' }}<template v-if="s.ctr !== null"> · CTR {{ s.ctr }}%</template></p>
              </li>
            </ul>
          </UCard>
        </div>

        <UCard :ui="{ body: 'p-0 sm:p-0' }">
          <ul class="divide-y divide-default">
            <li v-for="p in top" :key="p.postId">
              <NuxtLink :to="`${sectionPath(tenantId, 'posts')}?post=${p.postId}`" class="flex items-center gap-3 px-4 py-3 transition hover:bg-elevated/50">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-highlighted">{{ p.title }}</p>
                  <p class="truncate text-xs text-muted">{{ fmtDate(p.publishedAt, tenant.timezone) }} · {{ p.templateName ?? (p.kind === 'video_script' ? 'Видео' : '—') }}<template v-if="p.rubric"> · {{ p.rubric }}</template></p>
                </div>
                <div class="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted">
                  <span class="flex items-center gap-1"><UIcon name="i-lucide-eye" class="size-3.5" />{{ n(p.views) }}</span>
                  <span class="flex items-center gap-1"><UIcon name="i-lucide-mouse-pointer-click" class="size-3.5" />{{ p.clicks }}</span>
                </div>
              </NuxtLink>
            </li>
          </ul>
        </UCard>
      </div>
    </LoadState>
  </section>
</template>
