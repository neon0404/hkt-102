import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { InlineKeyboard } from 'grammy'
import { buildContext, getProfile, makeAlias } from '../ai/context'
import {
  aiBuildBrandProfile, aiCommentReply, aiCompetitor, aiCreatePlan, aiGeneratePost, aiPickTopic, aiReport, aiRouteMessage,
  aiVideoScript, type AiRun, LimitError,
} from '../ai/ops'
import { ProviderError } from '../ai/provider'
import { type FormatStat, performanceText, postPerformance, refreshPostStats } from '../analytics'
import type { VideoScriptOut } from '../ai/schemas'
import { audit } from '../audit'
import { sha256 } from '../crypto'
import { db, schema } from '../db/client'
import type { PostVideo } from '../db/schema'
import { readMedia, saveMedia } from '../media'
import { acceptMemberText } from '../services/inbox'
import { transcribe, VoiceError } from '../voice'
import { config } from '../config'
import { renderVideo } from '../video/render'
import { fetchPublic, IngestError, ingestSource } from '../kb/ingest'
import { chunksByIds, firstChunks, searchChunks } from '../kb/search'
import {
  activeIntegration, activeMembers, addVersion, checkDraft, createPost, decideApproval, getPost, getTenant, notifyOperator, PostStateError,
  publishPost, recentPosts, reschedulePost, sayRich, sayToMember, sendForApproval, STATUS_LABELS, submitChangeRequest, withSourceLink,
} from '../services/posts'
import { esc, tg } from '../telegram/api'
import { mdCell, mdDetails, mdEsc, mdTable, progress, withThinking } from '../telegram/rich'
import { humanTime, localDate, zonedToUtc } from '../time'
import type { JobRow } from './queue'

type Handler = (job: JobRow) => Promise<Record<string, unknown>>
type Member = typeof schema.tenantMembers.$inferSelect

export class PermanentError extends Error {}
class UserNotifiedError extends PermanentError {}

const newRun = (job: JobRow): AiRun => ({ tenantId: job.tenantId!, jobRunId: job.id, calls: 0 })

async function memberById(tenantId: string, memberId: string): Promise<Member | null> {
  const [m] = await db.select().from(schema.tenantMembers)
    .where(and(eq(schema.tenantMembers.tenantId, tenantId), eq(schema.tenantMembers.id, memberId)))
  return m ?? null
}

async function recentTopics(tenantId: string, limit = 10): Promise<string[]> {
  const rows = await db.select({ topic: schema.posts.topic }).from(schema.posts)
    .where(eq(schema.posts.tenantId, tenantId)).orderBy(desc(schema.posts.createdAt)).limit(limit)
  return rows.map(r => r.topic).filter((t): t is string => !!t)
}

function parseSchedule(local: string | null | undefined, tz: string): Date | null {
  if (!local) return null
  const at = zonedToUtc(local, tz)
  return at && at.getTime() > Date.now() + 30_000 ? at : null
}

const ingest: Handler = async (job) => {
  try {
    return await ingestSource(job.tenantId!, String(job.payload.source_id))
  }
  catch (e) {
    if (e instanceof IngestError) throw new PermanentError(e.message)
    throw e
  }
}

const buildBrandProfile: Handler = async (job) => {
  const tenantId = job.tenantId!
  const tenant = await getTenant(tenantId)
  const chunks = await firstChunks(tenantId, 36)
  if (!chunks.length) throw new PermanentError('Нет обработанных источников: сначала добавьте материалы компании')
  const { profile } = await aiBuildBrandProfile(newRun(job), tenant.name, tenant.settings.description ?? '', chunks)
  const [{ v }] = await db.select({ v: sql<number>`coalesce(max(${schema.brandProfiles.version}), 0)::int` })
    .from(schema.brandProfiles).where(eq(schema.brandProfiles.tenantId, tenantId)) as [{ v: number }]
  await db.insert(schema.brandProfiles).values({ tenantId, version: v + 1, status: 'draft', data: profile })
  await audit(tenantId, 'ai', null, 'brand_profile.generated', 'brand_profile', null, { version: v + 1, facts: profile.facts.length })
  return { version: v + 1, facts: profile.facts.length }
}

async function preparePost(run: AiRun, member: Member | null, opts: {
  topic: string, instructions?: string | null, rubric?: string | null, scheduledAt?: Date | null,
  origin: 'user_request' | 'schedule' | 'plan' | 'operator', requestText?: string, format?: 'classic' | 'rich',
}) {
  const tenantId = run.tenantId
  const format = opts.format ?? (await getTenant(tenantId)).settings.post_format ?? 'rich'
  progress('Подбираю факты из материалов компании…')
  const ctx = await buildContext(tenantId, { query: `${opts.topic} ${opts.instructions ?? ''}`, history: false })
  progress('Пишу пост…')
  const { draft: raw, meta } = await aiGeneratePost(run, ctx, { topic: opts.topic, instructions: opts.instructions, rubric: opts.rubric, format })
  const draft = await withSourceLink(tenantId, { ...raw, format })
  draft.warnings = await checkDraft(tenantId, draft, {
    forbidden: ctx.profile?.data.forbidden, contextText: `${opts.requestText ?? ''} ${opts.topic}`,
  })
  const { post, version } = await createPost(tenantId, {
    draft, meta, origin: opts.origin, memberId: member?.id ?? null, scheduledAt: opts.scheduledAt ?? null,
    rubric: opts.rubric ?? null, topic: opts.topic, run,
  })
  await audit(tenantId, 'ai', null, 'post.created', 'post', post.id, { origin: opts.origin, provider: meta.provider, facts: draft.facts.length })
  progress('Собираю карточку и отправляю на согласование…')
  const { sent } = await sendForApproval(tenantId, post.id)
  return { post, version, sent }
}

