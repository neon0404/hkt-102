<script setup lang="ts">
const props = defineProps<{ post: any, img: (u: string | null) => string, fmt: (v: string | null) => string }>()
defineEmits<{ open: [] }>()

const subtitle = computed(() => props.post.status === 'draft' && !props.post.revising ? 'AI собирает факты из материалов' : (props.post.text || props.post.rubric))
const line = computed(() => {
  const p = props.post
  if (p.revising) return { text: 'На доработке · готовлю новую версию', cls: 'text-warning' }
  switch (p.status) {
    case 'in_review': return { text: `Ждёт решения${p.version_n > 1 ? ` · v${p.version_n}` : ''}${p.warnings?.length ? ' · есть замечания' : ''}`, cls: 'text-warning' }
    case 'draft': return { text: 'Готовится… 1–2 мин', cls: 'text-primary' }
    case 'approved': case 'scheduled': return { text: p.scheduled_at ? `Выйдет: ${props.fmt(p.scheduled_at)}` : 'Выйдет сразу после одобрения', cls: 'text-primary' }
    case 'publishing': return { text: 'Публикуется…', cls: 'text-primary' }
    case 'published': return { text: `Опубликован${p.published_at ? ` · ${props.fmt(p.published_at)}` : ''}`, cls: 'text-success' }
    case 'failed': return { text: p.publication_status === 'uncertain' ? 'Исход публикации неясен' : 'Ошибка публикации', cls: 'text-error' }
    case 'rejected': return { text: 'Отклонён', cls: 'text-muted' }
    default: return { text: '', cls: 'text-muted' }
  }
})
const generating = computed(() => props.post.status === 'draft' || props.post.revising)
</script>

<template>
  <button type="button" class="block w-full text-left" @click="$emit('open')">
    <MiniRow
      :image="post.image_url ? img(post.image_url) : null" :icon="post.kind === 'video_script' ? 'i-lucide-clapperboard' : 'i-lucide-file-text'"
      :tone="post.kind === 'video_script' ? 'rose' : 'brand'" tile="lg" :lines="2"
      :title="post.title || post.topic || 'Без заголовка'" :subtitle="subtitle" :meta="line.text" :meta-class="line.cls"
    >
      <span v-if="generating" class="grid size-10 shrink-0 place-items-center rounded-full bg-muted"><UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-muted" /></span>
      <span v-else-if="post.approval_id" class="inline-flex h-10 shrink-0 items-center rounded-full bg-elevated px-4 text-[0.9rem] font-semibold text-primary ring-[1.5px] ring-inset ring-petrol-200">Решить</span>
      <span v-else class="inline-flex h-10 shrink-0 items-center rounded-full bg-muted px-4 text-[0.9rem] font-semibold text-default">Открыть</span>
    </MiniRow>
  </button>
</template>
