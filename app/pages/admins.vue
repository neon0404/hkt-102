<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

useHead({ title: 'Пользователи · AI-маркетолог' })
const { api } = useApi()
const toast = useToast()
const { data, error, loading, reload } = useLoad<any[]>(() => api('/admins', { silent: true }))

const columns: TableColumn<any>[] = [
  { id: 'user', header: 'Пользователь' },
  { accessorKey: 'tg_user_id', header: 'Telegram' },
  { accessorKey: 'created_at', header: 'Добавлен', meta: { class: { th: 'hidden sm:table-cell', td: 'hidden sm:table-cell' } } },
  { id: 'actions', meta: { class: { td: 'text-right w-0' } } },
]

const open = ref(false)
const editing = ref<any | null>(null)
const saving = ref(false)
const showPassword = ref(false)
const form = reactive({ email: '', password: '', name: '', tg_user_id: '' })

const removing = ref<any | null>(null)
const deleting = ref(false)

function openCreate() {
  editing.value = null
  Object.assign(form, { email: '', password: '', name: '', tg_user_id: '' })
  showPassword.value = false
  open.value = true
}

function openEdit(row: any) {
  editing.value = row
  Object.assign(form, { email: row.email, password: '', name: row.name ?? '', tg_user_id: row.tg_user_id ? String(row.tg_user_id) : '' })
  showPassword.value = false
  open.value = true
}

async function generate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint32Array(14))
  form.password = Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
  showPassword.value = true
  try {
    await navigator.clipboard.writeText(form.password)
    toast.add({ title: 'Пароль скопирован', color: 'success', icon: 'i-lucide-copy-check' })
  }
  catch {}
}

const tgValid = computed(() => !form.tg_user_id.trim() || /^\d+$/.test(form.tg_user_id.trim()))
const canSave = computed(() => tgValid.value && (editing.value
  ? !form.password || form.password.length >= 8
  : form.email.trim().length > 3 && form.password.length >= 8))

async function save() {
  if (saving.value || !canSave.value) return
  saving.value = true
  const tg = form.tg_user_id.trim() || null
  try {
    if (editing.value) {
      await api(`/admins/${editing.value.id}`, {
        method: 'PATCH',
        body: { name: form.name, tg_user_id: tg, ...(form.password ? { password: form.password } : {}) },
      })
      toast.add({ title: 'Изменения сохранены', color: 'success' })
    }
    else {
      await api('/admins', { method: 'POST', body: { email: form.email, password: form.password, name: form.name, tg_user_id: tg } })
      toast.add({ title: 'Пользователь добавлен', color: 'success' })
    }
    open.value = false
    await reload(true)
  }
  catch {}
  finally { saving.value = false }
}

async function remove() {
  if (!removing.value) return
  deleting.value = true
  try {
    await api(`/admins/${removing.value.id}`, { method: 'DELETE' })
    toast.add({ title: 'Пользователь удалён', color: 'success' })
    removing.value = null
    await reload(true)
  }
  catch {}
  finally { deleting.value = false }
}
</script>

<template>
  <AppPanel id="admins" title="Пользователи">
    <template #actions>
      <UButton icon="i-lucide-user-plus" @click="openCreate">Пользователь</UButton>
    </template>

    <LoadState :loading="loading" :error="error" @retry="reload()">
      <UTable v-if="data" :data="data" :columns="columns" class="rounded-xl border border-default" :ui="{ td: 'py-2.5' }">
        <template #user-cell="{ row }">
          <div class="flex items-center gap-3">
            <UAvatar :text="(row.original.name || row.original.email)[0]!.toUpperCase()" size="sm" />
            <div class="min-w-0 max-w-[16rem] sm:max-w-sm">
              <p class="flex items-center gap-2 font-medium text-highlighted">
                <span class="truncate">{{ row.original.name || row.original.email }}</span>
                <UBadge v-if="row.original.is_current" color="primary" variant="subtle" size="sm">Вы</UBadge>
              </p>
              <p v-if="row.original.name" class="truncate text-xs text-muted">{{ row.original.email }}</p>
            </div>
          </div>
        </template>
        <template #tg_user_id-cell="{ row }">
          <UBadge v-if="row.original.tg_user_id" color="success" variant="subtle" icon="i-lucide-check">Привязан</UBadge>
          <span v-else class="text-dimmed">—</span>
        </template>
        <template #created_at-cell="{ row }">
          <span class="text-muted">{{ fmtDate(row.original.created_at) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UTooltip text="Изменить">
              <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" aria-label="Изменить" @click="openEdit(row.original)" />
            </UTooltip>
            <UTooltip v-if="!row.original.is_current && data.length > 1" text="Удалить">
              <UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" aria-label="Удалить" @click="removing = row.original" />
            </UTooltip>
          </div>
        </template>
      </UTable>
    </LoadState>

    <UModal v-model:open="open" :title="editing ? 'Изменить пользователя' : 'Новый пользователь'">
      <template #body>
        <form id="admin-form" class="space-y-4" autocomplete="off" @submit.prevent="save">
          <UFormField label="Почта" :required="!editing">
            <UInput
              v-model="form.email" type="email" class="w-full" maxlength="200" placeholder="name@company.ru"
              :disabled="!!editing" :required="!editing" :autofocus="!editing" autocomplete="off"
            />
          </UFormField>
          <UFormField :label="editing ? 'Новый пароль' : 'Пароль'" :required="!editing" hint="от 8 знаков">
            <div class="flex gap-2">
              <UInput
                v-model="form.password" :type="showPassword ? 'text' : 'password'" class="min-w-0 flex-1" maxlength="200"
                :placeholder="editing ? 'Оставьте пустым, чтобы не менять' : ''" autocomplete="new-password"
                :ui="{ trailing: 'pe-1' }"
              >
                <template #trailing>
                  <UButton
                    color="neutral" variant="link" size="sm" :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    :aria-label="showPassword ? 'Скрыть пароль' : 'Показать пароль'" @click="showPassword = !showPassword"
                  />
                </template>
              </UInput>
              <UButton color="neutral" variant="outline" icon="i-lucide-wand-sparkles" @click="generate">Сгенерировать</UButton>
            </div>
          </UFormField>
          <UFormField label="Имя">
            <UInput v-model="form.name" class="w-full" maxlength="120" placeholder="Анна Петрова" :autofocus="!!editing" />
          </UFormField>
          <UFormField label="Telegram ID" :error="tgValid ? undefined : 'Только цифры'">
            <UInput v-model="form.tg_user_id" class="w-full" inputmode="numeric" maxlength="20" placeholder="123456789" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">Отмена</UButton>
          <UButton type="submit" form="admin-form" :loading="saving" :disabled="!canSave">{{ editing ? 'Сохранить' : 'Добавить' }}</UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="!!removing" title="Удалить пользователя?" @update:open="v => { if (!v) removing = null }">
      <template #body>
        <p class="text-highlighted">{{ removing?.name ? `${removing.name} · ${removing.email}` : removing?.email }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removing = null">Отмена</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="deleting" @click="remove">Удалить</UButton>
        </div>
      </template>
    </UModal>
  </AppPanel>
</template>