const handleMessage: Handler = async (job) => {
  const tenantId = job.tenantId!
  const member = await memberById(tenantId, String(job.payload.member_id))
  if (!member || member.status !== 'active') throw new PermanentError('Участник не найден или доступ отозван')
  const [msg] = await db.select().from(schema.messages)
    .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.id, String(job.payload.message_id))))
  if (!msg) throw new PermanentError('Сообщение не найдено')
  const tenant = await getTenant(tenantId)
  const run = newRun(job)

  const ctx = await buildContext(tenantId, { query: msg.text, memberId: member.id })
  if (ctx.history.at(-1)?.direction === 'in' && ctx.history.at(-1)?.text === msg.text) ctx.history.pop()
  const route = await aiRouteMessage(run, ctx, msg.text)
  await db.update(schema.messages).set({ intent: route.intent }).where(eq(schema.messages.id, msg.id))
  const say = (html: string, postId?: string | null, extra?: Record<string, unknown>) => sayToMember(member, html, { postId, extra })
  const sayMd = (md: string, postId?: string | null, extra?: Record<string, unknown>) => sayRich(member, md, { postId, extra })
  const STAGE: Partial<Record<string, string>> = {
    revise_post: 'Переписываю по комментарию…', create_plan: 'Составляю контент-план…', report: 'Собираю статистику…',
    video_script: 'Пишу сценарий ролика…', competitors: 'Смотрю, что у конкурентов…', status: 'Проверяю статусы…',
  }
  if (STAGE[route.intent]) progress(STAGE[route.intent]!)

  switch (route.intent) {
    case 'create_post': {
      const topic = route.params.topic || msg.text
      const scheduledAt = route.params.publish_now ? null : parseSchedule(route.params.schedule_at, tenant.timezone)
      const { post, sent } = await preparePost(run, member, {
        topic, instructions: route.params.instructions, scheduledAt, origin: 'user_request', requestText: msg.text,
      })
      if (sent && !member.roles.includes('approver')) await say('Пост готов и отправлен на согласование.', post.id)
      return { intent: route.intent, post_id: post.id }
    }

    case 'revise_post': {
      const open = await pendingApprovalFor(member)
      if (open) {
        const comment = route.params.instructions || msg.text
        const res = await submitChangeRequest(member, open.approvalId, comment)
        await say(res.ok
          ? `✏️ Принял правку к «${esc(open.title)}». Дорабатываю и пришлю новую версию на согласование.`
          : esc(res.reason ?? 'Эта карточка уже неактуальна'), open.postId)
        return { intent: route.intent, post_id: open.postId, via: 'approval' }
      }
      const last = ctx.lastPost
      if (!last) { await say('Пока нет поста, который можно изменить. Напишите, о чём подготовить пост.'); return { intent: route.intent } }
      const post = await getPost(tenantId, last.id)
      if (!post || !['draft', 'in_review', 'approved', 'scheduled'].includes(post.status)) {
        await say(`Последний пост «${esc(last.title)}» уже в статусе «${STATUS_LABELS[post?.status ?? 'published']}» — изменить его нельзя. Напишите, если нужно подготовить новый.`, last.id)
        return { intent: route.intent }
      }
      const instructions = route.params.instructions || msg.text
      if (post.kind === 'video_script') {
        await say('🎬 Переделываю ролик — пришлю новую версию на согласование.', post.id)
        const { video } = await makeVideo(run, member, { topic: post.topic ?? last.title, postId: post.id, comment: instructions })
        return { intent: route.intent, post_id: post.id, video: video.status }
      }
      const [prevVersion] = await db.select().from(schema.postVersions).where(eq(schema.postVersions.id, post.currentVersionId!))
      const ctx2 = await revisionContext(tenantId, last.topic ?? last.title, prevVersion!)
      const { draft: raw, meta } = await aiGeneratePost(run, ctx2, {
        topic: last.topic ?? last.title, rubric: post.rubric, previous: { title: last.title, text: last.text }, comment: instructions, format: prevVersion!.format,
      })
      const draft = await withSourceLink(tenantId, { ...raw, format: prevVersion!.format })
      draft.warnings = await checkDraft(tenantId, draft, { forbidden: ctx2.profile?.data.forbidden, contextText: `${msg.text} ${last.text}` })
      const newImage = /картин|изображен|фон|визуал|обложк/i.test(instructions)
      await addVersion(tenantId, post.id, { draft, meta, comment: instructions, run, keepImage: !newImage })
      const at = parseSchedule(route.params.schedule_at, tenant.timezone)
      if (at) await db.update(schema.posts).set({ scheduledAt: at }).where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, post.id)))
      else if (route.params.publish_now) await db.update(schema.posts).set({ scheduledAt: null }).where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, post.id)))
      await audit(tenantId, 'member', member.id, 'post.revised', 'post', post.id, { instructions })
      await sendForApproval(tenantId, post.id)
      if (!member.roles.includes('approver')) await say('Изменил и отправил на повторное согласование.', post.id)
      return { intent: route.intent, post_id: post.id }
    }

    case 'reschedule_post': {
      const last = ctx.lastPost
      const at = route.params.publish_now ? null : parseSchedule(route.params.schedule_at, tenant.timezone)
      if (!last) { await say('Пока нет поста, который можно перенести.'); return { intent: route.intent } }
      if (!at && !route.params.publish_now) { await say('Не понял, на какое время перенести. Напишите, например: «перенеси на завтра в 10:00».', last.id); return { intent: route.intent } }
      try {
        const { needsApproval } = await reschedulePost(tenantId, last.id, at)
        await say(`Перенёс «${esc(last.title)}» на ${humanTime(at, tenant.timezone)}.${needsApproval ? ' Время изменилось — отправляю на повторное согласование.' : ''}`, last.id)
        if (needsApproval) await sendForApproval(tenantId, last.id)
      }
      catch (e) {
        if (!(e instanceof PostStateError)) throw e
        await say(esc(e.message), last.id)
      }
      return { intent: route.intent, post_id: last.id }
    }

    case 'approve':
    case 'reject': {
      const r = await decideByMessage(member, route.intent === 'approve' ? 'a' : 'r', {
        at: route.params.publish_now ? 'now' : parseSchedule(route.params.schedule_at, tenant.timezone),
      })
      await say(r.text, r.postId)
      return { intent: route.intent, post_id: r.postId ?? null, ok: r.ok }
    }

    case 'status': {
      await sayMd(await statusText(tenantId, tenant.timezone))
      return { intent: route.intent }
    }

    case 'create_plan': {
      const result = await createPlan(run, tenantId, route.params.topic ?? route.params.instructions)
      await sendPlan(tenantId, [member], result)
      return { intent: route.intent, batch_id: result.batchId }
    }

    case 'report': {
      const text = await buildReport(run, tenantId, 7)
      await sayMd(text)
      return { intent: route.intent }
    }

    case 'video_script': {
      const topic = route.params.topic || msg.text
      await say('🎬 Пишу сценарий и собираю вертикальный ролик из фото компании — пришлю на согласование через минуту-две.')
      const { post, video } = await makeVideo(run, member, { topic, instructions: route.params.instructions })
      if (video.status !== 'ready') await say('Сценарий готов, но собрать ролик не получилось. Сценарий есть в кабинете, оператор уже знает.', post.id)
      else if (!member.roles.includes('approver')) await say('Ролик готов и отправлен на согласование.', post.id)
      return { intent: route.intent, post_id: post.id, video: video.status }
    }

    case 'competitors': {
      const rows = await db.select().from(schema.competitors).where(eq(schema.competitors.tenantId, tenantId))
      if (!rows.length) { await say('Конкуренты ещё не добавлены. Оператор может добавить их в админке — я изучу их открытые материалы.'); return { intent: route.intent } }
      const parts = rows.map((c) => {
        const a = c.analysis as { summary?: string, ideas_for_us?: string[] } | null
        if (!a) return `### ${mdEsc(c.name)}\n_Анализ ещё не готов._`
        const ideas = a.ideas_for_us?.length ? `\n\n${mdDetails('Идеи для нас', a.ideas_for_us.slice(0, 5).map(i => `- ${mdEsc(i)}`).join('\n'))}` : ''
        return `### ${mdEsc(c.name)}\n${mdEsc(a.summary ?? '')}${ideas}`
      })
      await sayMd(`## 🔎 Конкуренты\n\n${parts.join('\n\n---\n\n')}`)
      return { intent: route.intent }
    }

    default: {
      await sayMd(route.reply || 'Уточните, пожалуйста, что нужно сделать.')
      return { intent: route.intent, used_chunks: route.usedChunkIds.length }
    }
  }
}

