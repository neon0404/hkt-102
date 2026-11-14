<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const { tenant } = useCurrentTenant()
const { loadTenants } = useTenants()
const tenantId = computed(() => String(route.params.id))
const error = ref('')

async function load() {
  error.value = ''
  try {
    const t = await api(`/tenants/${tenantId.value}`, { silent: true })
    tenant.value = t
  }
  catch (e: any) { error.value = e.message }
}
async function reload() {
  await load()
  loadTenants()
}
watch(tenantId, () => { tenant.value = null; load() }, { immediate: true })

provide('tenant', tenant)
provide('reloadTenant', reload)
</script>

<template>
  <AppPanel v-if="error || tenant?.id !== tenantId" id="tenant-loading" title="Компания">
    <UAlert v-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-circle-alert">
      <template #actions>
        <UButton size="xs" color="error" variant="outline" @click="load">Повторить</UButton>
        <UButton size="xs" color="neutral" variant="ghost" to="/">К компаниям</UButton>
      </template>
    </UAlert>
    <div v-else class="space-y-3"><USkeleton class="h-28" /><USkeleton class="h-64" /></div>
  </AppPanel>
  <NuxtPage v-else />
</template>
