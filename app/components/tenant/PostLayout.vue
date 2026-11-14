<script setup lang="ts">
const props = defineProps<{ tenantId: string, post: any, version: any, editable: boolean }>()
const emit = defineEmits<{ updated: [post: any] }>()
const { api } = useApi()
const toast = useToast()
const busy = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const photos = computed(() => props.version.gallery?.photos ?? [])
const FORMATS = [{ label: 'Журнальный', value: 'rich', icon: 'i-lucide-newspaper' }, { label: 'Обычный', value: 'classic', icon: 'i-lucide-image' }]

async function change(body: any, what: string) {
  busy.value = what
  try {
    const res = await api(`/tenants/${props.tenantId}/posts/${props.post.id}/layout`, { method: 'POST', body })
    emit('updated', res.post)
    if (res.new_version) toast.add({ title: 'Создана новая версия — отправлена на согласование', color: 'info' })
  }
  catch {}
  finally { busy.value = '' }
}
async function upload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  await change(fd, 'upload')
  input.value = ''
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <UFieldGroup>
        <UButton
          v-for="f in FORMATS" :key="f.value" :icon="f.icon" :label="f.label" size="sm"
          :color="(version.format ?? 'classic') === f.value ? 'primary' : 'neutral'" :variant="(version.format ?? 'classic') === f.value ? 'solid' : 'outline'"
          :disabled="!editable || !!busy" :loading="busy === `format-${f.value}`"
          @click="(version.format ?? 'classic') !== f.value && change({ format: f.value }, `format-${f.value}`)"
        />
      </UFieldGroup>
      <UFieldGroup v-if="version.format === 'rich' && photos.length">
        <UButton
          v-for="m in [{ label: 'Листать', value: 'slideshow' }, { label: 'Сеткой', value: 'collage' }]" :key="m.value" :label="m.label" size="sm"
          :color="(version.gallery?.mode ?? 'slideshow') === m.value ? 'primary' : 'neutral'" :variant="(version.gallery?.mode ?? 'slideshow') === m.value ? 'soft' : 'outline'"
          :disabled="!editable || !!busy" @click="change({ mode: m.value }, 'mode')"
        />
      </UFieldGroup>
    </div>
    <div class="flex flex-wrap gap-2">
      <div v-if="version.image_url" class="relative">
        <img :src="version.image_url" alt="" class="size-20 rounded-md object-cover ring-1 ring-default">
        <span class="absolute inset-x-1 bottom-1 rounded bg-black/60 text-center text-[10px] font-medium text-white">обложка</span>
      </div>
      <div v-for="p in photos" :key="p.id" class="group relative">
        <img :src="p.url" alt="" class="size-20 rounded-md object-cover ring-1 ring-default">
        <UButton
          v-if="editable" icon="i-lucide-x" size="xs" color="neutral" variant="solid" class="absolute -right-2 -top-2 rounded-full"
          aria-label="Убрать из карусели" :disabled="!!busy" @click="change({ remove: p.id }, `rm-${p.id}`)"
        />
      </div>
      <template v-if="editable && photos.length < 9">
        <button type="button" class="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-default text-xs text-muted hover:text-highlighted" :disabled="!!busy" @click="change({ gallery: 'add' }, 'add')">
          <UIcon :name="busy === 'add' ? 'i-lucide-loader-circle' : 'i-lucide-images'" class="size-5" :class="busy === 'add' && 'animate-spin'" />Фотобанк
        </button>
        <button type="button" class="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-default text-xs text-muted hover:text-highlighted" :disabled="!!busy" @click="change({ gallery: 'generate' }, 'gen')">
          <UIcon :name="busy === 'gen' ? 'i-lucide-loader-circle' : 'i-lucide-sparkles'" class="size-5" :class="busy === 'gen' && 'animate-spin'" />{{ busy === 'gen' ? '~1 мин' : 'Сгенерировать' }}
        </button>
        <button type="button" class="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-default text-xs text-muted hover:text-highlighted" :disabled="!!busy" @click="fileInput?.click()">
          <UIcon :name="busy === 'upload' ? 'i-lucide-loader-circle' : 'i-lucide-image-plus'" class="size-5" :class="busy === 'upload' && 'animate-spin'" />Загрузить
        </button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="upload">
      </template>
    </div>
  </div>
</template>