function scriptText(data: VideoScriptOut): string {
  return [
    `Хронометраж: ${data.duration_sec} с`, `Крючок: ${data.hook}`, '',
    ...data.scenes.map(s => `${s.time} — ${s.visual}\n   В кадре: ${s.on_screen}\n   Текст: ${s.voiceover}`), '',
    `Нужные кадры для финальной версии: ${data.shots_needed.join('; ')}`, data.notes ? `Важно: ${data.notes}` : null,
  ].filter(x => x !== null).join('\n')
}

async function makeVideo(run: AiRun, member: Member | null, opts: { topic: string, instructions?: string | null, postId?: string, comment?: string }) {
  const tenantId = run.tenantId
  const tenant = await getTenant(tenantId)
  const ctx = await buildContext(tenantId, { query: opts.topic, history: false })
  const wishes = [opts.instructions, opts.comment && `Правка к прошлой версии: ${opts.comment}`].filter(Boolean).join('\n') || null
  const { data, meta } = await aiVideoScript(run, ctx, opts.topic, wishes)
  let video: PostVideo = { media_id: null, caption: data.caption, duration_sec: 0, status: 'failed', error: null }
  let coverMediaId: string | null = null
  try {
    progress('Собираю ролик: фото, озвучка, титры…')
    const r = await renderVideo({ tenant, script: data, run })
    const mp4 = await saveMedia(tenantId, 'generated', r.mp4, 'video/mp4', { ext: 'mp4', title: data.title, width: 720, height: 1280 })
    const cover = await saveMedia(tenantId, 'generated', r.cover, 'image/jpeg', { title: data.title, width: 720, height: 1280 })
    video = { media_id: mp4.id, caption: data.caption, duration_sec: r.durationSec, status: 'ready' }
    coverMediaId = cover.id
  }
  catch (e) {
    video.error = (e as Error).message.slice(0, 300)
    console.warn('[video] не удалось собрать ролик', video.error)
    await notifyOperator(tenantId, `[${tenant.name}] Ролик «${data.title}» не собрался: ${video.error}`).catch(() => {})
  }
  const draft = { title: data.title, text: scriptText(data), hashtags: [], facts: [], warnings: data.notes ? [data.notes] : [] }
  const post = opts.postId
    ? (await addVersion(tenantId, opts.postId, { draft, meta, comment: opts.comment ?? null, run, video: { video, coverMediaId } })).post
    : (await createPost(tenantId, {
        draft, meta, origin: member ? 'user_request' : 'schedule', kind: 'video_script', memberId: member?.id ?? null, topic: opts.topic,
        video, coverMediaId,
      })).post
  await audit(tenantId, 'ai', null, 'video.rendered', 'post', post.id, { status: video.status, duration: video.duration_sec })
  if (video.status === 'ready') await sendForApproval(tenantId, post.id)
  return { post, video }
}

export async function pendingApprovalFor(member: Member) {
  if (!member.roles.includes('approver')) return null
  const [row] = await db.select({
    approvalId: schema.approvals.id, postId: schema.posts.id, title: schema.postVersions.title, kind: schema.posts.kind,
  }).from(schema.approvals)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.approvals.postId))
    .innerJoin(schema.postVersions, eq(schema.postVersions.id, schema.approvals.versionId))
    .where(and(
      eq(schema.approvals.tenantId, member.tenantId), eq(schema.approvals.memberId, member.id), eq(schema.approvals.decision, 'pending'),
      eq(schema.posts.status, 'in_review'), eq(schema.posts.currentVersionId, schema.approvals.versionId),
    ))
    .orderBy(desc(schema.approvals.createdAt)).limit(1)
  return row ?? null
}

export async function decideByMessage(member: Member, action: 'a' | 'r', opts: { at?: Date | 'now' | null } = {}) {
  const open = await pendingApprovalFor(member)
  if (!open) {
    return { ok: false, postId: null as string | null, text: member.roles.includes('approver') ? 'Сейчас нет постов, которые ждут вашего решения.' : 'Решение по постам принимает согласующий компании.' }
  }
  const tenant = await getTenant(member.tenantId)
  if (action === 'a' && opts.at) {
    await db.update(schema.posts).set({ scheduledAt: opts.at === 'now' ? null : opts.at }).where(eq(schema.posts.id, open.postId))
  }
  const res = await decideApproval(open.approvalId, member.tgUserId, action)
  if (!res.ok) return { ok: false, postId: open.postId, text: esc(res.reason) }
  await audit(member.tenantId, 'member', member.id, 'approval.by_message', 'post', open.postId, { action, approval_id: open.approvalId })
  const what = open.kind === 'video_script' ? 'ролик' : 'пост'
  if (res.action === 'rejected') return { ok: true, postId: open.postId, text: `⛔ Отклонил ${what} «${esc(open.title)}». В канал он не попадёт.` }
  if (res.action === 'approved_partial') return { ok: true, postId: open.postId, text: `Ваше одобрение «${esc(open.title)}» учтено. Жду решения остальных согласующих.` }
  const [p] = await db.select({ scheduledAt: schema.posts.scheduledAt }).from(schema.posts).where(eq(schema.posts.id, open.postId))
  const when = p?.scheduledAt && p.scheduledAt.getTime() > Date.now() ? humanTime(p.scheduledAt, tenant.timezone) : 'в течение минуты'
  return { ok: true, postId: open.postId, text: `✅ Одобрил ${what} «${esc(open.title)}». Опубликую ${when} и пришлю ссылку.` }
}

