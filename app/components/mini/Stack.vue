<script setup lang="ts">
const props = defineProps<{ items: Array<{ label: string, value: number, color: string }> }>()
const total = computed(() => props.items.reduce((a, b) => a + b.value, 0))
const parts = computed(() => props.items.filter(i => i.value > 0))
</script>

<template>
  <div>
    <div class="flex h-3 gap-[2px] overflow-hidden rounded-full bg-glass-100">
      <div v-for="p in parts" :key="p.label" class="h-full first:rounded-l-full last:rounded-r-full" :class="p.color" :style="{ width: `${p.value / total * 100}%` }" />
    </div>
    <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
      <div v-for="i in items" :key="i.label" class="flex items-center gap-2 text-meta">
        <span class="size-2.5 shrink-0 rounded-full" :class="i.color" />
        <span class="flex-1 truncate text-muted">{{ i.label }}</span>
        <span class="font-semibold tabular-nums text-highlighted">{{ i.value }}</span>
      </div>
    </div>
  </div>
</template>
