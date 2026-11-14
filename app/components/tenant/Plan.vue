<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/plan-items`, { silent: true }), { poll: 15000 })

const STATUS: Record<string, { label: string, color: any }> = {
  idea: { label: 'Предложена', color: 'neutral' }, accepted: { label: 'Принята', color: 'info' },
  drafted: { label: 'Пост готов', color: 'success' }, skipped: { label: 'Пропущена', color: 'neutral' },
}
const byDate = computed(() => {
  const groups = new Map<string, any[]>()
  for (const item of data.value ?? []) groups.set(item.date, [...(groups.get(item.date) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
})
const day = (d: string) => {
  const date = new Date(`${d}T12:00:00`)
  return {
    num: date.getDate(),
    month: new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(date).replace('.', ''),
    weekday: new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(date),
  }
}

const busy = ref('')
async function setStatus(item: any, status: string) {
  if (busy.value) return
  busy.value = `${item.id}:${status}`
  try {
    await api(`/tenants/${props.tenantId}/plan-items/${item.id}`, { method: 'PATCH', body: { status } })
    await reload(true)
  }
  catch {}
  finally { busy.value = '' }
}
</script>

<template>
  <LoadState
    :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-calendar-days"
    empty-title="Плана нет" @retry="reload()"
  >
    <template #action>
      <UButton color="neutral" variant="outline" icon="i-lucide-calendar-clock" :to="sectionPath(tenantId, 'automation')">Расписание</UButton>
    </template>
    <div class="space-y-6">
      <section v-for="[date, items] in byDate" :key="date" class="grid gap-3 md:grid-cols-[7rem_1fr]">
        <div class="flex items-baseline gap-2 md:block">
          <p class="font-display text-3xl leading-none text-highlighted">{{ day(date).num }}</p>
          <p class="text-sm text-muted md:mt-1">{{ day(date).month }}, <span class="capitalize">{{ day(date).weekday }}</span></p>
        </div>
        <div class="divide-y divide-default rounded-xl border border-default">
          <div v-for="item in items" :key="item.id" class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4" :class="item.status === 'skipped' ? 'opacity-50' : ''">
            <span class="w-12 font-mono text-sm tabular-nums text-muted">{{ item.time }}</span>
            <div class="min-w-0 flex-1">
              <p class="break-words font-medium text-highlighted">{{ item.topic }}</p>
              <p v-if="item.rubric" class="text-sm text-muted">{{ item.rubric }}</p>
            </div>
            <UBadge :color="STATUS[item.status]?.color ?? 'neutral'" variant="subtle">{{ STATUS[item.status]?.label ?? 'Тема' }}</UBadge>
            <UButton v-if="item.status === 'drafted' && item.postId" size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" :to="`${sectionPath(tenantId, 'posts')}?post=${item.postId}`">Пост</UButton>
            <div v-if="item.status === 'idea' || item.status === 'accepted'" class="flex gap-1">
              <UButton v-if="item.status === 'idea'" size="xs" icon="i-lucide-check" :loading="busy === `${item.id}:accepted`" :disabled="!!busy" @click="setStatus(item, 'accepted')">Принять</UButton>
              <UButton size="xs" color="neutral" variant="ghost" :loading="busy === `${item.id}:skipped`" :disabled="!!busy" @click="setStatus(item, 'skipped')">Пропустить</UButton>
            </div>
            <UButton v-else-if="item.status === 'skipped'" size="xs" color="neutral" variant="ghost" :loading="busy === `${item.id}:idea`" :disabled="!!busy" @click="setStatus(item, 'idea')">Вернуть</UButton>
          </div>
        </div>
      </section>
    </div>
  </LoadState>
</template>