export async function statusText(tenantId: string, tz: string): Promise<string> {
  const rows = await recentPosts(tenantId, 5)
  if (!rows.length) return 'Постов пока нет. Напишите, о чём подготовить пост.'
  const ICON: Partial<Record<string, string>> = { published: '✅', scheduled: '🕒', approved: '👍', in_review: '⏳', draft: '✏️', rejected: '✖️', failed: '⚠️' }
  const table = mdTable(['', 'Пост', 'Статус'], rows.map((p) => {
    const when = p.status === 'scheduled' || p.status === 'in_review' || p.status === 'approved' ? `, ${humanTime(p.scheduledAt, tz)}` : ''
    return [ICON[p.status] ?? '•', `${p.kind === 'video_script' ? '🎬 ' : ''}${mdCell((p.title || p.topic || 'Без названия').slice(0, 70))}`, mdCell(`${STATUS_LABELS[p.status]}${when}`)]
  }), ['c', 'l', 'l'])
  return `## 📋 Последние посты\n\n${table}`
}

async function revisionContext(tenantId: string, topic: string, prev: typeof schema.postVersions.$inferSelect) {
  const ctx = await buildContext(tenantId, { query: `${prev.title} ${topic}`, history: false })
  const cited = await chunksByIds(tenantId, prev.facts.map(f => f.chunk_id).filter((x): x is string => !!x))
  const seen = new Set<string>()
  ctx.chunks = [...cited, ...ctx.chunks].filter(c => !seen.has(c.id) && !!seen.add(c.id)).slice(0, 10)
  ctx.alias = makeAlias(ctx.chunks)
  return ctx
}

const TIME_WORDS = /завтра|сегодня|послезавтра|понедельник|вторник|сред[уыа]|четверг|пятниц|суббот|воскресен|\b\d{1,2}[:.]\d{2}\b|(?<!\p{L})(?:в|на|к) \d{1,2}(?!\d)|\d{1,2} час|перенес|опубликуй сразу|публикуй сейчас|опубликуй сейчас/iu

async function applyTiming(run: AiRun, tenantId: string, postId: string, comment: string): Promise<{ note: string | null }> {
  if (!TIME_WORDS.test(comment)) return { note: null }
  const tenant = await getTenant(tenantId)
  const ctx = await buildContext(tenantId, { history: false })
  const route = await aiRouteMessage(run, ctx, comment)
  const at = route.params.publish_now ? null : parseSchedule(route.params.schedule_at, tenant.timezone)
  if (!at && !route.params.publish_now) return { note: null }
  await db.update(schema.posts).set({ scheduledAt: at }).where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId)))
  await audit(tenantId, 'ai', null, 'post.rescheduled', 'post', postId, { at: at?.toISOString() ?? null, from: 'approval_comment' })
  return { note: `Время публикации система уже изменила на «${humanTime(at, tenant.timezone)}» — про перенос в тексте и предупреждениях не пиши.` }
}

const revisePost: Handler = async (job) => {
  const tenantId = job.tenantId!
  const postId = String(job.payload.post_id)
  const comment = String(job.payload.comment ?? '')
  const post = await getPost(tenantId, postId)
  if (!post?.currentVersionId) throw new PermanentError('Пост не найден')
  const [prev] = await db.select().from(schema.postVersions)
    .where(and(eq(schema.postVersions.tenantId, tenantId), eq(schema.postVersions.id, post.currentVersionId)))
  const run = newRun(job)
  const topic = post.topic ?? prev!.title
  if (post.kind === 'video_script') {
    try {
      const { video } = await makeVideo(run, null, { topic, postId, comment })
      return { video: video.status }
    }
    catch (e) {
      if (e instanceof PostStateError) throw new PermanentError(e.message)
      throw e
    }
  }
  const ctx = await revisionContext(tenantId, topic, prev!)
  const timing = await applyTiming(run, tenantId, postId, comment)
  const { draft: raw, meta } = await aiGeneratePost(run, ctx, { topic, rubric: post.rubric, previous: { title: prev!.title, text: prev!.text }, comment: timing.note ? `${comment}\n${timing.note}` : comment, format: prev!.format })
  const draft = await withSourceLink(tenantId, { ...raw, format: prev!.format })
  draft.warnings = await checkDraft(tenantId, draft, { forbidden: ctx.profile?.data.forbidden, contextText: `${comment} ${prev!.text}` })
  const newImage = /картин|изображен|фон|визуал|обложк/i.test(comment)
  try {
    const { version } = await addVersion(tenantId, postId, { draft, meta, comment, run, keepImage: !newImage })
    await sendForApproval(tenantId, postId)
    return { version: version.n }
  }
  catch (e) {
    if (e instanceof PostStateError) throw new PermanentError(e.message)
    throw e
  }
}

async function pickRubric(tenantId: string, rubrics: string[]): Promise<string | null> {
  if (!rubrics.length) return null
  const recent = await db.select({ rubric: schema.posts.rubric }).from(schema.posts)
    .where(eq(schema.posts.tenantId, tenantId)).orderBy(desc(schema.posts.createdAt)).limit(10)
  const used = recent.map(r => r.rubric)
  return [...rubrics].sort((a, b) => {
    const ia = used.indexOf(a), ib = used.indexOf(b)
    return (ia === -1 ? 999 : ia) < (ib === -1 ? 999 : ib) ? 1 : -1
  })[0] ?? null
}

const autoDraft: Handler = async (job) => {
  const tenantId = job.tenantId!
  const run = newRun(job)
  const profile = await getProfile(tenantId)
  const rubric = (job.payload.rubric as string) || await pickRubric(tenantId, profile?.data.rubrics ?? [])
  const ctx = await buildContext(tenantId, { query: `${rubric ?? ''} ${profile?.data.products?.slice(0, 5).join(' ') ?? ''} ${job.payload.hint ?? ''}`, history: false })
  const { data: pick } = await aiPickTopic(run, ctx, { rubric, recentTopics: await recentTopics(tenantId), hint: (job.payload.hint as string) ?? null })
  const { post, sent } = await preparePost(run, null, { topic: pick.topic, rubric: pick.rubric || rubric, origin: 'schedule' })
  return { post_id: post.id, topic: pick.topic, rubric: pick.rubric, cards_sent: sent }
}

async function createPlan(run: AiRun, tenantId: string, wishes?: string | null) {
  const profile = await getProfile(tenantId)
  const ctx = await buildContext(tenantId, { query: `${profile?.data.rubrics?.join(' ') ?? ''} ${profile?.data.products?.slice(0, 6).join(' ') ?? ''} ${wishes ?? ''}`, history: false, chunkLimit: 10 })
  const { data } = await aiCreatePlan(run, ctx, { wishes, recentTopics: await recentTopics(tenantId, 15), days: 7, count: 4 })
  const batchId = randomUUID()
  const items = data.items.filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.date)).slice(0, 7)
  if (!items.length) throw new PermanentError('Модель не предложила тем для плана')
  await db.insert(schema.planItems).values(items.map(i => ({
    tenantId, batchId, date: i.date, time: /^\d{2}:\d{2}$/.test(i.time) ? i.time : '10:00', rubric: i.rubric, topic: i.topic, reason: i.reason,
  })))
  await audit(tenantId, 'ai', null, 'plan.created', 'plan', batchId, { items: items.length })
  return { batchId, items, comment: data.comment }
}

