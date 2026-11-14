<script setup lang="ts">
import { CARD_TEMPLATES, cardFields, PHOTO_SOURCE_LABELS, type CardTemplateId } from '~~/core/image/card-templates'

const props = defineProps<{ tenantId: string, post: any, version: any, editable: boolean }>()
const emit = defineEmits<{ updated: [post: any] }>()
const { api } = useApi()
const toast = useToast()

const card = computed(() => props.version?.card ?? null)
const template = computed<CardTemplateId>(() => card.value?.template ?? 'project')
const fields = computed(() => cardFields(template.value))
const form = reactive<Record<string, string>>({})
const overflow = ref<string[]>([])
const busy = ref('')
const stamp = ref(Date.now())

function resetForm() {
  for (const k of Object.keys(form)) delete form[k]
  for (const f of fields.value) form[f.key] = card.value?.fields?.[f.key] ?? ''
}
watch(() => [props.version?.id, card.value], resetForm, { immediate: true, deep: true })

const dirty = computed(() => fields.value.some(f => (form[f.key] ?? '') !== (card.value?.fields?.[f.key] ?? '')))
const missing = computed(() => fields.value.filter(f => !f.optional && !form[f.key]?.trim()).map(f => f.key))
const image = computed(() => props.version?.image_url ? `${props.version.image_url}?v=${stamp.value}` : null)
const photo = computed(() => card.value?.photo ?? null)
const tpl = computed(() => CARD_TEMPLATES[template.value])
const templates = Object.values(CARD_TEMPLATES)

async function send(body: any, what: string) {
  if (busy.value) return
  busy.value = what
  try {
    const res = await api<any>(`/tenants/${props.tenantId}/posts/${props.post.id}/card`, { method: 'POST', body })
    overflow.value = res.overflow ?? []
    stamp.value = Date.now()
    emit('updated', res.post)
    if (res.new_version) toast.add({ title: 'Новая версия отправлена на согласование', color: 'info' })
  }
  catch {}
  finally { busy.value = '' }
}

const pickTemplate = (id: CardTemplateId) => { if (id !== template.value) send({ template: id }, `tpl:${id}`) }
const nextPhoto = () => send({ photo: 'next' }, 'photo')
const saveFields = () => send({ fields: { ...form } }, 'fields')

const fileInput = ref<HTMLInputElement | null>(null)
async function upload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  await send(fd, 'upload')
  input.value = ''
}
</script>

<template>
  <section class="space-y-4">
    <div v-if="editable" class="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      <button
        v-for="t in templates" :key="t.id" type="button"
        class="group relative w-[5.5rem] shrink-0 text-left disabled:cursor-wait"
        :aria-pressed="t.id === template"
        :disabled="!!busy"
        @click="pickTemplate(t.id)"
      >
        <img
          :src="`/api/v1/tenants/${tenantId}/card-preview/${t.id}`" :alt="t.name" loading="lazy"
          class="aspect-square w-full rounded-md object-cover ring-1 transition"
          :class="t.id === template ? 'ring-2 ring-primary' : 'ring-default group-hover:ring-accented'"
        >
        <span class="mt-1 block text-[11px] font-semibold leading-tight" :class="t.id === template ? 'text-primary' : 'text-toned'">{{ t.name }}</span>
        <UIcon v-if="busy === `tpl:${t.id}`" name="i-lucide-loader-circle" class="absolute right-1.5 top-1.5 size-4 animate-spin text-white drop-shadow" />
      </button>
    </div>

    <div class="grid gap-5 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div class="space-y-2">
        <div class="relative">
          <img v-if="image" :src="image" :alt="tpl.name" class="aspect-square w-full rounded-lg object-cover shadow-sm ring-1 ring-default">
          <div v-else class="flex aspect-square w-full items-center justify-center rounded-lg bg-elevated text-muted ring-1 ring-default">
            <UIcon name="i-lucide-image" class="size-8" />
          </div>
          <div v-if="busy" class="absolute inset-0 flex items-center justify-center rounded-lg bg-default/50 backdrop-blur-[1px]">
            <UIcon name="i-lucide-loader-circle" class="size-7 animate-spin text-primary" />
          </div>
        </div>
        <template v-if="tpl.photo && editable">
          <div class="grid grid-cols-2 gap-2">
            <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-refresh-cw" block :loading="busy === 'photo'" :disabled="!!busy" @click="nextPhoto">Другое фото</UButton>
            <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-upload" block :loading="busy === 'upload'" :disabled="!!busy" @click="fileInput?.click()">Своё фото</UButton>
          </div>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="upload">
        </template>
        <p v-if="tpl.photo && photo" class="text-xs text-muted">
          {{ PHOTO_SOURCE_LABELS[photo.source as keyof typeof PHOTO_SOURCE_LABELS] }}<template v-if="photo.credit"> · {{ photo.credit }}</template>
        </p>
      </div>

      <form class="space-y-3" @submit.prevent="saveFields">
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm font-semibold text-highlighted">{{ tpl.name }}</p>
          <UBadge v-if="!card" color="neutral" variant="subtle" size="sm">Макет не сохранён</UBadge>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <UFormField
            v-for="f in fields" :key="f.key" :label="f.label" :class="f.wide ? 'col-span-2' : ''"
            :hint="`${(form[f.key] ?? '').length}/${f.max}`"
            :error="overflow.includes(f.key) ? 'Не помещается — сократите' : undefined"
            :ui="{ hint: 'tabular-nums text-dimmed' }"
          >
            <UInput
              v-model="form[f.key]" class="w-full" :maxlength="f.max" :disabled="!editable"
              :color="missing.includes(f.key) ? 'warning' : undefined" :highlight="missing.includes(f.key)"
              :placeholder="f.optional ? 'необязательно' : '—'"
            />
          </UFormField>
        </div>
        <div v-if="editable" class="flex items-center gap-2 pt-1">
          <UButton type="submit" size="sm" icon="i-lucide-check" :disabled="!dirty || !!busy" :loading="busy === 'fields'">Обновить карточку</UButton>
          <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="resetForm">Сбросить</UButton>
        </div>
      </form>
    </div>
  </section>
</template>
