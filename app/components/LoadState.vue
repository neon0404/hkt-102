<script setup lang="ts">
defineProps<{ loading: boolean, error: string, empty?: boolean, emptyTitle?: string, emptyText?: string, emptyIcon?: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="loading" class="space-y-2">
    <USkeleton class="h-11" /><USkeleton class="h-11" /><USkeleton class="h-11" />
  </div>
  <UAlert v-else-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-circle-alert">
    <template #actions>
      <UButton size="xs" color="error" variant="outline" @click="$emit('retry')">Повторить</UButton>
    </template>
  </UAlert>
  <UEmpty v-else-if="empty" variant="outline" :icon="emptyIcon || 'i-lucide-inbox'" :title="emptyTitle" :description="emptyText" class="py-12">
    <template v-if="$slots.action" #actions><slot name="action" /></template>
  </UEmpty>
  <slot v-else />
</template>
