<script setup lang="ts">
import { CARD_TEMPLATES } from '~~/core/image/card-templates'

const props = defineProps<{ tenantId: string }>()
const { api } = useApi()
const toast = useToast()
const tenant = inject<Ref<any>>('tenant')!
const reloadTenant = inject<() => Promise<void>>('reloadTenant')!
const saving = ref(false)
const stamp = ref(Date.now())
const templates = Object.values(CARD_TEMPLATES)
const preview = () => { stamp.value = Date.now() }

const confirm = useConfirm()
const uploading = ref('')
const photos = ref<any[] | null>(null)
const photoInput = ref<HTMLInputElement | null>(null)
const loadPhotos = async () => { photos.value = await api<any[]>(`/tenants/${props.tenantId}/photos`, { silent: true }).catch(() => []) }
onMounted(loadPhotos)
async function addPhotos(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  if (!files.length) return
  const fd = new FormData()
  for (const f of files) fd.append('file', f)
  uploading.value = 'photos'
  try {
    await api(`/tenants/${props.tenantId}/photos`, { method: 'POST', body: fd })
    toast.add({ title: `Добавлено фото: ${files.length}`, color: 'success' })
    await loadPhotos()
    preview()
  }
  catch {}
  finally { input.value = ''; uploading.value = '' }
}
function removePhoto(id: string) {
  confirm({
    title: 'Удалить фото из фотобанка?',
    action: async () => {
      await api(`/tenants/${props.tenantId}/photos/${id}`, { method: 'DELETE' })
      photos.value = photos.value?.filter(p => p.id !== id) ?? null
      preview()
    },
  })
}

const form = reactive({
  name: tenant.value.name,
  timezone: tenant.value.timezone,
  description: tenant.value.settings.description ?? '',
  tone: tenant.value.settings.tone ?? '',
  approval_rule: tenant.value.settings.approval_rule ?? 'any_one',
  daily_call_limit: tenant.value.settings.daily_call_limit ?? 80,
  image_mode: tenant.value.settings.image_mode ?? 'template',
  post_format: tenant.value.settings.post_format ?? 'rich',
  emoji_pack: tenant.value.settings.emoji_pack ? `https://t.me/addemoji/${tenant.value.settings.emoji_pack}` : '',
  emoji_in_channel: !!tenant.value.settings.emoji_in_channel,
  alert_chat_id: tenant.value.settings.alert_chat_id ?? '',
  auto_reply_comments: !!tenant.value.settings.auto_reply_comments,
  primary: tenant.value.settings.brand?.primary ?? '#196C7F',
  secondary: tenant.value.settings.brand?.secondary ?? '#285055',
})

const chatIdError = computed(() => form.alert_chat_id && !/^-?\d+$/.test(String(form.alert_chat_id).trim()) ? 'Только цифры' : undefined)
const SLOTS = [
  { slot: 'logo_light', field: 'logo_light_media_id', label: 'Логотип белый', accept: 'image/png,image/svg+xml', icon: 'i-lucide-image' },
  { slot: 'logo', field: 'logo_media_id', label: 'Логотип цветной', accept: 'image/png,image/svg+xml', icon: 'i-lucide-image' },
  { slot: 'pattern', field: 'pattern_media_id', label: 'Паттерн', accept: 'image/png,image/jpeg', icon: 'i-lucide-shapes' },
  { slot: 'font_bold', field: 'font_bold_media_id', label: 'Шрифт заголовков', accept: '.ttf,.otf,.woff', icon: 'i-lucide-type' },
  { slot: 'font_regular', field: 'font_regular_media_id', label: 'Шрифт текста', accept: '.ttf,.otf,.woff', icon: 'i-lucide-text' },
]
const hasAsset = (field: string) => !!tenant.value.settings.brand?.[field]

async function save() {
  if (saving.value || !form.name.trim() || chatIdError.value) return
  saving.value = true
  try {
    await api(`/tenants/${props.tenantId}`, {
      method: 'PATCH',
      body: {
        name: form.name.trim(), timezone: form.timezone,
        settings: {
          description: form.description, tone: form.tone, approval_rule: form.approval_rule,
          daily_call_limit: Number(form.daily_call_limit), image_mode: form.image_mode, post_format: form.post_format,
          emoji_pack: form.emoji_pack.trim() || null, emoji_in_channel: form.emoji_in_channel,
          alert_chat_id: String(form.alert_chat_id).trim() || null, auto_reply_comments: form.auto_reply_comments,
          brand: { primary: form.primary, secondary: form.secondary },
        },
      },
    })
    await reloadTenant()
    toast.add({ title: 'Сохранено', color: 'success' })
    preview()
  }
  catch {}
  finally { saving.value = false }
}

