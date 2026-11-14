<script setup lang="ts">
const props = defineProps<{ items: Array<{ date: string, value: number }>, unit: (n: number) => string }>()
const picked = ref<number | null>(null)
watch(() => props.items, () => { picked.value = null })
const max = computed(() => Math.max(1, ...props.items.map(i => i.value)))
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const label = (d: string) => dayFmt.format(new Date(`${d}T00:00:00Z`)).replace('.', '')
const shown = computed(() => {
  const i = picked.value ?? props.items.length - 1
  const it = props.items[i]
  return it ? { day: label(it.date), value: props.unit(it.value), today: picked.value === null } : null
})
const ticks = computed(() => {
  const n = props.items.length
  return n ? [0, Math.floor((n - 1) / 2), n - 1].map(i => ({ i, text: label(props.items[i]!.date) })) : []
})
</script>

<template>
  <div>
    <p v-if="shown" class="mb-3 flex items-baseline gap-2 text-meta text-muted">
      <span>{{ shown.today ? 'Сегодня' : shown.day }}</span>
      <span class="font-semibold text-highlighted">{{ shown.value }}</span>
    </p>
    <div class="flex h-32 items-end" :class="items.length > 14 ? 'gap-[2px]' : 'gap-1.5'">
      <button
        v-for="(it, i) in items" :key="it.date" type="button"
        class="flex h-full flex-1 items-end"
        :aria-label="`${label(it.date)}: ${unit(it.value)}`"
        @click="picked = picked === i ? null : i"
      >
        <span
          class="w-full rounded-t-[4px] transition-colors"
          :class="[
            it.value ? (picked === i || (picked === null && i === items.length - 1) ? 'bg-petrol-700' : 'bg-petrol-300') : 'bg-glass-200',
          ]"
          :style="{ height: it.value ? `${Math.max(4, it.value / max * 100)}%` : '2px' }"
        />
      </button>
    </div>
    <div class="relative mt-2 h-4 text-caption text-muted">
      <span v-for="t in ticks" :key="t.i" class="absolute" :class="t.i === 0 ? 'left-0' : t.i === items.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'">{{ t.text }}</span>
    </div>
  </div>
</template>