async function sendPlan(tenantId: string, members: Member[], plan: Awaited<ReturnType<typeof createPlan>>) {
  const day = (d: string) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)).replace(/\./g, '')
  const table = mdTable(['Когда', 'Рубрика', 'Тема'], plan.items.map(i => [`**${day(i.date)}**, ${i.time}`, mdCell(i.rubric), mdCell(i.topic)]))
  const why = plan.items.map(i => `- **${mdEsc(i.topic)}** — ${mdEsc(i.reason)}`).join('\n')
  const md = [
    '## 🗓 Контент-план на неделю', table,
    mdDetails('Почему эти темы', why),
    plan.comment ? `> ${mdEsc(plan.comment).replace(/\n+/g, ' ')}` : '',
    '_После принятия я сам подготовлю каждый пост к его дате и пришлю на согласование._',
  ].filter(Boolean).join('\n\n')
  const kb = new InlineKeyboard().text('✅ Принять план', `pl:${plan.batchId}:a`).text('✖️ Не подходит', `pl:${plan.batchId}:x`)
  for (const m of members) await sayRich(m, md, { extra: { reply_markup: kb } })
}

const weeklyPlan: Handler = async (job) => {
  const tenantId = job.tenantId!
  const plan = await createPlan(newRun(job), tenantId, (job.payload.wishes as string) ?? null)
  const approvers = await activeMembers(tenantId, 'approver')
  await sendPlan(tenantId, approvers.length ? approvers : await activeMembers(tenantId), plan)
  return { batch_id: plan.batchId, items: plan.items.length }
}

const draftPlanItem: Handler = async (job) => {
  const tenantId = job.tenantId!
  const [item] = await db.select().from(schema.planItems)
    .where(and(eq(schema.planItems.tenantId, tenantId), eq(schema.planItems.id, String(job.payload.plan_item_id))))
  if (!item || item.status !== 'accepted') return { skipped: true }
  const tenant = await getTenant(tenantId)
  const at = parseSchedule(`${item.date}T${item.time}`, tenant.timezone)
  const { post } = await preparePost(newRun(job), null, { topic: item.topic, rubric: item.rubric, scheduledAt: at, origin: 'plan' })
  await db.update(schema.planItems).set({ status: 'drafted', postId: post.id }).where(eq(schema.planItems.id, item.id))
  return { post_id: post.id }
}

export async function collectMetrics(tenantId: string): Promise<{ subscribers: number | null, posts_updated: number }> {
  const stats = await refreshPostStats(tenantId).catch(() => ({ updated: 0 }))
  const integration = await activeIntegration(tenantId)
  if (!integration) return { subscribers: null, posts_updated: stats.updated }
  try {
    const count = await tg().getChatMemberCount(integration.externalId)
    await db.insert(schema.analyticsSnapshots).values({ tenantId, integrationId: integration.id, metric: 'subscribers', value: String(count) })
    return { subscribers: count, posts_updated: stats.updated }
  }
  catch { return { subscribers: null, posts_updated: stats.updated } }
}

export async function metricsSummary(tenantId: string, days: number) {
  const since = new Date(Date.now() - days * 86400_000)
  const postsRows = await db.select({ status: schema.posts.status, n: sql<number>`count(*)::int` }).from(schema.posts)
    .where(and(eq(schema.posts.tenantId, tenantId), gte(schema.posts.createdAt, since), eq(schema.posts.kind, 'post'))).groupBy(schema.posts.status)
  const byStatus = Object.fromEntries(postsRows.map(r => [r.status, r.n])) as Record<string, number>
  const decisions = await db.select({ decision: schema.approvals.decision, n: sql<number>`count(*)::int`, avg: sql<number>`coalesce(avg(extract(epoch from (${schema.approvals.decidedAt} - ${schema.approvals.createdAt}))), 0)::float` })
    .from(schema.approvals).where(and(eq(schema.approvals.tenantId, tenantId), gte(schema.approvals.createdAt, since))).groupBy(schema.approvals.decision)
  const d = Object.fromEntries(decisions.map(r => [r.decision, r])) as Record<string, { n: number, avg: number }>
  const [usage] = await db.select({
    calls: sql<number>`count(*)::int`, tokensIn: sql<number>`coalesce(sum(${schema.llmUsage.inputTokens}), 0)::int`,
    tokensOut: sql<number>`coalesce(sum(${schema.llmUsage.outputTokens}), 0)::int`, cost: sql<number>`coalesce(sum(${schema.llmUsage.costEstimate}), 0)::float`,
  }).from(schema.llmUsage).where(and(eq(schema.llmUsage.tenantId, tenantId), gte(schema.llmUsage.createdAt, since)))
  const subs = await db.select().from(schema.analyticsSnapshots)
    .where(and(eq(schema.analyticsSnapshots.tenantId, tenantId), eq(schema.analyticsSnapshots.metric, 'subscribers')))
    .orderBy(desc(schema.analyticsSnapshots.capturedAt)).limit(60)
  const latest = subs[0] ? Number(subs[0].value) : null
  const older = subs.find(s => s.capturedAt.getTime() <= since.getTime()) ?? subs.at(-1)
  const published = await db.select({ title: schema.postVersions.title, rubric: schema.posts.rubric, url: schema.publications.url, at: schema.publications.publishedAt })
    .from(schema.publications)
    .innerJoin(schema.posts, eq(schema.posts.id, schema.publications.postId))
    .innerJoin(schema.postVersions, eq(schema.postVersions.id, schema.publications.versionId))
    .where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.status, 'published'), gte(schema.publications.createdAt, since)))
    .orderBy(desc(schema.publications.publishedAt)).limit(20)
  const [commentsCount] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.comments)
    .where(and(eq(schema.comments.tenantId, tenantId), gte(schema.comments.createdAt, since)))
  return {
    days,
    created: Object.values(byStatus).reduce((a, b) => a + b, 0),
    published: byStatus.published ?? 0, rejected: byStatus.rejected ?? 0,
    waiting: (byStatus.in_review ?? 0) + (byStatus.draft ?? 0), scheduled: (byStatus.scheduled ?? 0) + (byStatus.approved ?? 0),
    failed: byStatus.failed ?? 0,
    approvals: { approved: d.approved?.n ?? 0, changes: d.changes_requested?.n ?? 0, rejected: d.rejected?.n ?? 0, avgApproveSec: Math.round(d.approved?.avg ?? 0) },
    usage: usage!,
    subscribers: latest, subscribersDelta: latest !== null && older && older !== subs[0] ? latest - Number(older.value) : null,
    comments: commentsCount?.n ?? 0,
    publishedPosts: published,
    performance: await postPerformance(tenantId, days, (await getTenant(tenantId)).timezone),
  }
}

