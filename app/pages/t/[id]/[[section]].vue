<script setup lang="ts">
import type { Component } from 'vue'
import TenantOverview from '~/components/tenant/Overview.vue'
import TenantPosts from '~/components/tenant/Posts.vue'
import TenantPlan from '~/components/tenant/Plan.vue'
import TenantComments from '~/components/tenant/Comments.vue'
import TenantCompetitors from '~/components/tenant/Competitors.vue'
import TenantSources from '~/components/tenant/Sources.vue'
import TenantBrand from '~/components/tenant/Brand.vue'
import TenantChannels from '~/components/tenant/Channels.vue'
import TenantMembers from '~/components/tenant/Members.vue'
import TenantAutomation from '~/components/tenant/Automation.vue'
import TenantSettings from '~/components/tenant/Settings.vue'
import TenantAi from '~/components/tenant/Ai.vue'
import TenantLog from '~/components/tenant/Log.vue'
import TenantAgents from '~/components/tenant/Agents.vue'

const VIEWS: Record<string, Component> = {
  '': TenantOverview, posts: TenantPosts, plan: TenantPlan, comments: TenantComments, competitors: TenantCompetitors,
  sources: TenantSources, brand: TenantBrand, channels: TenantChannels, members: TenantMembers, automation: TenantAutomation,
  profile: TenantSettings, ai: TenantAi, log: TenantLog, agents: TenantAgents,
}
const LEGACY: Record<string, string> = { overview: '', settings: 'profile', market: 'competitors' }

const route = useRoute()
const tenantId = computed(() => String(route.params.id))
const section = computed(() => String(route.params.section ?? ''))
const meta = computed(() => SECTIONS.find(s => s.value === section.value))
const { tenant } = useCurrentTenant()

if (route.query.tab) {
  const tab = String(route.query.tab)
  await navigateTo(sectionPath(tenantId.value, LEGACY[tab] ?? tab), { replace: true })
}
else if (!meta.value) {
  await navigateTo(sectionPath(tenantId.value, ''), { replace: true })
}

const title = computed(() => meta.value?.value ? meta.value.label : tenant.value?.name ?? 'Обзор')
const badge = computed(() => !meta.value?.value && tenant.value ? tenantStatus(tenant.value) : undefined)
useHead({ title: () => `${title.value} · AI-маркетолог` })
</script>

<template>
  <AppPanel :id="`tenant-${section || 'overview'}`" :key="section" :title="title" :badge="badge">
    <component :is="VIEWS[section]" v-if="VIEWS[section]" :tenant-id="tenantId" />
  </AppPanel>
</template>