const fileInput = ref<HTMLInputElement | null>(null)
const pendingSlot = ref<(typeof SLOTS)[number] | null>(null)
function pick(s: (typeof SLOTS)[number]) {
  pendingSlot.value = s
  if (!fileInput.value) return
  fileInput.value.accept = s.accept
  fileInput.value.click()
}
async function upload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  const slot = pendingSlot.value?.slot
  if (!file || !slot) return
  const fd = new FormData()
  fd.append('slot', slot)
  fd.append('file', file)
  uploading.value = slot
  try {
    await api(`/tenants/${props.tenantId}/brand-assets`, { method: 'POST', body: fd })
    await reloadTenant()
    toast.add({ title: 'Файл загружен', color: 'success' })
    preview()
  }
  catch {}
  finally { input.value = ''; uploading.value = '' }
}

function removeAsset(s: (typeof SLOTS)[number]) {
  confirm({
    title: `Удалить «${s.label}»?`,
    action: async () => {
      await api(`/tenants/${props.tenantId}/brand-assets/${s.slot}`, { method: 'DELETE' })
      await reloadTenant()
      preview()
    },
  })
}
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
    <Teleport defer to="#panel-actions">
      <UButton type="submit" form="settings-form" :loading="saving" :disabled="!form.name.trim() || !!chatIdError" icon="i-lucide-check">Сохранить</UButton>
    </Teleport>

    <form id="settings-form" class="space-y-6" @submit.prevent="save">
      <UCard>
        <template #header><h2 class="font-semibold text-highlighted">Компания</h2></template>
        <div class="grid gap-4 md:grid-cols-2">
          <UFormField label="Название" required>
            <UInput v-model="form.name" class="w-full" maxlength="120" required />
          </UFormField>
          <UFormField label="Часовой пояс">
            <USelect v-model="form.timezone" :items="TIMEZONES" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Чем занимается" class="md:col-span-2">
            <UTextarea v-model="form.description" class="w-full" :rows="3" maxlength="2000" autoresize />
          </UFormField>
          <UFormField label="Тон" class="md:col-span-2">
            <UInput v-model="form.tone" class="w-full" maxlength="300" />
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header><h2 class="font-semibold text-highlighted">Контент и согласование</h2></template>
        <div class="grid gap-4 md:grid-cols-2">
          <UFormField label="Согласование">
            <USelect v-model="form.approval_rule" :items="[{ label: 'Достаточно одного', value: 'any_one' }, { label: 'Все согласующие', value: 'all' }]" class="w-full" />
          </UFormField>
          <UFormField label="Лимит обращений в сутки">
            <UInputNumber v-model="form.daily_call_limit" :min="0" :max="5000" :step="10" class="w-full" />
          </UFormField>
          <UFormField label="Фото для карточек">
            <USelect v-model="form.image_mode" :items="[{ label: 'Фотобанк и интернет', value: 'template' }, { label: 'Фотобанк, генерация AI, интернет', value: 'ai_background' }]" class="w-full" />
          </UFormField>
          <UFormField label="Формат новых постов">
            <USelect v-model="form.post_format" :items="[{ label: 'Журнальный: подзаголовки, списки, карусель', value: 'rich' }, { label: 'Обычный: картинка с подписью', value: 'classic' }]" class="w-full" />
          </UFormField>
          <UFormField label="Набор эмодзи" hint="t.me/addemoji/…">
            <UInput v-model="form.emoji_pack" class="w-full" placeholder="Обычные эмодзи" />
          </UFormField>
          <USwitch v-model="form.emoji_in_channel" :disabled="!form.emoji_pack.trim()" label="Значки набора в канале" description="Нужен бот с именем из Fragment" class="self-end pb-1" />
          <UFormField label="Чат уведомлений" hint="ID чата в Telegram" :error="chatIdError">
            <UInput v-model="form.alert_chat_id" class="w-full" inputmode="numeric" maxlength="20" placeholder="Общий чат сервиса" />
          </UFormField>
          <USwitch v-model="form.auto_reply_comments" label="Отвечать на комментарии без согласования" class="md:col-span-2" />
        </div>
      </UCard>

      <UCard>
        <template #header><h2 class="font-semibold text-highlighted">Фирменный стиль</h2></template>
        <div class="space-y-5">
          <div class="flex flex-wrap gap-4">
            <UFormField v-for="c in [{ key: 'primary', label: 'Основной цвет' }, { key: 'secondary', label: 'Дополнительный' }] as const" :key="c.key" :label="c.label">
              <UPopover>
                <UButton color="neutral" variant="outline" class="w-40 justify-start font-mono uppercase">
                  <span class="size-5 rounded ring-1 ring-default" :style="{ background: form[c.key] }" />
                  {{ form[c.key] }}
                </UButton>
                <template #content>
                  <UColorPicker v-model="form[c.key]" class="p-2" />
                </template>
              </UPopover>
            </UFormField>
          </div>

          <input ref="fileInput" type="file" class="hidden" @change="upload">
          <ul class="grid gap-2 sm:grid-cols-2">
            <li v-for="s in SLOTS" :key="s.slot" class="flex items-center gap-3 rounded-lg border border-default p-2.5">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-md" :class="hasAsset(s.field) ? 'bg-success/10 text-success' : 'bg-elevated text-muted'">
                <UIcon :name="hasAsset(s.field) ? 'i-lucide-check' : s.icon" class="size-4" />
              </span>
              <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ s.label }}</span>
              <UButton v-if="hasAsset(s.field)" size="sm" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Удалить: ${s.label}`" @click="removeAsset(s)" />
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-upload" :loading="uploading === s.slot" :disabled="!!uploading" @click="pick(s)">
                {{ hasAsset(s.field) ? 'Заменить' : 'Загрузить' }}
              </UButton>
            </li>
          </ul>
        </div>
      </UCard>

      <UCard :ui="{ header: 'flex items-center justify-between gap-3' }">
        <template #header>
          <h2 class="font-semibold text-highlighted">Фотобанк <span v-if="photos?.length" class="ms-1 font-normal text-muted">{{ photos.length }}</span></h2>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-image-plus" :loading="uploading === 'photos'" :disabled="!!uploading" @click="photoInput?.click()">Добавить фото</UButton>
        </template>
        <input ref="photoInput" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" @change="addPhotos">
        <div v-if="photos === null" class="grid grid-cols-4 gap-2 sm:grid-cols-6"><USkeleton v-for="i in 6" :key="i" class="aspect-square" /></div>
        <UEmpty v-else-if="!photos.length" icon="i-lucide-images" title="Фотобанк пуст" :actions="[{ label: 'Добавить фото', icon: 'i-lucide-image-plus', color: 'neutral', variant: 'outline', onClick: () => photoInput?.click() }]" />
        <ul v-else class="grid grid-cols-4 gap-2 sm:grid-cols-6">
          <li v-for="ph in photos" :key="ph.id" class="group relative">
            <img :src="ph.url" :alt="ph.title ?? ''" :title="ph.title ?? ''" loading="lazy" class="aspect-square w-full rounded-md object-cover ring-1 ring-default">
            <UButton
              size="xs" color="neutral" variant="solid" icon="i-lucide-x" aria-label="Удалить фото"
              class="absolute right-1 top-1 transition lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100" @click="removePhoto(ph.id)"
            />
          </li>
        </ul>
      </UCard>
    </form>

    <div class="xl:sticky xl:top-0 xl:self-start">
      <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Макеты карточек</p>
      <ul class="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-3">
        <li v-for="t in templates" :key="t.id">
          <img :src="`/api/v1/tenants/${tenantId}/card-preview/${t.id}?v=${stamp}`" :alt="t.name" loading="lazy" class="aspect-square w-full rounded-md bg-elevated object-cover ring-1 ring-default">
          <p class="mt-1 text-[11px] font-semibold leading-tight text-toned">{{ t.name }}</p>
        </li>
      </ul>
    </div>
  </div>
</template>