export async function buildReport(run: AiRun, tenantId: string, days: number): Promise<string> {
  await collectMetrics(tenantId)
  const m = await metricsSummary(tenantId, days)
  const tenant = await getTenant(tenantId)
  const perf = await postPerformance(tenantId, days, tenant.timezone)
  const mins = (s: number) => s ? `${Math.max(1, Math.round(s / 60))} мин` : 'нет данных'
  const metricsText = [
    `Период: последние ${days} дней`,
    `Подготовлено постов: ${m.created}`, `Опубликовано: ${m.published}`, `Отклонено: ${m.rejected}`,
    `Возвращено на доработку (решений): ${m.approvals.changes}`, `Ожидают согласования: ${m.waiting}`, `Запланировано: ${m.scheduled}`,
    `Среднее время согласования: ${mins(m.approvals.avgApproveSec)}`,
    `Подписчики канала: ${m.subscribers ?? 'нет данных от площадки'}${m.subscribersDelta !== null ? ` (изменение за период: ${m.subscribersDelta >= 0 ? '+' : ''}${m.subscribersDelta})` : ''}`,
    perf.totals.views === null ? 'Просмотры постов: нет данных (канал закрытый или посты ещё не собраны)' : null,
    `Комментариев получено: ${m.comments}`,
    `Обращений к модели: ${m.usage.calls}, токенов: ${m.usage.tokensIn + m.usage.tokensOut}`,
    '',
    performanceText(perf),
  ].filter(x => x !== null).join('\n')
  const ctx = await buildContext(tenantId, { history: false })
  progress('Пишу выводы и гипотезы…')
  const { data } = await aiReport(run, ctx, metricsText)
  const delta = m.subscribersDelta !== null ? ` (${m.subscribersDelta >= 0 ? '+' : ''}${m.subscribersDelta})` : ''
  const rows: string[][] = [
    ['Подготовлено', String(m.created)], ['Опубликовано', String(m.published)], ['Отклонено', String(m.rejected)],
    ['На доработку', String(m.approvals.changes)], ['Среднее согласование', mins(m.approvals.avgApproveSec)],
    ['Подписчики', `${m.subscribers ?? '—'}${delta}`],
  ]
  if (perf.totals.views !== null) {
    rows.push(['Просмотры', `**${perf.totals.views}**`], ['В среднем на пост', String(perf.totals.avgViews ?? '—')],
      ['Реакции', String(perf.totals.reactions ?? 0)], ['Переходы на сайт', String(perf.totals.clicks)])
  }
  const best = [bestRow('Макет', perf.byTemplate), bestRow('Рубрика', perf.byRubric), bestRow('Время', perf.byDaypart)].filter((r): r is string[] => !!r)
  const top = perf.posts.filter(p => p.views !== null).sort((a, b) => b.views! - a.views!).slice(0, 3)
  const list = (title: string, items: string[], task = false) => items.length ? `### ${title}\n${items.map(i => `- ${task ? '[ ] ' : ''}${mdEsc(i)}`).join('\n')}` : ''
  return [
    `# 📊 Отчёт за ${days} дней`,
    mdTable(['Показатель', 'Значение'], rows, ['l', 'r']),
    best.length ? `### Что сработало лучше\n${mdTable(['', 'Лучший вариант', 'Просмотры'], best, ['l', 'l', 'r'])}` : '',
    top.length ? `### Топ постов\n${top.map((p, i) => `${i + 1}. ${p.url ? `[${mdEsc(p.title)}](${p.url})` : mdEsc(p.title)} — **${p.views}** просмотров${p.clicks ? `, ${p.clicks} переходов` : ''}`).join('\n')}` : '',
    `> ${mdEsc(data.summary).replace(/\n+/g, '\n> ')}`,
    list('Выводы', data.findings), list('Гипотезы', data.hypotheses), list('Что сделать', data.actions, true),
  ].filter(Boolean).join('\n\n')
}

function bestRow(label: string, stats: FormatStat[]): string[] | null {
  const withViews = stats.filter(s => s.avgViews !== null)
  if (withViews.length < 2) return null
  const b = withViews[0]!
  return [label, mdCell(b.label), String(b.avgViews)]
}



const weeklyReport: Handler = async (job) => {
  const tenantId = job.tenantId!
  const text = await buildReport(newRun(job), tenantId, Number(job.payload.days ?? 7))
  const members = await activeMembers(tenantId)
  for (const m of members) await sayRich(m, text)
  return { sent: members.length }
}

const collectMetricsJob: Handler = async job => collectMetrics(job.tenantId!)

async function listNewsLinks(pageUrl: string): Promise<Array<{ href: string, text: string }>> {
  const { res, url } = await fetchPublic(pageUrl, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; AIMarketerBot/1.0)' } })
    .catch((e) => { throw e instanceof IngestError ? new PermanentError(e.message) : e })
  if (!res.ok) throw new Error(`Страница новостей ответила кодом ${res.status}`)
  const { parseHTML } = await import('linkedom')
  const { document } = parseHTML(await res.text())
  const base = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  const seen = new Map<string, string>()
  for (const a of document.querySelectorAll('a[href]')) {
    let abs: URL
    try { abs = new URL(a.getAttribute('href')!, url) }
    catch { continue }
    if (abs.host !== url.host || !abs.pathname.startsWith(base) || abs.pathname === base) continue
    if (/\.(jpg|png|pdf|webp)$/i.test(abs.pathname) || abs.search.includes('PAGEN')) continue
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim()
    const key = abs.origin + abs.pathname
    if (text.length > (seen.get(key)?.length ?? 0)) seen.set(key, text)
  }
  return [...seen.entries()].map(([href, text]) => ({ href, text }))
}

