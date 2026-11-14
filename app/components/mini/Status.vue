<script setup lang="ts">
const props = defineProps<{ post: any }>()
type Color = 'primary' | 'success' | 'warning' | 'error' | 'neutral'
const MAP: Record<string, { label: string, color: Color, icon: string }> = {
  generating: { label: 'Готовится', color: 'primary', icon: 'i-lucide-loader-circle' },
  revising: { label: 'На доработке', color: 'warning', icon: 'i-lucide-pencil' },
  in_review: { label: 'На согласовании', color: 'warning', icon: 'i-lucide-hourglass' },
  approved: { label: 'Одобрен', color: 'primary', icon: 'i-lucide-calendar-check' },
  scheduled: { label: 'Запланирован', color: 'primary', icon: 'i-lucide-calendar-check' },
  publishing: { label: 'Публикуется', color: 'primary', icon: 'i-lucide-send' },
  published: { label: 'Опубликован', color: 'success', icon: 'i-lucide-circle-check' },
  rejected: { label: 'Отклонён', color: 'neutral', icon: 'i-lucide-ban' },
  failed: { label: 'Ошибка', color: 'error', icon: 'i-lucide-triangle-alert' },
  uncertain: { label: 'Исход неясен', color: 'warning', icon: 'i-lucide-circle-help' },
}
const key = computed(() => {
  const p = props.post
  if (p.revising) return 'revising'
  if (p.status === 'draft') return 'generating'
  if (p.status === 'failed' && (p.publication_status ?? p.publication?.status) === 'uncertain') return 'uncertain'
  return p.status
})
const TEXT: Record<Color, string> = { primary: 'text-primary', success: 'text-success', warning: 'text-warning', error: 'text-error', neutral: 'text-muted' }
const s = computed(() => MAP[key.value] ?? MAP.in_review!)
</script>

<template>
  <span class="inline-flex h-9 items-center gap-1.5 rounded-full bg-elevated px-3.5 text-meta font-semibold shadow-sm ring-1 ring-black/5" :class="TEXT[s.color]">
    <UIcon :name="s.icon" class="size-4" :class="key === 'generating' && 'animate-spin'" />
    {{ s.label }}
  </span>
</template>
