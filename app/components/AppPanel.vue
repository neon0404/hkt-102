<script setup lang="ts">
defineProps<{ id: string, title: string, badge?: { label: string, color: any } }>()
</script>

<template>
  <UDashboardPanel :id="id">
    <template #header>
      <UDashboardNavbar :ui="{ title: 'font-display text-lg tracking-wide text-highlighted' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          {{ title }}
          <UBadge v-if="badge" :color="badge.color" variant="subtle" size="sm" class="ms-1 font-sans tracking-normal">{{ badge.label }}</UBadge>
        </template>
        <template #right>
          <slot name="actions" />
          <div id="panel-actions" class="flex items-center gap-2" />
        </template>
      </UDashboardNavbar>
      <slot name="toolbar" />
    </template>
    <template #body>
      <slot />
    </template>
  </UDashboardPanel>
</template>