const siteMonitor: Handler = async (job) => {
  const tenantId = job.tenantId!
  const scheduleId = job.scheduledJobId
  const pageUrl = String(job.payload.url ?? '')
  if (!pageUrl) throw new PermanentError('Не задан адрес раздела новостей')
  const links = await listNewsLinks(pageUrl)
  const [sched] = scheduleId ? await db.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.id, scheduleId)) : []
  const known = new Set<string>((sched?.params.seen as string[] | undefined) ?? [])
  const firstRun = known.size === 0
  const fresh = links.filter(l => !known.has(l.href))
  const target = fresh[0]
  if (sched) {
    const seen = [...new Set([...links.map(l => l.href), ...known])].slice(0, 400)
    await db.update(schema.scheduledJobs).set({ params: { ...sched.params, seen } }).where(eq(schema.scheduledJobs.id, sched.id))
  }
  if (!target) return { new_items: 0 }
  const hash = sha256(`url:${target.href}`)
  let [source] = await db.insert(schema.sources).values({ tenantId, kind: 'url', uri: target.href, title: target.text.slice(0, 200), contentHash: hash })
    .onConflictDoNothing().returning()
  if (!source) [source] = await db.select().from(schema.sources).where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.contentHash, hash)))
  if (source!.status !== 'ready') await ingestSource(tenantId, source!.id)
  const [fresh2] = await db.select().from(schema.sources).where(eq(schema.sources.id, source!.id))
  const topic = `Новость с сайта компании: ${fresh2!.title || target.text}`.slice(0, 200)
  const { post } = await preparePost(newRun(job), null, { topic, rubric: 'Новости', origin: 'schedule' })
  await audit(tenantId, 'system', null, 'site_monitor.new_item', 'source', source!.id, { url: target.href, first_run: firstRun })
  return { new_items: fresh.length, post_id: post.id, url: target.href }
}

const customTask: Handler = async (job) => {
  const tenantId = job.tenantId!
  const text = String(job.payload.text ?? '').trim()
  if (!text) throw new PermanentError('Не задан текст задачи')
  const run = newRun(job)
  const ctx = await buildContext(tenantId, { query: text, history: false })
  const route = await aiRouteMessage(run, ctx, text)
  const audience = async () => { const a = await activeMembers(tenantId, 'approver'); return a.length ? a : activeMembers(tenantId) }
  if (route.intent === 'create_post') {
    const { post } = await preparePost(run, null, { topic: route.params.topic || text, instructions: route.params.instructions, origin: 'schedule', requestText: text })
    return { intent: route.intent, post_id: post.id }
  }
  if (route.intent === 'create_plan') {
    const plan = await createPlan(run, tenantId, route.params.topic)
    await sendPlan(tenantId, await audience(), plan)
    return { intent: route.intent, batch_id: plan.batchId }
  }
  if (route.intent === 'video_script') {
    const { post, video } = await makeVideo(run, null, { topic: route.params.topic || text, instructions: route.params.instructions })
    return { intent: route.intent, post_id: post.id, video: video.status }
  }
  if (route.intent === 'report') {
    const report = await buildReport(run, tenantId, 7)
    for (const m of await audience()) await sayRich(m, report)
    return { intent: route.intent }
  }
  for (const m of await audience()) await sayRich(m, `### 🗓 Задача по расписанию\n> ${mdEsc(text)}\n\n${route.reply}`)
  return { intent: route.intent }
}

const analyzeCompetitor: Handler = async (job) => {
  const tenantId = job.tenantId!
  const [c] = await db.select().from(schema.competitors)
    .where(and(eq(schema.competitors.tenantId, tenantId), eq(schema.competitors.id, String(job.payload.competitor_id))))
  if (!c) throw new PermanentError('Конкурент не найден')
  if (c.url) {
    const hash = sha256(`competitor:${c.id}:${c.url}`)
    let [source] = await db.insert(schema.sources).values({ tenantId, kind: 'url', scope: 'competitor', uri: c.url, title: `Конкурент: ${c.name}`, contentHash: hash })
      .onConflictDoNothing().returning()
    if (!source) [source] = await db.select().from(schema.sources).where(and(eq(schema.sources.tenantId, tenantId), eq(schema.sources.contentHash, hash)))
    await ingestSource(tenantId, source!.id).catch((e) => { if (!(e instanceof IngestError)) throw e })
  }
  const all = await firstChunks(tenantId, 40, 'competitor')
  const mine = all.filter(ch => ch.title === `Конкурент: ${c.name}`).slice(0, 12)
  const extra = c.notes ? [{ id: 'notes', sourceId: 'notes', title: 'Заметки оператора', text: c.notes }] : []
  const ctx = await buildContext(tenantId, { history: false })
  const { data } = await aiCompetitor(newRun(job), ctx, c.name, [...mine, ...extra])
  await db.update(schema.competitors).set({ analysis: data, analyzedAt: new Date() }).where(eq(schema.competitors.id, c.id))
  await audit(tenantId, 'ai', null, 'competitor.analyzed', 'competitor', c.id, {})
  return { competitor: c.name, ideas: data.ideas_for_us.length }
}

const commentReply: Handler = async (job) => {
  const tenantId = job.tenantId!
  const [c] = await db.select().from(schema.comments)
    .where(and(eq(schema.comments.tenantId, tenantId), eq(schema.comments.id, String(job.payload.comment_id))))
  if (!c || c.status !== 'new') return { skipped: true }
  const tenant = await getTenant(tenantId)
  let postText = ''
  if (c.publicationId) {
    const [v] = await db.select({ text: schema.postVersions.text }).from(schema.publications)
      .innerJoin(schema.postVersions, eq(schema.postVersions.id, schema.publications.versionId))
      .where(and(eq(schema.publications.tenantId, tenantId), eq(schema.publications.id, c.publicationId)))
    postText = v?.text ?? ''
  }
  const ctx = await buildContext(tenantId, { query: c.text, history: false, chunkLimit: 5 })
  const { data } = await aiCommentReply(newRun(job), ctx, c.text, postText)
  if (!data.needs_reply || !data.reply.trim()) {
    await db.update(schema.comments).set({ status: 'ignored', sentiment: data.sentiment }).where(eq(schema.comments.id, c.id))
    return { sentiment: data.sentiment, reply: false }
  }
  await db.update(schema.comments).set({ status: 'drafted', sentiment: data.sentiment, replyDraft: data.reply }).where(eq(schema.comments.id, c.id))
  if (tenant.settings.auto_reply_comments) {
    await sendCommentReply(tenantId, c.id, 'system')
    return { sentiment: data.sentiment, reply: true, auto: true }
  }
  const kb = new InlineKeyboard().text('📨 Отправить ответ', `cm:${c.id}:s`).text('Пропустить', `cm:${c.id}:i`)
  for (const m of await activeMembers(tenantId, 'approver')) {
    const quote = mdEsc(c.text.slice(0, 600)).replace(/\n+/g, '\n> ')
    await sayRich(m, `### 💬 Комментарий под постом\n**${mdEsc(c.authorName || 'Подписчик')}** пишет:\n> ${quote}\n\n**Черновик ответа**\n\n${mdEsc(data.reply)}`, { extra: { reply_markup: kb } })
  }
  return { sentiment: data.sentiment, reply: true, auto: false }
}

