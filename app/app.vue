<script setup lang="ts">
import { ru } from '@nuxt/ui/locale'

const route = useRoute()
const mini = computed(() => route.path === '/app')
</script>

<template>
  <UApp
    :locale="ru"
    :portal="mini ? '#phone-portal' : true"
    :toaster="mini ? { position: 'top-center', duration: 3000 } : { position: 'bottom-right' }"
    :tooltip="{ delayDuration: 200 }"
  >
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
