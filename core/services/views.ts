import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import type { PostStatus } from '../db/schema'

export async function listPosts(tenantId: string, opts: { status?: string, limit?: number, offset?: number, kind?: string } = {}) {
  const where = [eq(schema.posts.tenantId, tenantId)]
  if (opts.status) where.push(inArray(schema.posts.status, opts.status.split(',') as PostStatus[]))
  if (opts.kind) where.push(eq(schema.posts.kind, opts.kind as 'post' | 'video_script'))
  const rows = await db.select({
    id: schema.posts.id, kind: schema.posts.kind, status: schema.posts.status, platform: schema.posts.platform, origin: schema.posts.origin,
    scheduled_at: schema.posts.scheduledAt, rubric: schema.posts.rubric, topic: schema.posts.topic, created_at: schema.posts.createdAt,
    title: schema.postVersions.title, text: schema.postVersions.text, version_n: schema.postVersions.n,
    image_media_id: schema.postVersions.imageMediaId, warnings: schema.postVersions.warnings,
    card_template: sql<string | null>`${schema.postVersions.card}->>'template'`,
    provider: sql<string | null>`${schema.postVersions.generationMeta}->>'provider'`,
    url: schema.publications.url, published_at: schema.publications.publishedAt, publication_status: schema.publications.status,
    revising: sql<boolean>`(${schema.posts.status} = 'draft' and exists (select 1 from ${schema.approvals} where ${schema.approvals.versionId} = ${schema.posts.currentVersionId} and ${schema.approvals.decision} = 'changes_requested'))`,
  }).from(schema.posts)
    .leftJoin(schema.postVersions, eq(schema.postVersions.id, schema.posts.currentVersionId))
    .leftJoin(schema.publications, and(eq(schema.publications.postId, schema.posts.id), sql`${schema.publications.integrationId} IS NOT DISTINCT FROM ${schema.posts.integrationId}`))
    .where(and(...where)).orderBy(desc(schema.posts.createdAt))
    .limit(Math.max(1, Math.min(Math.floor(opts.limit ?? 50) || 50, 200))).offset(Math.max(0, Math.floor(opts.offset ?? 0) || 0))
  return rows.map(r => ({ ...r, image_url: r.image_media_id ? `/api/v1/tenants/${tenantId}/media/${r.image_media_id}` : null }))
}

export async function postDetail(tenantId: string, postId: string) {
  const [post] = await db.select().from(schema.posts).where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId)))
  if (!post) return null
  const versions = await db.select().from(schema.postVersions)
    .where(and(eq(schema.postVersions.tenantId, tenantId), eq(schema.postVersions.postId, postId))).orderBy(desc(schema.postVersions.n))
  const approvals = await db.select({
    id: schema.approvals.id, version_id: schema.approvals.versionId, decision: schema.approvals.decision, comment: schema.approvals.comment,
    decided_at: schema.approvals.decidedAt, created_at: schema.approvals.createdAt, member: schema.tenantMembers.displayName,
  }).from(schema.approvals).leftJoin(schema.tenantMembers, eq(schema.tenantMembers.id, schema.approvals.memberId))
    .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.postId, postId))).orderBy(schema.approvals.createdAt)
  const pubs = await db.select({ p: schema.publications, platform: schema.integrations.platform }).from(schema.publications)
    .leftJoin(schema.integrations, eq(schema.integrations.id, schema.publications.integrationId))
    .where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.postId, postId)))
  const publication = pubs.find(x => x.p.integrationId === post.integrationId)?.p ?? pubs[0]?.p
  const copies = pubs.filter(x => x.p.id !== publication?.id).map(x => ({ platform: x.platform, status: x.p.status, url: x.p.url, error: x.p.error }))
  const [integration] = post.integrationId
    ? await db.select({ title: schema.integrations.title, username: schema.integrations.username, platform: schema.integrations.platform })
        .from(schema.integrations).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.id, post.integrationId)))
    : []
  const nById = new Map(versions.map(v => [v.id, v.n]))
  const mapVersion = (v: typeof versions[number]) => ({
    id: v.id, n: v.n, title: v.title, text: v.text, hashtags: v.hashtags, facts: v.facts, warnings: v.warnings, comment: v.comment,
    author: v.author, generation_meta: v.generationMeta, created_at: v.createdAt, image_prompt: v.imagePrompt,
    image_url: v.imageMediaId ? `/api/v1/tenants/${tenantId}/media/${v.imageMediaId}` : null,
    card: v.card ? { ...v.card, seen: undefined, photo_url: v.card.photo?.media_id ? `/api/v1/tenants/${tenantId}/media/${v.card.photo.media_id}` : null } : null,
    video: v.video ? { ...v.video, url: v.video.media_id ? `/api/v1/tenants/${tenantId}/media/${v.video.media_id}` : null } : null,
    format: v.format,
    gallery: v.gallery ? { mode: v.gallery.mode, photos: v.gallery.media_ids.map(id => ({ id, url: `/api/v1/tenants/${tenantId}/media/${id}` })) } : null,
  })
  const [clicks] = publication
    ? await db.select({ n: sql<number>`count(${schema.linkClicks.id})::int` }).from(schema.trackedLinks)
      .leftJoin(schema.linkClicks, eq(schema.linkClicks.linkId, schema.trackedLinks.id))
      .where(and(eq(schema.trackedLinks.tenantId, tenantId), eq(schema.trackedLinks.postId, postId)))
    : []
  return {
    id: post.id, kind: post.kind, status: post.status, platform: post.platform, origin: post.origin, rubric: post.rubric, topic: post.topic,
    scheduled_at: post.scheduledAt, created_at: post.createdAt,
    revising: post.status === 'draft' && approvals.some(a => a.version_id === post.currentVersionId && a.decision === 'changes_requested'),
    approved_version_n: post.approvedVersionId ? nById.get(post.approvedVersionId) ?? null : null,
    channel: integration ? (integration.username ? `@${integration.username}` : integration.title) : null,
    current_version: versions.find(v => v.id === post.currentVersionId) ? mapVersion(versions.find(v => v.id === post.currentVersionId)!) : null,
    versions: versions.map(mapVersion),
    approvals: approvals.map(a => ({ ...a, version_n: nById.get(a.version_id) ?? null })),
    publication: publication
      ? {
          id: publication.id, status: publication.status, url: publication.url, error: publication.error, attempts: publication.attempts, published_at: publication.publishedAt,
          views: publication.views, reactions: publication.reactions, stats_at: publication.statsAt, clicks: clicks?.n ?? 0,
        }
      : null,
    copies,
  }
}
