import { sql } from 'drizzle-orm'
import type { PostCard } from '../image/card-templates'
import {
  bigint, boolean, customType, date, index, integer, jsonb, numeric, pgTable, text, timestamp,
  uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const ts = (name: string) => timestamp(name, { withTimezone: true })
const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' })

export const adminUsers = pgTable('admin_users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  tgUserId: bigint('tg_user_id', { mode: 'number' }),
  createdAt: createdAt(),
})

export const processedUpdates = pgTable('processed_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
})

export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const tgSessions = pgTable('tg_sessions', {
  tgUserId: bigint('tg_user_id', { mode: 'number' }).primaryKey(),
  activeTenantId: uuid('active_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export interface TenantSettings {
  description?: string
  tone?: string
  approval_rule?: 'any_one' | 'all'
  daily_call_limit?: number
  provider?: 'mock' | 'api' | 'chatgpt_account' | null
  image_mode?: 'template' | 'ai_background'
  alert_chat_id?: string | null
  auto_reply_comments?: boolean
  post_format?: 'classic' | 'rich'
  emoji_pack?: string | null
  emoji_in_channel?: boolean
  brand?: {
    primary?: string
    secondary?: string
    text_on_primary?: string
    logo_media_id?: string | null
    logo_light_media_id?: string | null
    pattern_media_id?: string | null
    font_regular_media_id?: string | null
    font_bold_media_id?: string | null
  }
}

export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull(),
  status: text('status').$type<'setup' | 'active' | 'disabled'>().notNull().default('setup'),
  settings: jsonb('settings').$type<TenantSettings>().notNull().default({}),
  createdAt: createdAt(),
})

export const tenantMembers = pgTable('tenant_members', {
  id: id(),
  tenantId: tenantId(),
  tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull(),
  tgChatId: bigint('tg_chat_id', { mode: 'number' }).notNull(),
  displayName: text('display_name').notNull().default(''),
  roles: jsonb('roles').$type<Array<'client' | 'approver'>>().notNull().default(['client']),
  status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('tenant_members_tenant_user_uq').on(t.tenantId, t.tgUserId),
  index('tenant_members_user_idx').on(t.tgUserId),
])

export const invites = pgTable('invites', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull().unique(),
  roles: jsonb('roles').$type<Array<'client' | 'approver'>>().notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedByMemberId: uuid('used_by_member_id'),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
})

export const sources = pgTable('sources', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').$type<'url' | 'file' | 'text'>().notNull(),
  scope: text('scope').$type<'company' | 'competitor'>().notNull().default('company'),
  uri: text('uri'),
  title: text('title').notNull().default(''),
  status: text('status').$type<'pending' | 'processing' | 'ready' | 'failed'>().notNull().default('pending'),
  error: text('error'),
  contentHash: text('content_hash').notNull(),
  rawText: text('raw_text'),
  mediaId: uuid('media_id'),
  chunksCount: integer('chunks_count').notNull().default(0),
  createdAt: createdAt(),
}, t => [uniqueIndex('sources_tenant_hash_uq').on(t.tenantId, t.contentHash)])

