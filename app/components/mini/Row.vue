<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  subtitle?: string | null
  meta?: string | null
  metaClass?: string
  icon?: string
  text?: string
  image?: string | null
  tone?: string
  spin?: boolean
  tile?: 'sm' | 'md' | 'lg'
  lines?: 0 | 1 | 2
}>(), { tile: 'sm', lines: 1 })
</script>

<template>
  <div class="flex items-center" :class="tile === 'lg' ? 'gap-4' : 'gap-3.5'">
    <MiniIconTile :icon="icon" :text="text" :image="image" :tone="tone" :spin="spin" :size="tile" />
    <div class="min-w-0 flex-1">
      <p class="text-heading font-semibold text-highlighted" :class="{ 1: 'truncate', 2: 'line-clamp-2 [overflow-wrap:anywhere]', 0: '[overflow-wrap:anywhere]' }[lines]">{{ title }}</p>
      <p v-if="subtitle" class="mt-0.5 text-meta text-muted" :class="lines === 0 ? '[overflow-wrap:anywhere]' : 'truncate'">{{ subtitle }}</p>
      <p v-if="meta" class="mt-0.5 truncate text-meta font-medium" :class="metaClass ?? 'text-muted'">{{ meta }}</p>
      <slot name="below" />
    </div>
    <slot />
  </div>
</template>
