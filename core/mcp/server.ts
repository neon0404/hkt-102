import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import { dashboard, postPerformance } from '../analytics'
import { getProfile } from '../ai/context'
import { toJsonSchema } from '../ai/schemas'
import { audit } from '../audit'
import { db, schema } from '../db/client'
import { metricsSummary } from '../jobs/handlers'
import { enqueue } from '../jobs/queue'
import { searchChunks } from '../kb/search'
import { addSource } from '../services/admin'
import {
  activeIntegration, activeMembers, addVersion, checkDraft, createPost, getPost, getTenant, PostStateError,
  reschedulePost, sendForApproval, STATUS_LABELS, updatePostLayout,
} from '../services/posts'
import { listPosts, postDetail } from '../services/views'
import { zonedToUtc } from '../time'
import type { AgentIdentity } from './tokens'

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const SERVER_INSTRUCTIONS = `AI-маркетолог компании: посты для Telegram-канала по материалам компании, карточки по брендбуку, журнальная вёрстка с каруселью фото, контент-план, аналитика.
Как работать:
- Факты для постов берутся только из базы знаний компании (search_knowledge). Добавить материал — add_source.
- create_post пишет пост с AI (асинхронно: вернёт job_id, результат — get_job). write_post — свой текст без AI.
- Любой новый или изменённый пост уходит согласующим в Telegram. Одобряют и публикуют только они — у агента такой возможности нет.
- Время — в часовом поясе компании (company_overview), формат YYYY-MM-DDTHH:mm, либо ISO 8601 со смещением.
- Формат rich: text в Markdown Telegram (### подзаголовки, списки, **жирный**, > цитаты, таблицы). classic: простой текст до 1024 знаков.`

interface Ctx { agent: AgentIdentity }
interface Tool<S extends z.ZodType> {
  description: string
  input: S
  readOnly?: boolean
  run: (args: z.infer<S>, ctx: Ctx) => Promise<unknown>
}
const tool = <S extends z.ZodType>(t: Tool<S>) => t

class ToolError extends Error {}

const uuid = z.string().uuid()
const when = z.string().describe('Время: YYYY-MM-DDTHH:mm в часовом поясе компании или ISO 8601 со смещением')

async function toDate(tenantId: string, s: string | undefined | null): Promise<Date | null> {
  if (!s) return null
  const tz = (await getTenant(tenantId)).timezone
  const d = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : zonedToUtc(s, tz)
  if (!d || Number.isNaN(d.getTime())) throw new ToolError(`Не понял время «${s}»`)
  if (d.getTime() < Date.now() + 60_000) throw new ToolError('Время публикации должно быть в будущем')
  return d
}

const localTime = (d: Date | null | undefined, tz: string) => d
  ? new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(' ', 'T')
  : null

async function postView(tenantId: string, postId: string) {
  const p = await postDetail(tenantId, postId)
  if (!p) throw new ToolError('Пост не найден')
  const tz = (await getTenant(tenantId)).timezone
  const v = p.current_version
  return {
    post_id: p.id, kind: p.kind, status: p.status, status_label: STATUS_LABELS[p.status as keyof typeof STATUS_LABELS],
    scheduled_at: localTime(p.scheduled_at ? new Date(p.scheduled_at) : null, tz), rubric: p.rubric, topic: p.topic,
    version: v && {
      n: v.n, author: v.author, title: v.title, format: v.format, text: v.text, hashtags: v.hashtags,
      photos: v.gallery ? v.gallery.photos.length + 1 : v.image_url ? 1 : 0, carousel_mode: v.gallery?.mode ?? null,
      gallery_photo_ids: v.gallery?.photos.map(x => x.id) ?? [],
      facts: v.facts.map((f: any) => ({ claim: f.claim, source: f.source_title ?? null })), warnings: v.warnings,
      card_template: v.card?.template ?? null, video: v.video ? { status: v.video.status, duration_sec: v.video.duration_sec } : null,
    },
    versions: p.versions.length,
    approvals: p.approvals.filter((a: any) => a.version_id === v?.id).map((a: any) => ({ approver: a.member, decision: a.decision, comment: a.comment })),
    publication: p.publication ? { status: p.publication.status, url: p.publication.url, views: p.publication.views, reactions: p.publication.reactions, clicks: p.publication.clicks } : null,
  }
}

const guard = async <T>(fn: () => Promise<T>) => {
  try { return await fn() }
  catch (e) { if (e instanceof PostStateError) throw new ToolError(e.message); throw e }
}

