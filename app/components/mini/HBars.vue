<script setup lang="ts">
const props = defineProps<{ items: Array<{ label: string, value: number, hint?: string | null }>, unit?: (n: number) => string, base?: number }>()
const max = computed(() => props.base ?? Math.max(1, ...props.items.map(i => i.value)))
</script>

<template>
  <div class="space-y-3.5">
    <div v-for="it in items" :key="it.label">
      <div class="mb-1.5 flex items-baseline justify-between gap-3">
        <span class="truncate text-body text-highlighted">{{ it.label }}</span>
        <span class="shrink-0 text-meta tabular-nums text-muted">
          <span v-if="it.hint" class="mr-1.5">{{ it.hint }}</span>
          <span class="font-semibold text-highlighted">{{ unit ? unit(it.value) : it.value }}</span>
        </span>
      </div>
      <div class="h-2 overflow-hidden rounded-full bg-glass-100">
        <div class="h-full rounded-full bg-petrol-500" :style="{ width: `${it.value ? Math.max(3, it.value / max * 100) : 0}%` }" />
      </div>
    </div>
  </div>
</template>