export async function sendCommentReply(tenantId: string, commentId: string, actor: string): Promise<boolean> {
  const [c] = await db.update(schema.comments).set({ status: 'replied', repliedAt: new Date() })
    .where(and(eq(schema.comments.tenantId, tenantId), eq(schema.comments.id, commentId), eq(schema.comments.status, 'drafted'))).returning()
  if (!c?.replyDraft) return false
  try {
    await tg().sendMessage(c.externalChatId, c.replyDraft, { reply_parameters: { message_id: Number(c.externalMessageId) } })
    await audit(tenantId, actor === 'system' ? 'system' : 'member', actor, 'comment.replied', 'comment', c.id, {})
    return true
  }
  catch (e) {
    await db.update(schema.comments).set({ status: 'drafted', repliedAt: null }).where(eq(schema.comments.id, c.id))
    console.warn('[comment] не удалось отправить ответ', (e as Error).message)
    return false
  }
}

const publish: Handler = async job => publishPost(job.tenantId!, String(job.payload.post_id))

const voiceMessage: Handler = async (job) => {
  const tenantId = job.tenantId!
  const member = await memberById(tenantId, String(job.payload.member_id))
  if (!member || member.status !== 'active') throw new PermanentError('Участник не найден или доступ отозван')
  let audio: Buffer | null = null
  if (job.payload.file_id) {
    const file = await tg().getFile(String(job.payload.file_id))
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`Telegram не отдал файл: ${res.status}`)
    audio = Buffer.from(await res.arrayBuffer())
  }
  else audio = await readMedia(tenantId, String(job.payload.media_id ?? ''))
  if (!audio) throw new PermanentError('Аудио не найдено')
  let text = ''
  try { text = await transcribe(audio) }
  catch (e) {
    if (!(e instanceof VoiceError)) throw e
    await sayToMember(member, e.message.startsWith('Голосовые распознаёт') ? e.message : 'Не получилось разобрать голосовое. Попробуйте ещё раз или напишите текстом.')
    throw new UserNotifiedError(e.message)
  }
  if (text.length < 2) {
    await sayToMember(member, 'Не расслышал. Попробуйте ещё раз или напишите текстом.')
    return { text: '' }
  }
  if (job.payload.file_id) await sayToMember(member, `🎙 <i>${esc(text)}</i>`)
  const r = await acceptMemberText(member, text, { tgMessageId: (job.payload.tg_message_id as number) ?? null, dedupKey: `voice-msg:${job.id}` })
  return { text, kind: r.kind }
}

const agentPost: Handler = async (job) => {
  const tenantId = job.tenantId!
  const topic = String(job.payload.topic ?? '').trim()
  if (!topic) throw new PermanentError('Не задана тема поста')
  const at = job.payload.schedule_at ? new Date(String(job.payload.schedule_at)) : null
  const format = job.payload.format === 'classic' || job.payload.format === 'rich' ? job.payload.format : undefined
  const { post, sent } = await preparePost(newRun(job), null, {
    topic, instructions: (job.payload.instructions as string) ?? null, rubric: (job.payload.rubric as string) ?? null,
    scheduledAt: at && at.getTime() > Date.now() + 30_000 ? at : null, origin: 'operator', requestText: topic, format,
  })
  return { post_id: post.id, sent_for_approval: sent }
}

function withTyping(handler: Handler): Handler {
  return async (job) => {
    const member = job.tenantId && job.payload.member_id ? await memberById(job.tenantId, String(job.payload.member_id)).catch(() => null) : null
    const chatId = member?.tgChatId
    const ping = () => { if (chatId) tg().sendChatAction(chatId, 'typing').catch(() => {}) }
    ping()
    const timer = setInterval(ping, 4500)
    const first = job.type === 'voice_message' ? 'Слушаю голосовое…' : 'Читаю сообщение…'
    try { return await withThinking(chatId, first, () => handler(job)) }
    finally { clearInterval(timer) }
  }
}

export const handlers: Record<string, Handler> = {
  ingest_source: ingest,
  build_brand_profile: buildBrandProfile,
  handle_message: withTyping(handleMessage),
  revise_post: revisePost,
  agent_post: agentPost,
  auto_draft: autoDraft,
  weekly_plan: weeklyPlan,
  draft_plan_item: draftPlanItem,
  weekly_report: weeklyReport,
  collect_metrics: collectMetricsJob,
  site_monitor: siteMonitor,
  custom_task: customTask,
  analyze_competitor: analyzeCompetitor,
  comment_reply: commentReply,
  publish_post: publish,
  voice_message: withTyping(voiceMessage),
}

const JOB_LABELS: Record<string, string> = {
  ingest_source: 'обработка источника', build_brand_profile: 'профиль бренда', handle_message: 'ответ на сообщение', revise_post: 'доработка поста',
  agent_post: 'пост по запросу агента', auto_draft: 'пост по расписанию', weekly_plan: 'контент-план', draft_plan_item: 'пост по контент-плану',
  weekly_report: 'отчёт', collect_metrics: 'сбор метрик', site_monitor: 'мониторинг сайта', custom_task: 'задача по расписанию',
  analyze_competitor: 'анализ конкурента', comment_reply: 'ответ на комментарий', publish_post: 'публикация', voice_message: 'голосовое сообщение',
}

export async function reportJobFailure(job: JobRow, error: unknown) {
  if (!job.tenantId) return
  const tenant = await getTenant(job.tenantId).catch(() => null)
  const known = error instanceof LimitError
    ? 'Исчерпан дневной лимит запросов к модели.'
    : error instanceof ProviderError
      ? (error.kind === 'limit' ? 'Исчерпан лимит подписки у провайдера модели.' : error.kind === 'auth' ? 'Провайдер модели не авторизован.' : 'Сервис генерации сейчас недоступен.')
      : null
  const reason = error instanceof LimitError ? error.message : known ?? (error as Error).message
  const interactive = ['handle_message', 'revise_post', 'voice_message'].includes(job.type)
  if (interactive && job.payload.member_id && !(error instanceof UserNotifiedError)) {
    const m = await memberById(job.tenantId, String(job.payload.member_id))
    if (m) await sayToMember(m, `⚠️ Не получилось выполнить задачу. ${esc(known ?? 'Произошла техническая ошибка.')} Оператор уже знает, попробуйте позже.`)
  }
  if (job.type !== 'ingest_source') {
    await notifyOperator(job.tenantId, `[${tenant?.name ?? 'компания'}] Не выполнено: ${JOB_LABELS[job.type] ?? job.type}. Причина: ${reason}`)
  }
}

export { inArray }