export const TOOLS = {
  company_overview: tool({
    description: 'Компания: канал, часовой пояс, формат постов, согласующие, профиль бренда (рубрики, аудитории, тон, запреты) и счётчики постов.',
    input: z.object({}),
    readOnly: true,
    async run(_, { agent }) {
      const t = await getTenant(agent.tenantId)
      const profile = await getProfile(agent.tenantId)
      const integration = await activeIntegration(agent.tenantId)
      const approvers = await activeMembers(agent.tenantId, 'approver')
      const posts = await listPosts(agent.tenantId, { limit: 500 })
      const byStatus = posts.reduce<Record<string, number>>((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {})
      return {
        name: t.name, timezone: t.timezone, now_local: localTime(new Date(), t.timezone),
        channel: integration ? (integration.username ? `@${integration.username}` : integration.title) : null,
        post_format_default: t.settings.post_format ?? 'rich', approval_rule: t.settings.approval_rule ?? 'any_one',
        approvers: approvers.map(a => a.displayName),
        brand: profile ? {
          description: profile.data.description, products: profile.data.products, audiences: profile.data.audiences,
          tone: profile.data.tone, rubrics: profile.data.rubrics, forbidden: profile.data.forbidden, strategy: profile.data.strategy,
        } : null,
        posts_by_status: byStatus,
      }
    },
  }),

  list_posts: tool({
    description: 'Посты компании, новые сверху. Фильтр по статусу: draft, in_review, approved, scheduled, published, rejected, failed (можно через запятую).',
    input: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
    async run({ status, limit }, { agent }) {
      const tz = (await getTenant(agent.tenantId)).timezone
      const rows = await listPosts(agent.tenantId, { status, limit })
      return rows.map((p: any) => ({
        post_id: p.id, kind: p.kind, status: p.status, title: p.title, rubric: p.rubric,
        scheduled_at: localTime(p.scheduled_at ? new Date(p.scheduled_at) : null, tz), created_at: localTime(new Date(p.created_at), tz),
      }))
    },
  }),

  get_post: tool({
    description: 'Пост целиком: текст текущей версии, формат, карусель, факты с источниками, замечания проверки, решения согласующих, статистика публикации.',
    input: z.object({ post_id: uuid }),
    readOnly: true,
    run: ({ post_id }, { agent }) => postView(agent.tenantId, post_id),
  }),

  create_post: tool({
    description: 'Написать пост с AI по материалам компании: текст, карточка по брендбуку, в журнальном формате — карусель фото. Готовый пост уйдёт согласующим. Асинхронно: вернёт job_id, результат (post_id) — get_job, обычно 1–2 минуты.',
    input: z.object({
      topic: z.string().min(3).max(300).describe('О чём пост'),
      instructions: z.string().max(1000).optional().describe('Пожелания: тон, акценты, длина, призыв'),
      rubric: z.string().max(80).optional(),
      format: z.enum(['rich', 'classic']).optional().describe('По умолчанию — как в настройках компании'),
      schedule_at: when.optional(),
    }),
    async run(args, { agent }) {
      const at = await toDate(agent.tenantId, args.schedule_at)
      const job_id = await enqueue({ tenantId: agent.tenantId, type: 'agent_post', payload: { ...args, schedule_at: at?.toISOString() ?? null, via: agent.name } })
      await audit(agent.tenantId, 'operator', `mcp:${agent.name}`, 'mcp.create_post', 'job', job_id, { topic: args.topic })
      return { job_id, status: 'queued', next: 'get_job' }
    },
  }),

  write_post: tool({
    description: 'Свой пост без AI: ваш заголовок и текст. Карточка соберётся по тексту, в журнальном формате добавится карусель. Пост уходит согласующим.',
    input: z.object({
      title: z.string().min(3).max(90).describe('Заголовок — он же на карточке'),
      text: z.string().min(10).max(8000),
      hashtags: z.array(z.string()).max(5).optional(),
      format: z.enum(['rich', 'classic']).optional(),
      schedule_at: when.optional(),
    }),
    async run(args, { agent }) {
      const at = await toDate(agent.tenantId, args.schedule_at)
      const draft = {
        title: args.title.trim(), text: args.text.trim(), hashtags: (args.hashtags ?? []).map(h => h.startsWith('#') ? h : `#${h}`),
        facts: [], warnings: [] as string[], format: args.format,
      }
      draft.warnings = await checkDraft(agent.tenantId, draft, {})
      const { post } = await createPost(agent.tenantId, { draft, origin: 'operator', author: 'human', topic: draft.title, scheduledAt: at })
      await audit(agent.tenantId, 'operator', `mcp:${agent.name}`, 'post.created', 'post', post.id, { via: 'mcp', author: 'human' })
      const { sent } = await sendForApproval(agent.tenantId, post.id)
      return { ...(await postView(agent.tenantId, post.id)), sent_to_approvers: sent }
    },
  }),

  revise_post: tool({
    description: 'Доработать пост с AI по комментарию («короче», «добавь цифры про толщину», «другой тон»). Новая версия уйдёт на согласование. Асинхронно: job_id → get_job.',
    input: z.object({ post_id: uuid, instructions: z.string().min(3).max(1000) }),
    async run({ post_id, instructions }, { agent }) {
      const post = await getPost(agent.tenantId, post_id)
      if (!post) throw new ToolError('Пост не найден')
      if (post.kind !== 'post') throw new ToolError('Ролик дорабатывается через Telegram-бота')
      if (!['draft', 'in_review', 'approved', 'scheduled'].includes(post.status)) throw new ToolError('Пост уже опубликован или отклонён — изменить его нельзя')
      const job_id = await enqueue({ tenantId: agent.tenantId, type: 'revise_post', payload: { post_id, comment: instructions, via: agent.name } })
      return { job_id, status: 'queued', next: 'get_job' }
    },
  }),

  edit_post: tool({
    description: 'Поправить заголовок или текст вручную, без AI. Создаётся новая версия, она уходит на согласование.',
    input: z.object({ post_id: uuid, title: z.string().min(3).max(90).optional(), text: z.string().min(10).max(8000).optional(), hashtags: z.array(z.string()).max(5).optional() }),
    async run({ post_id, title, text, hashtags }, { agent }) {
      const p = await postDetail(agent.tenantId, post_id)
      const cur = p?.current_version
      if (!cur) throw new ToolError('Пост не найден')
      const draft = {
        title: title?.trim() ?? cur.title, text: text?.trim() ?? cur.text, hashtags: hashtags?.map(h => h.startsWith('#') ? h : `#${h}`) ?? cur.hashtags,
        image_prompt: cur.image_prompt, facts: cur.facts, warnings: [] as string[], format: cur.format,
      }
      draft.warnings = await checkDraft(agent.tenantId, draft, { contextText: cur.text })
      await guard(() => addVersion(agent.tenantId, post_id, { draft, author: 'human', comment: `Правка агента «${agent.name}»`, keepImage: true }))
      await sendForApproval(agent.tenantId, post_id)
      return postView(agent.tenantId, post_id)
    },
  }),

  set_post_layout: tool({
    description: 'Формат и карусель поста: format rich/classic; add_photos — добавить N фото из фотобанка компании; remove_photo_ids — убрать фото из карусели; carousel_mode — slideshow (листать) или collage (сеткой).',
    input: z.object({
      post_id: uuid,
      format: z.enum(['rich', 'classic']).optional(),
      add_photos: z.number().int().min(1).max(9).optional(),
      remove_photo_ids: z.array(uuid).max(9).optional(),
      carousel_mode: z.enum(['slideshow', 'collage']).optional(),
    }),
    async run(a, { agent }) {
      const actor = { type: 'agent' as const, id: `mcp:${agent.name}` }
      const go = (patch: Parameters<typeof updatePostLayout>[2]) => guard(() => updatePostLayout(agent.tenantId, a.post_id, patch, actor))
      if (a.format) await go({ format: a.format })
      for (const id of a.remove_photo_ids ?? []) await go({ gallery: { action: 'remove', media_id: id } })
      for (let i = 0; i < (a.add_photos ?? 0); i++) await go({ gallery: { action: 'add' } })
      if (a.carousel_mode) await go({ gallery: { action: 'mode', mode: a.carousel_mode } })
      return postView(agent.tenantId, a.post_id)
    },
  }),

  schedule_post: tool({
    description: 'Назначить или перенести время публикации. Если пост уже одобрен, а время меняется, — он уйдёт на повторное согласование. Без at — «сразу после одобрения».',
    input: z.object({ post_id: uuid, at: when.optional() }),
    async run({ post_id, at }, { agent }) {
      const d = await toDate(agent.tenantId, at)
      const r = await guard(() => reschedulePost(agent.tenantId, post_id, d))
      return { ...(await postView(agent.tenantId, post_id)), needs_approval: r.needsApproval }
    },
  }),

  send_for_approval: tool({
    description: 'Повторно прислать текущую версию поста согласующим в Telegram (тем, у кого нет открытой карточки).',
    input: z.object({ post_id: uuid }),
    async run({ post_id }, { agent }) {
      const r = await guard(() => sendForApproval(agent.tenantId, post_id))
      return { sent_to_approvers: r.sent }
    },
  }),

  get_plan: tool({
    description: 'Контент-план: темы по датам и их статусы (idea — предложена, accepted — принята, пост будет готов к дате; drafted — пост готов; skipped — пропущена).',
    input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    readOnly: true,
    async run({ from, to }, { agent }) {
      const where = [eq(schema.planItems.tenantId, agent.tenantId)]
      if (from) where.push(gte(schema.planItems.date, from))
      if (to) where.push(lte(schema.planItems.date, to))
      const rows = await db.select().from(schema.planItems).where(and(...where)).orderBy(desc(schema.planItems.date)).limit(60)
      return rows.map(r => ({ plan_item_id: r.id, date: r.date, time: r.time, rubric: r.rubric, topic: r.topic, reason: r.reason, status: r.status, post_id: r.postId }))
    },
  }),

  create_plan: tool({
    description: 'Составить контент-план на неделю с AI. План придёт согласующим в Telegram с кнопкой «Принять». Асинхронно: job_id → get_job.',
    input: z.object({ wishes: z.string().max(1000).optional().describe('Пожелания: темы, акценты, частота') }),
    async run({ wishes }, { agent }) {
      const job_id = await enqueue({ tenantId: agent.tenantId, type: 'weekly_plan', payload: { wishes: wishes ?? null, via: agent.name } })
      return { job_id, status: 'queued', next: 'get_job' }
    },
  }),

  get_analytics: tool({
    description: 'Аналитика за 7 или 30 дней: подготовлено/опубликовано/отклонено, скорость согласования, подписчики, просмотры, реакции, переходы, лучшие макеты/рубрики/время, топ постов, воронка.',
    input: z.object({ days: z.union([z.literal(7), z.literal(30)]).default(7) }),
    readOnly: true,
    async run({ days }, { agent }) {
      const m = await metricsSummary(agent.tenantId, days)
      const t = await getTenant(agent.tenantId)
      const d = await dashboard(agent.tenantId, days, t.timezone, m.performance)
      const perf = await postPerformance(agent.tenantId, days, t.timezone)
      return {
        days, created: m.created, published: m.published, rejected: m.rejected, waiting: m.waiting, scheduled: m.scheduled,
        approvals: m.approvals, subscribers: m.subscribers, subscribers_delta: m.subscribersDelta, comments: m.comments,
        totals: perf.totals, engagement: d.engagement, funnel: d.funnel,
        by_template: perf.byTemplate, by_rubric: perf.byRubric, by_daypart: perf.byDaypart,
        top_posts: perf.posts.filter(p => p.views !== null).sort((a, b) => b.views! - a.views!).slice(0, 5)
          .map(p => ({ post_id: p.postId, title: p.title, views: p.views, reactions: p.reactions, clicks: p.clicks, url: p.url })),
        daily: d.daily,
      }
    },
  }),

  search_knowledge: tool({
    description: 'Поиск по материалам компании (сайт, каталоги, документы) — только эти факты можно использовать в постах.',
    input: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(15).default(6) }),
    readOnly: true,
    async run({ query, limit }, { agent }) {
      const rows = await searchChunks(agent.tenantId, query, { limit, scope: 'company' })
      return rows.map(r => ({ source: r.title, text: r.text }))
    },
  }),

  list_sources: tool({
    description: 'Материалы в базе знаний компании и их статус обработки.',
    input: z.object({}),
    readOnly: true,
    async run(_, { agent }) {
      const rows = await db.select().from(schema.sources).where(eq(schema.sources.tenantId, agent.tenantId)).orderBy(desc(schema.sources.createdAt)).limit(100)
      return rows.map(r => ({ title: r.title, kind: r.kind, scope: r.scope, url: r.kind === 'url' ? r.uri : null, status: r.status, facts: r.chunksCount, error: r.error }))
    },
  }),

  add_source: tool({
    description: 'Добавить материал в базу знаний: страницу сайта (url) или текст (text + title). Обработка — в фоне, около минуты.',
    input: z.object({ url: z.string().url().optional(), text: z.string().min(50).max(200_000).optional(), title: z.string().max(200).optional() }),
    async run({ url, text, title }, { agent }) {
      if (!url === !text) throw new ToolError('Нужен либо url, либо text')
      try {
        const src = await addSource(agent.tenantId, url ? { kind: 'url', uri: url, title } : { kind: 'text', text, title: title ?? 'Материал от агента' }, `mcp:${agent.name}`)
        return { title: (src as any).title ?? title ?? url, status: (src as any).status ?? 'pending' }
      }
      catch (e) { throw new ToolError((e as Error).message) }
    },
  }),

  run_task: tool({
    description: 'Поручить задачу словами, как в Telegram-боте («подготовь пост к выставке на пятницу в 10:00», «пришли отчёт»). Результат придёт согласующим в Telegram. Асинхронно: job_id → get_job.',
    input: z.object({ text: z.string().min(3).max(2000) }),
    async run({ text }, { agent }) {
      const job_id = await enqueue({ tenantId: agent.tenantId, type: 'custom_task', payload: { text, via: agent.name } })
      return { job_id, status: 'queued', next: 'get_job' }
    },
  }),

  get_job: tool({
    description: 'Статус фоновой задачи: queued, running, succeeded (в result — post_id и др.), failed (в error — причина).',
    input: z.object({ job_id: uuid }),
    readOnly: true,
    async run({ job_id }, { agent }) {
      const [j] = await db.select().from(schema.jobRuns).where(and(eq(schema.jobRuns.id, job_id), eq(schema.jobRuns.tenantId, agent.tenantId)))
      if (!j) throw new ToolError('Задача не найдена')
      return { job_id: j.id, type: j.type, status: j.status, attempts: j.attempts, result: j.result, error: j.error }
    },
  }),
} satisfies Record<string, Tool<any>>

