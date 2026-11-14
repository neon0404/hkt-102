<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string
  description?: string
  confirmLabel?: string
  confirmIcon?: string
  color?: 'error' | 'primary'
  action?: () => Promise<unknown>
}>(), { confirmLabel: 'Удалить', confirmIcon: undefined, color: 'error', description: undefined, action: undefined })
const emit = defineEmits<{ close: [ok: boolean] }>()
const busy = ref(false)

async function confirm() {
  if (busy.value) return
  if (!props.action) return emit('close', true)
  busy.value = true
  try {
    await props.action()
    emit('close', true)
  }
  catch {}
  finally { busy.value = false }
}
</script>

<template>
  <UModal :title="title" :description="description" :dismissible="!busy" :close="false" :ui="{ footer: 'justify-end' }">
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="busy" @click="emit('close', false)">Отмена</UButton>
      <UButton :color="color" :icon="confirmIcon" :loading="busy" autofocus @click="confirm">{{ confirmLabel }}</UButton>
    </template>
  </UModal>
</template>
