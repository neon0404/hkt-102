<script setup lang="ts">
const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const tenant = inject<Ref<any>>('tenant')!
const { data, error, loading, reload } = useLoad<any[]>(() => api(`/tenants/${props.tenantId}/comments`, { silent: true }), { poll: 10000 })

const STATUS: Record<string, { label: string, color: any }> = {
  new: { label: 'Новый', color: 'warning' }, drafted: { label: 'Ответ на согласовании', color: 'info' },
  replied: { label: 'Отвечено', color: 'success' }, ignored: { label: 'Без ответа', color: 'neutral' },
}
const SENTIMENT: Record<string, { label: string, icon: string, cls: string }> = {
  positive: { label: 'Позитив', icon: 'i-lucide-smile', cls: 'text-success' },
  neutral: { label: 'Нейтрально', icon: 'i-lucide-meh', cls: 'text-muted' },
  negative: { label: 'Негатив', icon: 'i-lucide-frown', cls: 'text-error' },
  question: { label: 'Вопрос', icon: 'i-lucide-circle-help', cls: 'text-info' },
  spam: { label: 'Спам', icon: 'i-lucide-shield-alert', cls: 'text-dimmed' },
}
</script>

<template>
  <div>
    <Teleport defer to="#panel-actions">
      <UBadge :color="tenant.settings.auto_reply_comments ? 'success' : 'neutral'" variant="subtle" :icon="tenant.settings.auto_reply_comments ? 'i-lucide-bot' : 'i-lucide-user-check'">
        {{ tenant.settings.auto_reply_comments ? 'Автоответ' : 'Ответ после согласования' }}
      </UBadge>
    </Teleport>

    <LoadState :loading="loading" :error="error" :empty="!data?.length" empty-icon="i-lucide-messages-square" empty-title="Комментариев нет" @retry="reload()">
      <div class="mx-auto max-w-3xl space-y-3">
        <article v-for="c in data" :key="c.id" class="rounded-xl border border-default p-4">
          <header class="mb-2 flex items-center gap-2.5">
            <UAvatar :text="(c.authorName || 'П')[0]" size="sm" />
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold text-highlighted">{{ c.authorName || 'Подписчик' }}</p>
              <p class="text-xs text-dimmed">{{ fmtDate(c.createdAt, tenant.timezone) }}</p>
            </div>
            <UTooltip v-if="c.sentiment && SENTIMENT[c.sentiment]" :text="SENTIMENT[c.sentiment]!.label">
              <UIcon :name="SENTIMENT[c.sentiment]!.icon" class="size-4" :class="SENTIMENT[c.sentiment]!.cls" />
            </UTooltip>
            <UBadge class="ms-auto" :color="STATUS[c.status]?.color" variant="subtle" size="sm">{{ STATUS[c.status]?.label }}</UBadge>
          </header>
          <p class="text-sm text-default">{{ c.text }}</p>
          <div v-if="c.replyDraft" class="mt-3 flex gap-2.5 rounded-lg bg-elevated/60 p-3 text-sm">
            <UIcon name="i-lucide-corner-down-right" class="mt-0.5 size-4 shrink-0 text-primary" />
            <p class="text-toned">{{ c.replyDraft }}</p>
          </div>
        </article>
      </div>
    </LoadState>
  </div>
</template>