type ToolName = keyof typeof TOOLS

export function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description, inputSchema: toJsonSchema(t.input),
    annotations: { readOnlyHint: !!(t as Tool<any>).readOnly, destructiveHint: false, openWorldHint: false },
  }))
}

export async function callTool(name: string, args: unknown, ctx: Ctx) {
  const t = TOOLS[name as ToolName] as Tool<any> | undefined
  if (!t) return { error: { code: -32602, message: `Неизвестный инструмент: ${name}` } }
  const parsed = t.input.safeParse(args ?? {})
  if (!parsed.success) {
    return { result: { isError: true, content: [{ type: 'text', text: `Неверные параметры: ${parsed.error.issues.map((i: z.core.$ZodIssue) => `${i.path.join('.') || 'аргументы'} — ${i.message}`).join('; ')}` }] } }
  }
  try {
    const out = await t.run(parsed.data, ctx)
    return { result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: Array.isArray(out) ? { items: out } : out as Record<string, unknown> } }
  }
  catch (e) {
    if (e instanceof ToolError) return { result: { isError: true, content: [{ type: 'text', text: e.message }] } }
    console.error('[mcp] ошибка инструмента', name, e)
    return { result: { isError: true, content: [{ type: 'text', text: 'Внутренняя ошибка сервиса. Оператор увидит её в журнале.' }] } }
  }
}

interface RpcMessage { jsonrpc?: string, id?: string | number | null, method?: string, params?: any }

export async function handleRpc(msg: RpcMessage, ctx: Ctx): Promise<Record<string, unknown> | null> {
  const reply = (body: Record<string, unknown>) => (msg.id === undefined || msg.id === null ? null : { jsonrpc: '2.0', id: msg.id, ...body })
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'Invalid Request' } }
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '')
      const t = await getTenant(ctx.agent.tenantId)
      return reply({
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ai-smm', title: `AI-маркетолог · ${t.name}`, version: '1.0.0' },
          instructions: SERVER_INSTRUCTIONS,
        },
      })
    }
    case 'ping': return reply({ result: {} })
    case 'tools/list': return reply({ result: { tools: toolList() } })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const r = await callTool(name, msg.params?.arguments, ctx)
      return reply(r)
    }
    case 'resources/list': return reply({ result: { resources: [] } })
    case 'prompts/list': return reply({ result: { prompts: [] } })
    default:
      if (msg.method.startsWith('notifications/')) return null
      return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
}