export const kbChunks = pgTable('kb_chunks', {
  id: id(),
  tenantId: tenantId(),
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  ord: integer('ord').notNull(),
  text: text('text').notNull(),
  tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('russian', "text")`),
  createdAt: createdAt(),
}, t => [
  index('kb_chunks_tsv_idx').using('gin', t.tsv),
  index('kb_chunks_tenant_source_idx').on(t.tenantId, t.sourceId),
])

export interface BrandFact { claim: string, chunk_id: string | null }
export interface BrandProfileData {
  description: string
  products: string[]
  audiences: string[]
  advantages: string[]
  tone: string
  rubrics: string[]
  forbidden: string[]
  required_phrases: string[]
  facts: BrandFact[]
  strategy?: string
}

export const brandProfiles = pgTable('brand_profiles', {
  id: id(),
  tenantId: tenantId(),
  version: integer('version').notNull(),
  status: text('status').$type<'draft' | 'confirmed'>().notNull().default('draft'),
  data: jsonb('data').$type<BrandProfileData>().notNull(),
  confirmedAt: ts('confirmed_at'),
  createdAt: createdAt(),
}, t => [uniqueIndex('brand_profiles_tenant_version_uq').on(t.tenantId, t.version)])

export const messages = pgTable('messages', {
  id: id(),
  tenantId: tenantId(),
  memberId: uuid('member_id').references(() => tenantMembers.id, { onDelete: 'set null' }),
  direction: text('direction').$type<'in' | 'out'>().notNull(),
  text: text('text').notNull(),
  intent: text('intent'),
  postId: uuid('post_id'),
  tgMessageId: bigint('tg_message_id', { mode: 'number' }),
  createdAt: createdAt(),
}, t => [index('messages_tenant_member_idx').on(t.tenantId, t.memberId, t.createdAt)])

export const dialogStates = pgTable('dialog_states', {
  id: id(),
  tenantId: tenantId(),
  memberId: uuid('member_id').notNull().references(() => tenantMembers.id, { onDelete: 'cascade' }).unique(),
  state: text('state').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export type PostStatus =
  | 'draft' | 'in_review' | 'approved' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'rejected'

export const posts = pgTable('posts', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').$type<'post' | 'video_script'>().notNull().default('post'),
  status: text('status').$type<PostStatus>().notNull().default('draft'),
  platform: text('platform').$type<'telegram' | 'vk' | 'max'>().notNull().default('telegram'),
  integrationId: uuid('integration_id'),
  scheduledAt: ts('scheduled_at'),
  currentVersionId: uuid('current_version_id'),
  approvedVersionId: uuid('approved_version_id'),
  origin: text('origin').$type<'user_request' | 'schedule' | 'plan' | 'operator'>().notNull().default('user_request'),
  createdByMemberId: uuid('created_by_member_id'),
  rubric: text('rubric'),
  topic: text('topic'),
  createdAt: createdAt(),
}, t => [
  index('posts_tenant_status_idx').on(t.tenantId, t.status),
  index('posts_status_scheduled_idx').on(t.status, t.scheduledAt),
])

export interface PostFact { claim: string, chunk_id: string | null, source_title?: string | null, general?: boolean }
export interface GenerationMeta {
  provider?: string
  model?: string
  prompt_version?: string
  image?: { kind: 'template' | 'generated', provider?: string, source?: string }
  [k: string]: unknown
}

export interface PostVideo {
  media_id: string | null
  caption: string
  duration_sec: number
  status: 'rendering' | 'ready' | 'failed'
  error?: string | null
}

export interface PostGallery {
  mode: 'slideshow' | 'collage'
  media_ids: string[]
}

export type PostFormat = 'classic' | 'rich'

export const postVersions = pgTable('post_versions', {
  id: id(),
  tenantId: tenantId(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  n: integer('n').notNull(),
  title: text('title').notNull().default(''),
  text: text('text').notNull(),
  hashtags: jsonb('hashtags').$type<string[]>().notNull().default([]),
  imagePrompt: text('image_prompt'),
  imageMediaId: uuid('image_media_id'),
  facts: jsonb('facts').$type<PostFact[]>().notNull().default([]),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  generationMeta: jsonb('generation_meta').$type<GenerationMeta>().notNull().default({}),
  card: jsonb('card').$type<PostCard>(),
  video: jsonb('video').$type<PostVideo>(),
  format: text('format').$type<PostFormat>().notNull().default('classic'),
  gallery: jsonb('gallery').$type<PostGallery>(),
  author: text('author').$type<'ai' | 'human'>().notNull().default('ai'),
  comment: text('comment'),
  createdAt: createdAt(),
}, t => [uniqueIndex('post_versions_post_n_uq').on(t.postId, t.n)])

export const media = pgTable('media', {
  id: id(),
  tenantId: tenantId(),
  kind: text('kind').$type<'source' | 'generated' | 'template' | 'uploaded' | 'logo' | 'font' | 'background' | 'photo' | 'web'>().notNull(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  title: text('title'),
  width: integer('width'),
  height: integer('height'),
  sha256: text('sha256').notNull(),
  createdAt: createdAt(),
}, t => [index('media_tenant_sha_idx').on(t.tenantId, t.sha256)])

export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'superseded'

export const approvals = pgTable('approvals', {
  id: id(),
  tenantId: tenantId(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').notNull().references(() => postVersions.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => tenantMembers.id, { onDelete: 'cascade' }),
  decision: text('decision').$type<ApprovalDecision>().notNull().default('pending'),
  comment: text('comment'),
  tgChatId: bigint('tg_chat_id', { mode: 'number' }),
  tgMessageId: bigint('tg_message_id', { mode: 'number' }),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
}, t => [index('approvals_version_member_idx').on(t.versionId, t.memberId)])

export const integrations = pgTable('integrations', {
  id: id(),
  tenantId: tenantId(),
  platform: text('platform').$type<'telegram' | 'vk' | 'max'>().notNull(),
  title: text('title').notNull().default(''),
  externalId: text('external_id').notNull(),
  username: text('username'),
  credentialsEnc: text('credentials_enc'),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').$type<'active' | 'error' | 'revoked'>().notNull().default('active'),
  error: text('error'),
  checkedAt: ts('checked_at'),
  createdAt: createdAt(),
}, t => [uniqueIndex('integrations_platform_external_uq').on(t.platform, t.externalId)])

export const publications = pgTable('publications', {
  id: id(),
  tenantId: tenantId(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').notNull(),
  integrationId: uuid('integration_id').notNull(),
  status: text('status').$type<'publishing' | 'published' | 'failed' | 'uncertain'>().notNull().default('publishing'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  externalPostId: text('external_post_id'),
  url: text('url'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  publishedAt: ts('published_at'),
  views: integer('views'),
  reactions: integer('reactions'),
  statsAt: ts('stats_at'),
  createdAt: createdAt(),
}, t => [uniqueIndex('publications_post_integration_uq').on(t.postId, t.integrationId)])

export const trackedLinks = pgTable('tracked_links', {
  id: id(),
  tenantId: tenantId(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  publicationId: uuid('publication_id'),
  code: text('code').notNull().unique(),
  url: text('url').notNull(),
  createdAt: createdAt(),
}, t => [index('tracked_links_post_idx').on(t.postId)])

export const linkClicks = pgTable('link_clicks', {
  id: id(),
  tenantId: tenantId(),
  linkId: uuid('link_id').notNull().references(() => trackedLinks.id, { onDelete: 'cascade' }),
  visitor: text('visitor').notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('link_clicks_link_visitor_uq').on(t.linkId, t.visitor)])

export const scheduledJobs = pgTable('scheduled_jobs', {
  id: id(),
  tenantId: tenantId(),
  type: text('type').$type<'auto_draft' | 'weekly_plan' | 'weekly_report' | 'site_monitor' | 'custom_task' | 'collect_metrics'>().notNull(),
  title: text('title').notNull().default(''),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: ts('next_run_at'),
  lastRunAt: ts('last_run_at'),
  createdAt: createdAt(),
}, t => [index('scheduled_jobs_enabled_next_idx').on(t.enabled, t.nextRunAt)])

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'

export const jobRuns = pgTable('job_runs', {
  id: id(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  scheduledJobId: uuid('scheduled_job_id'),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').$type<JobStatus>().notNull().default('queued'),
  runAfter: ts('run_after').notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lockedAt: ts('locked_at'),
  error: text('error'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  dedupKey: text('dedup_key').unique(),
  llmCalls: integer('llm_calls').notNull().default(0),
  finishedAt: ts('finished_at'),
  createdAt: createdAt(),
}, t => [
  index('job_runs_status_run_after_idx').on(t.status, t.runAfter),
  index('job_runs_tenant_idx').on(t.tenantId, t.createdAt),
])

export const llmUsage = pgTable('llm_usage', {
  id: id(),
  tenantId: tenantId(),
  jobRunId: uuid('job_run_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull().default(''),
  operation: text('operation').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  images: integer('images').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  costEstimate: numeric('cost_estimate', { precision: 12, scale: 6 }).notNull().default('0'),
  createdAt: createdAt(),
}, t => [index('llm_usage_tenant_created_idx').on(t.tenantId, t.createdAt)])

export const planItems = pgTable('plan_items', {
  id: id(),
  tenantId: tenantId(),
  date: date('date').notNull(),
  time: text('time').notNull().default('10:00'),
  rubric: text('rubric').notNull().default(''),
  topic: text('topic').notNull(),
  reason: text('reason'),
  platform: text('platform').notNull().default('telegram'),
  status: text('status').$type<'idea' | 'accepted' | 'drafted' | 'skipped'>().notNull().default('idea'),
  postId: uuid('post_id'),
  batchId: uuid('batch_id'),
  createdAt: createdAt(),
}, t => [index('plan_items_tenant_date_idx').on(t.tenantId, t.date)])

export const analyticsSnapshots = pgTable('analytics_snapshots', {
  id: id(),
  tenantId: tenantId(),
  integrationId: uuid('integration_id'),
  publicationId: uuid('publication_id'),
  metric: text('metric').notNull(),
  value: numeric('value', { precision: 16, scale: 2 }).notNull(),
  capturedAt: ts('captured_at').notNull().defaultNow(),
  createdAt: createdAt(),
}, t => [index('analytics_tenant_metric_idx').on(t.tenantId, t.metric, t.capturedAt)])

export const competitors = pgTable('competitors', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  url: text('url'),
  notes: text('notes'),
  analysis: jsonb('analysis').$type<Record<string, unknown>>(),
  analyzedAt: ts('analyzed_at'),
  createdAt: createdAt(),
})

export const comments = pgTable('comments', {
  id: id(),
  tenantId: tenantId(),
  integrationId: uuid('integration_id'),
  publicationId: uuid('publication_id'),
  externalChatId: text('external_chat_id').notNull(),
  externalMessageId: text('external_message_id').notNull(),
  authorName: text('author_name').notNull().default(''),
  text: text('text').notNull(),
  sentiment: text('sentiment'),
  replyDraft: text('reply_draft'),
  status: text('status').$type<'new' | 'drafted' | 'replied' | 'ignored'>().notNull().default('new'),
  repliedAt: ts('replied_at'),
  createdAt: createdAt(),
}, t => [uniqueIndex('comments_chat_msg_uq').on(t.externalChatId, t.externalMessageId)])

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
}, t => [index('api_tokens_tenant_idx').on(t.tenantId)])

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  actorType: text('actor_type').$type<'operator' | 'member' | 'system' | 'ai'>().notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  entity: text('entity'),
  entityId: text('entity_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [index('audit_tenant_created_idx').on(t.tenantId, t.createdAt)])
