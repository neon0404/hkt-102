<script setup lang="ts">
definePageMeta({ layout: 'blank' })
useHead({ title: 'Вход · AI-маркетолог' })
const { api } = useApi()
const me = useState<string | null>('operator', () => null)
const form = reactive({ email: '', password: '' })
const loading = ref(false)
const error = ref('')

async function submit() {
  loading.value = true
  error.value = ''
  try {
    const res = await api<{ email: string }>('/auth/login', { method: 'POST', body: form, silent: true })
    me.value = res.email
    await navigateTo('/')
  }
  catch (e: any) { error.value = e.message }
  finally { loading.value = false }
}
</script>

<template>
  <div class="grid min-h-svh bg-default lg:grid-cols-[1.1fr_1fr]">
    <aside class="brand-sidebar relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
      <img src="/brand/logo-white.png" alt="Салаватстекло" class="relative z-10 h-16 w-auto self-start">
      <img src="/brand/pattern-2.png" alt="" aria-hidden="true" class="pointer-events-none absolute -right-28 -top-28 w-[28rem] max-w-none select-none">
      <div class="relative z-10 max-w-sm">
        <p class="font-display text-4xl leading-tight text-white">AI-маркетолог</p>
        <p class="mt-3 text-base text-white/70">Контент, согласование и публикации группы компаний</p>
      </div>
    </aside>

    <main class="flex items-center justify-center p-6">
      <div class="w-full max-w-sm">
        <img src="/brand/logo.png" alt="Салаватстекло" class="mb-10 h-14 w-auto lg:hidden">
        <h1 class="font-display text-2xl text-highlighted">Вход</h1>
        <p class="mb-8 mt-1 text-sm text-muted">Панель оператора</p>
        <form class="space-y-4" @submit.prevent="submit">
          <UFormField label="E-mail">
            <UInput v-model="form.email" type="email" autocomplete="username" size="lg" class="w-full" icon="i-lucide-mail" required autofocus />
          </UFormField>
          <UFormField label="Пароль">
            <UInput v-model="form.password" type="password" autocomplete="current-password" size="lg" class="w-full" icon="i-lucide-lock" required />
          </UFormField>
          <UAlert v-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-circle-alert" />
          <UButton type="submit" block size="lg" :loading="loading">Войти</UButton>
        </form>
      </div>
    </main>
  </div>
</template>
