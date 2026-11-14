<script setup lang="ts">
export interface Day { key: string, w: string, n: number, dots: string[], today?: boolean }
defineProps<{ days: Day[], selected?: string }>()
defineEmits<{ select: [d: Day] }>()
const DOT: Record<string, string> = { published: 'bg-green-500', planned: 'bg-primary', idea: 'bg-warning' }
</script>

<template>
  <div class="select-none rounded-card bg-elevated p-3 pb-3.5">
    <div class="grid grid-cols-7 gap-1">
      <button
        v-for="d in days" :key="d.key" type="button"
        class="flex flex-col items-center gap-1 rounded-tile-sm py-2.5 transition active:scale-95"
        :class="(selected ? selected === d.key : d.today) && 'bg-muted'"
        @click="$emit('select', d)"
      >
        <span class="text-meta text-muted">{{ d.w }}</span>
        <span class="text-lg font-semibold leading-none" :class="d.today ? 'text-primary' : 'text-highlighted'">{{ d.n }}</span>
        <span class="mt-1.5 flex h-2 items-center gap-[3px]">
          <span v-for="(s, i) in d.dots.slice(0, 3)" :key="i" class="size-2 rounded-full" :class="DOT[s]" />
          <span v-if="!d.dots.length" class="h-0.5 w-2.5 rounded-full bg-accented" />
        </span>
      </button>
    </div>
    <div class="mt-2 flex justify-center gap-4 text-caption text-muted">
      <span class="flex items-center gap-1.5"><span class="size-2 rounded-full bg-green-500" />вышел</span>
      <span class="flex items-center gap-1.5"><span class="size-2 rounded-full bg-primary" />в плане</span>
      <span class="flex items-center gap-1.5"><span class="size-2 rounded-full bg-warning" />идея</span>
    </div>
  </div>
</template>
