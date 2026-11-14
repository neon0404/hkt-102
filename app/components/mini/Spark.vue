<script setup lang="ts">
const props = defineProps<{ values: Array<number | null> }>()
const path = computed(() => {
  const pts = props.values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null)
  if (pts.length < 2 || pts.every(p => !p[1])) return null
  const min = Math.min(...pts.map(p => p[1]))
  const max = Math.max(...pts.map(p => p[1]))
  const n = props.values.length - 1 || 1
  const xy = pts.map(([i, v]) => [i / n * 100, max === min ? 14 : 26 - (v - min) / (max - min) * 22])
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x!.toFixed(1)} ${y!.toFixed(1)}`).join(' ')
  return { line, area: `${line} L${xy.at(-1)![0]!.toFixed(1)} 30 L${xy[0]![0]!.toFixed(1)} 30 Z` }
})
</script>

<template>
  <svg v-if="path" viewBox="0 0 100 30" preserveAspectRatio="none" class="h-8 w-full overflow-visible text-petrol-500" aria-hidden="true">
    <path :d="path.area" fill="currentColor" opacity=".1" />
    <path :d="path.line" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>
