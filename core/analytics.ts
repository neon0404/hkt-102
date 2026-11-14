import { randomBytes } from 'node:crypto'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { MessageEntity } from 'grammy/types'
import { config } from './config'
import { sha256 } from './crypto'
import { db, schema } from './db/client'
import { CARD_TEMPLATES, type CardTemplateId } from './image/card-templates'

export function parseCount(raw: string): number | null {
  const m = raw.replace(/\s/g, '').replace(',', '.').match(/^([\d.]+)([KMkм]?)$/)
  if (!m) return null
  const mult = { K: 1e3, k: 1e3, M: 1e6, м: 1e6 }[m[2] as 'K'] ?? 1
  return Math.round(Number(m[1]) * mult)
}

export interface ChannelPostStats { views: number | null, reactions: number }

export async function fetchChannelStats(username: string, oldestId: number, maxPages = 6): Promise<Map<number, ChannelPostStats>> {
  const { parseHTML } = await import('linkedom')
  const out = new Map<number, ChannelPostStats>()
  let before: number | null = null
  for (let page = 0; page < maxPages; page++) {
    const url = `https://t.me/s/${encodeURIComponent(username)}${before ? `?before=${before}` : ''}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; AIMarketerBot/1.0)' } })
    if (!res.ok) throw new Error(`t.me ответил кодом ${res.status}`)
    const page = parseChannelPage(parseHTML, await res.text())
    for (const [id, s] of page) out.set(id, s)
    const min = Math.min(...page.keys())
    if (!Number.isFinite(min) || min <= oldestId || min <= 1) break
    before = min
  }
  return out
}

export function parseChannelPage(parseHTML: typeof import('linkedom').parseHTML, html: string): Map<number, ChannelPostStats> {
  const { document } = parseHTML(html)
  const out = new Map<number, ChannelPostStats>()
  for (const el of document.querySelectorAll('.tgme_widget_message[data-post]')) {
    const id = Number(el.getAttribute('data-post')!.split('/').pop())
    if (!Number.isFinite(id)) continue
    const viewsText = el.querySelector('.tgme_widget_message_views')?.textContent ?? ''
    let reactions = 0
    for (const r of el.querySelectorAll('.tgme_reaction')) reactions += parseCount((r.textContent ?? '').replace(/[^\d.,KM]/g, '')) ?? 0
    out.set(id, { views: viewsText ? parseCount(viewsText) : null, reactions })
  }
  return out
}

export async function refreshPostStats(tenantId: string, days = 60): Promise<{ updated: number, available: boolean }> {
  const since = new Date(Date.now() - days * 86400_000)
  const pubs = await db.select({
    id: schema.publications.id, externalPostId: schema.publications.externalPostId, username: schema.integrations.username,
    integrationId: schema.integrations.id,
  }).from(schema.publications)
    .innerJoin(schema.integrations, eq(schema.integrations.id, schema.publications.integrationId))
    .where(and(
      eq(schema.publications.tenantId, tenantId), eq(schema.publications.status, 'published'),
      gte(schema.publications.publishedAt, since), eq(schema.integrations.platform, 'telegram'),
    ))
  const byChannel = new Map<string, typeof pubs>()
  for (const p of pubs) if (p.username && p.externalPostId) byChannel.set(p.username, [...(byChannel.get(p.username) ?? []), p])
  let updated = 0
  for (const [username, list] of byChannel) {
    const oldest = Math.min(...list.map(p => Number(p.externalPostId)))
    let stats: Map<number, ChannelPostStats>
    try { stats = await fetchChannelStats(username, oldest) }
    catch (e) { console.warn('[stats] страница канала недоступна', username, (e as Error).message); continue }
    for (const p of list) {
      const s = stats.get(Number(p.externalPostId))
      if (!s || s.views === null) continue
      await db.update(schema.publications).set({ views: s.views, reactions: s.reactions, statsAt: new Date() }).where(eq(schema.publications.id, p.id))
      await db.insert(schema.analyticsSnapshots).values({ tenantId, integrationId: p.integrationId, publicationId: p.id, metric: 'views', value: String(s.views) })
      updated++
    }
  }
  return { updated, available: byChannel.size > 0 }
}

const URL_RE = /https?:\/\/[^\s<>«»"'()]+[^\s<>«»"'().,;:!?]/g

export const hasUrl = (text: string) => new RegExp(URL_RE.source).test(text)

export function withUtm(raw: string, post: { id: string, rubric?: string | null }, template?: string | null): string {
  try {
    const u = new URL(raw)
    const set = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v) }
    set('utm_source', 'telegram')
    set('utm_medium', 'social')
    set('utm_campaign', 'ai_marketer')
    set('utm_content', [template, post.id.slice(0, 8)].filter(Boolean).join('_'))
    return u.toString()
  }
  catch { return raw }
}

async function trackedUrl(tenantId: string, post: { id: string, rubric?: string | null }, publicationId: string, raw: string, template?: string | null) {
  const target = withUtm(raw, post, template)
  let [link] = await db.select().from(schema.trackedLinks)
    .where(and(eq(schema.trackedLinks.tenantId, tenantId), eq(schema.trackedLinks.postId, post.id), eq(schema.trackedLinks.url, target)))
  if (!link) {
    [link] = await db.insert(schema.trackedLinks)
      .values({ tenantId, postId: post.id, publicationId, code: randomBytes(5).toString('base64url'), url: target }).returning()
  }
  return `${config.publicBaseUrl}/r/${link!.code}`
}

export async function trackLinksMarkdown(
  tenantId: string, post: { id: string, rubric?: string | null }, publicationId: string, md: string, template?: string | null,
): Promise<string> {
  if (!/^https:\/\//.test(config.publicBaseUrl)) return md
  const parts = md.split(/(\[[^\]\n]*\]\(https?:[^)\s]+\))/)
  const out: string[] = []
  for (const part of parts) {
    const link = part.match(/^\[([^\]\n]*)\]\((https?:[^)\s]+)\)$/)
    if (link) { out.push(`[${link[1]}](${await trackedUrl(tenantId, post, publicationId, link[2]!, template)})`); continue }
    let piece = ''
    let last = 0
    for (const m of part.matchAll(URL_RE)) {
      piece += part.slice(last, m.index!) + `[${m[0]}](${await trackedUrl(tenantId, post, publicationId, m[0], template)})`
      last = m.index! + m[0].length
    }
    out.push(piece + part.slice(last))
  }
  return out.join('')
}

export async function trackLinks(
  tenantId: string, post: { id: string, rubric?: string | null }, publicationId: string, text: string, template?: string | null,
): Promise<MessageEntity[]> {
  if (!/^https:\/\//.test(config.publicBaseUrl)) return []
  const entities: MessageEntity[] = []
  for (const m of text.matchAll(URL_RE)) {
    const target = withUtm(m[0], post, template)
    let [link] = await db.select().from(schema.trackedLinks)
      .where(and(eq(schema.trackedLinks.tenantId, tenantId), eq(schema.trackedLinks.postId, post.id), eq(schema.trackedLinks.url, target)))
    if (!link) {
      [link] = await db.insert(schema.trackedLinks)
        .values({ tenantId, postId: post.id, publicationId, code: randomBytes(5).toString('base64url'), url: target }).returning()
    }
    entities.push({ type: 'text_link', offset: m.index!, length: m[0].length, url: `${config.publicBaseUrl}/r/${link!.code}` })
  }
  return entities
}

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|curl|wget|python|headless/i

export async function registerClick(code: string, ip: string, ua: string): Promise<string | null> {
  if (!/^[\w-]{4,16}$/.test(code)) return null
  const [link] = await db.select().from(schema.trackedLinks).where(eq(schema.trackedLinks.code, code))
  if (!link) return null
  if (!BOT_UA.test(ua)) {
    const day = new Date().toISOString().slice(0, 10)
    const visitor = sha256(`${config.secretKey}:${ip}:${ua}:${day}`).slice(0, 32)
    await db.insert(schema.linkClicks).values({ tenantId: link.tenantId, linkId: link.id, visitor }).onConflictDoNothing()
  }
  return link.url
}

export interface PostPerformance {
  postId: string
  title: string
  rubric: string | null
  template: CardTemplateId | null
  templateName: string | null
  kind: 'post' | 'video_script'
  url: string | null
  publishedAt: Date | null
  hour: number | null
  views: number | null
  reactions: number | null
  clicks: number
}

export interface FormatStat { key: string, label: string, posts: number, avgViews: number | null, clicks: number, ctr: number | null }

const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null

function groupBy(rows: PostPerformance[], key: (r: PostPerformance) => string | null, label: (k: string) => string): FormatStat[] {
  const groups = new Map<string, PostPerformance[]>()
  for (const r of rows) { const k = key(r); if (k) groups.set(k, [...(groups.get(k) ?? []), r]) }
  return [...groups.entries()].map(([k, list]) => {
    const views = list.map(r => r.views).filter((v): v is number => v !== null)
    const clicks = list.reduce((a, r) => a + r.clicks, 0)
    const viewSum = views.reduce((a, b) => a + b, 0)
    return { key: k, label: label(k), posts: list.length, avgViews: avg(views), clicks, ctr: viewSum ? Math.round(clicks / viewSum * 1000) / 10 : null }
  }).sort((a, b) => (b.avgViews ?? -1) - (a.avgViews ?? -1))
}

export async function postPerformance(tenantId: string, days: number, timezone: string) {
  const since = new Date(Date.now() - days * 86400_000)
  const rows = await db.select({
    postId: schema.posts.id, kind: schema.posts.kind, rubric: schema.posts.rubric, title: schema.postVersions.title,
    card: schema.postVersions.card, url: schema.publications.url, publishedAt: schema.publications.publishedAt,
    views: schema.publications.views, reactions: schema.publications.reactions,
  }).from(schema.publications)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.publications.postId))
    .innerJoin(schema.postVersions, eq(schema.postVersions.id, schema.publications.versionId))
    .where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.status, 'published'), gte(schema.publications.publishedAt, since),
      sql`${schema.publications.integrationId} = ${schema.posts.integrationId}`))
    .orderBy(desc(schema.publications.publishedAt))
  const ids = rows.map(r => r.postId)
  const clicks = ids.length
    ? await db.select({ postId: schema.trackedLinks.postId, n: sql<number>`count(${schema.linkClicks.id})::int` })
      .from(schema.trackedLinks).leftJoin(schema.linkClicks, eq(schema.linkClicks.linkId, schema.trackedLinks.id))
      .where(and(eq(schema.trackedLinks.tenantId, tenantId), inArray(schema.trackedLinks.postId, ids))).groupBy(schema.trackedLinks.postId)
    : []
  const clickMap = new Map(clicks.map(c => [c.postId, c.n]))
  const hourFmt = new Intl.DateTimeFormat('ru-RU', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone })
  const posts: PostPerformance[] = rows.map((r) => {
    const template = (r.card?.template ?? null) as CardTemplateId | null
    return {
      postId: r.postId, title: r.title, rubric: r.rubric, template, templateName: template ? CARD_TEMPLATES[template]?.name ?? null : null,
      kind: r.kind, url: r.url, publishedAt: r.publishedAt, hour: r.publishedAt ? Number(hourFmt.format(r.publishedAt)) : null,
      views: r.views, reactions: r.reactions, clicks: clickMap.get(r.postId) ?? 0,
    }
  })
  const withViews = posts.filter(p => p.views !== null)
  const daypart = (h: number | null) => h === null ? null : h < 12 ? 'morning' : h < 17 ? 'day' : 'evening'
  const DAYPARTS: Record<string, string> = { morning: 'Утро, до 12:00', day: 'День, 12–17', evening: 'Вечер, после 17:00' }
  return {
    posts,
    totals: {
      published: posts.length,
      views: withViews.length ? withViews.reduce((a, p) => a + p.views!, 0) : null,
      reactions: withViews.length ? withViews.reduce((a, p) => a + (p.reactions ?? 0), 0) : null,
      clicks: posts.reduce((a, p) => a + p.clicks, 0),
      avgViews: avg(withViews.map(p => p.views!)),
    },
    byTemplate: groupBy(posts, p => p.kind === 'video_script' ? 'video' : p.template, k => k === 'video' ? 'Видео' : CARD_TEMPLATES[k as CardTemplateId]?.name ?? k),
    byRubric: groupBy(posts, p => p.rubric, k => k),
    byDaypart: groupBy(posts, p => daypart(p.hour), k => DAYPARTS[k] ?? k),
  }
}

export type Performance = Awaited<ReturnType<typeof postPerformance>>

export function performanceText(p: Performance): string {
  if (!p.posts.length) return 'Опубликованных постов за период нет.'
  const n = (v: number | null) => v === null ? 'нет данных' : String(v)
  const line = (s: FormatStat) => `${s.label}: постов ${s.posts}, средние просмотры ${n(s.avgViews)}, переходы ${s.clicks}${s.ctr !== null ? `, CTR ${s.ctr}%` : ''}`
  return [
    `Просмотры всего: ${n(p.totals.views)}, в среднем на пост: ${n(p.totals.avgViews)}, реакции: ${n(p.totals.reactions)}, переходы на сайт: ${p.totals.clicks}`,
    'По постам:', ...p.posts.slice(0, 15).map(x => `- «${x.title}» (${x.kind === 'video_script' ? 'видео' : x.templateName ?? 'без макета'}${x.rubric ? `, ${x.rubric}` : ''}, ${x.hour ?? '?'}:00): просмотры ${n(x.views)}, реакции ${n(x.reactions)}, переходы ${x.clicks}`),
    'По макетам:', ...p.byTemplate.map(line),
    'По рубрикам:', ...p.byRubric.map(line),
    'По времени выхода:', ...p.byDaypart.map(line),
  ].join('\n')
}


const AI_OPS: Record<string, string> = {
  generate_post: 'Посты', revise_post: 'Доработки', route_message: 'Разбор сообщений', video_script: 'Видео',
  generate_image: 'Картинки', create_plan: 'Контент-планы', pick_topic: 'Темы', generate_report: 'Отчёты',
  comment_reply: 'Ответы на комментарии', analyze_competitor: 'Конкуренты', build_brand_profile: 'Профиль бренда', transcribe: 'Голос',
}

export async function dashboard(tenantId: string, days: number, timezone: string, perf: Performance) {
  const since = new Date(Date.now() - days * 86400_000)
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const keys: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey.format(new Date(Date.now() - i * 86400_000))
    if (!keys.includes(k)) keys.push(k)
  }
  const daily = new Map(keys.map(k => [k, { date: k, created: 0, published: 0, views: 0, clicks: 0, reactions: 0 }]))
  const bump = (at: Date | null, f: 'created' | 'published' | 'views' | 'clicks' | 'reactions', n = 1) => {
    const d = at && daily.get(dayKey.format(at))
    if (d) d[f] += n
  }

  const created = await db.select({ at: schema.posts.createdAt, kind: schema.posts.kind, origin: schema.posts.origin, status: schema.posts.status, approved: schema.posts.approvedVersionId, id: schema.posts.id })
    .from(schema.posts).where(and(eq(schema.posts.tenantId, tenantId), gte(schema.posts.createdAt, since)))
  for (const p of created) bump(p.at, 'created')
  for (const p of perf.posts) {
    bump(p.publishedAt, 'published')
    bump(p.publishedAt, 'views', p.views ?? 0)
    bump(p.publishedAt, 'reactions', p.reactions ?? 0)
  }
  const clicks = await db.select({ at: schema.linkClicks.createdAt }).from(schema.linkClicks)
    .where(and(eq(schema.linkClicks.tenantId, tenantId), gte(schema.linkClicks.createdAt, since)))
  for (const c of clicks) bump(c.at, 'clicks')

  const subsRows = await db.select({ at: schema.analyticsSnapshots.capturedAt, value: schema.analyticsSnapshots.value }).from(schema.analyticsSnapshots)
    .where(and(eq(schema.analyticsSnapshots.tenantId, tenantId), eq(schema.analyticsSnapshots.metric, 'subscribers'), gte(schema.analyticsSnapshots.capturedAt, since)))
    .orderBy(schema.analyticsSnapshots.capturedAt)
  const subsByDay = new Map<string, number>()
  for (const s of subsRows) subsByDay.set(dayKey.format(s.at), Number(s.value))
  let last: number | null = null
  const subscribers = keys.map((k) => { last = subsByDay.get(k) ?? last; return { date: k, value: last } })

  const ids = created.map(p => p.id)
  const sent = ids.length
    ? new Set((await db.selectDistinct({ id: schema.approvals.postId }).from(schema.approvals).where(inArray(schema.approvals.postId, ids))).map(r => r.id))
    : new Set<string>()
  const funnel = {
    created: created.length,
    sent: created.filter(p => sent.has(p.id)).length,
    approved: created.filter(p => p.approved || ['approved', 'scheduled', 'published'].includes(p.status)).length,
    published: created.filter(p => p.status === 'published').length,
  }
  const count = <T extends string>(xs: T[]) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {} as Record<string, number>)

  const decisions = await db.select({
    name: schema.tenantMembers.displayName, decision: schema.approvals.decision,
    n: sql<number>`count(*)::int`,
    avg: sql<number>`coalesce(avg(extract(epoch from (${schema.approvals.decidedAt} - ${schema.approvals.createdAt}))), 0)::float`,
  }).from(schema.approvals).innerJoin(schema.tenantMembers, eq(schema.tenantMembers.id, schema.approvals.memberId))
    .where(and(eq(schema.approvals.tenantId, tenantId), gte(schema.approvals.createdAt, since)))
    .groupBy(schema.tenantMembers.displayName, schema.approvals.decision)
  const people = new Map<string, { name: string, approved: number, changes: number, rejected: number, pending: number, sec: number, decided: number }>()
  for (const r of decisions) {
    const p = people.get(r.name) ?? { name: r.name || 'Без имени', approved: 0, changes: 0, rejected: 0, pending: 0, sec: 0, decided: 0 }
    const key = r.decision === 'changes_requested' ? 'changes' : r.decision === 'superseded' ? null : r.decision as 'approved' | 'rejected' | 'pending'
    if (key) p[key] += r.n
    if (r.decision !== 'pending' && r.decision !== 'superseded') { p.sec += r.avg * r.n; p.decided += r.n }
    people.set(r.name, p)
  }
  const approvers = [...people.values()]
    .map(p => ({ name: p.name, approved: p.approved, changes: p.changes, rejected: p.rejected, pending: p.pending, avgSec: p.decided ? Math.round(p.sec / p.decided) : 0 }))
    .sort((a, b) => (b.approved + b.changes + b.rejected) - (a.approved + a.changes + a.rejected))

  const plan = await db.select({ status: schema.planItems.status }).from(schema.planItems)
    .where(and(eq(schema.planItems.tenantId, tenantId), gte(schema.planItems.date, keys[0]!)))
  const sentiments = await db.select({ s: schema.comments.sentiment }).from(schema.comments)
    .where(and(eq(schema.comments.tenantId, tenantId), gte(schema.comments.createdAt, since)))
  const ai = await db.select({
    op: schema.llmUsage.operation, calls: sql<number>`count(*)::int`, ms: sql<number>`coalesce(avg(${schema.llmUsage.durationMs}), 0)::int`,
  }).from(schema.llmUsage).where(and(eq(schema.llmUsage.tenantId, tenantId), gte(schema.llmUsage.createdAt, since))).groupBy(schema.llmUsage.operation)
  const [kb] = await db.select({ sources: sql<number>`count(*)::int`, chunks: sql<number>`coalesce(sum(${schema.sources.chunksCount}), 0)::int` })
    .from(schema.sources).where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.status, 'ready'), eq(schema.sources.scope, 'company')))

  const t = perf.totals
  const pct = (a: number | null, b: number | null) => a !== null && b ? Math.round(a / b * 1000) / 10 : null
  return {
    daily: [...daily.values()],
    subscribers,
    funnel,
    engagement: { er: pct(t.reactions, t.views), ctr: pct(t.clicks, t.views), reactions: t.reactions },
    mix: { posts: perf.posts.filter(p => p.kind !== 'video_script').length, videos: perf.posts.filter(p => p.kind === 'video_script').length },
    origin: count(created.map(p => p.origin)),
    approvers,
    plan: count(plan.map(p => p.status)),
    sentiment: count(sentiments.map(s => s.s ?? 'neutral')),
    ai: [...ai.reduce((m, a) => {
      const label = AI_OPS[a.op] ?? 'Прочее'
      const x = m.get(label) ?? { label, calls: 0, ms: 0 }
      x.ms = Math.round((x.ms * x.calls + a.ms * a.calls) / (x.calls + a.calls)); x.calls += a.calls
      return m.set(label, x)
    }, new Map<string, { label: string, calls: number, ms: number }>()).values()].sort((a, b) => b.calls - a.calls),
    kb: kb ?? { sources: 0, chunks: 0 },
  }
}
