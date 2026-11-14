import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { InlineKeyboard } from 'grammy'
import type { MessageEntity } from 'grammy/types'
import type { AiRun, CallMeta } from '../ai/ops'
import type { CardOut } from '../ai/schemas'
import { hasUrl, trackLinks, trackLinksMarkdown } from '../analytics'
import { humanWarnings } from '../ai/humanize'
import { audit } from '../audit'
import { decryptSecret, isUuid } from '../crypto'
import { db, schema } from '../db/client'
import type { PostFact, PostFormat, PostGallery, PostStatus, PostVideo } from '../db/schema'
import { cardFor, drawCard, type DrawnCard, photoQuery, switchTemplate } from '../image/card'
import { findPhoto } from '../image/photos'
import type { CardTemplateId, PostCard } from '../image/card-templates'
import { enqueue } from '../jobs/queue'
import { chunksByIds } from '../kb/search'
import { readMedia, saveMedia } from '../media'
import { esc, GrammyError, HttpError, InputFile, sendText, tg } from '../telegram/api'
import { mdEntities, mdEsc, mdPlain, mdToHtml, sendRich } from '../telegram/rich'
import { emojiEntities, emojiHtml, emojiMarkdown, loadPack } from '../telegram/emoji-pack'
import { VkError } from '../vk/api'
import { sendToVk } from '../vk/publish'
import { classicText, GALLERY_MAX, pickGalleryPhotos, richMarkdown, richRejected, sendAlbum, sendRichWithMedia, slidesOf } from './post-media'
import { humanTime } from '../time'

type Post = typeof schema.posts.$inferSelect
type Version = typeof schema.postVersions.$inferSelect
type Tenant = typeof schema.tenants.$inferSelect
type Member = typeof schema.tenantMembers.$inferSelect

export interface DraftInput {
  title: string
  text: string
  hashtags: string[]
  image_prompt?: string | null
  facts: PostFact[]
  warnings: string[]
  card?: CardOut | null
  format?: PostFormat
  gallery?: PostGallery | null
}

export const STATUS_LABELS: Record<PostStatus, string> = {
  draft: 'черновик', in_review: 'на согласовании', approved: 'одобрен', scheduled: 'запланирован',
  publishing: 'публикуется', published: 'опубликован', failed: 'ошибка публикации', rejected: 'отклонён',
}

const CAPTION_LIMIT = 1024

export async function getTenant(tenantId: string): Promise<Tenant> {
  const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId))
  if (!t) throw new Error('Компания не найдена')
  return t
}

export async function getPost(tenantId: string, postId: string): Promise<Post | null> {
  const [p] = await db.select().from(schema.posts).where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId)))
  return p ?? null
}

async function getVersion(tenantId: string, versionId: string | null): Promise<Version | null> {
  if (!versionId) return null
  const [v] = await db.select().from(schema.postVersions)
    .where(and(eq(schema.postVersions.tenantId, tenantId), eq(schema.postVersions.id, versionId)))
  return v ?? null
}

export async function activeMembers(tenantId: string, role?: 'client' | 'approver'): Promise<Member[]> {
  const rows = await db.select().from(schema.tenantMembers)
    .where(and(eq(schema.tenantMembers.tenantId, tenantId), eq(schema.tenantMembers.status, 'active')))
  return role ? rows.filter(m => m.roles.includes(role)) : rows
}

export async function activeIntegration(tenantId: string, platform: 'telegram' | 'vk' | 'max' = 'telegram') {
  const [i] = await db.select().from(schema.integrations).where(and(
    eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.platform, platform), eq(schema.integrations.status, 'active'),
  )).limit(1)
  return i ?? null
}

export async function notifyOperator(tenantId: string | null, text: string) {
  const { config } = await import('../config')
  let chat = config.operatorAlertChatId
  if (tenantId) {
    const t = await getTenant(tenantId).catch(() => null)
    if (t?.settings.alert_chat_id) chat = t.settings.alert_chat_id
  }
  await audit(tenantId, 'system', null, 'operator.alert', null, null, { text })
  const html = `🛠 <b>Оператору</b>\n${esc(text)}`
  const sent = new Set<string>()
  if (chat) {
    sent.add(String(chat))
    await sendText(chat, html).catch(() => null)
  }
  const operators = await db.select({ tgUserId: schema.adminUsers.tgUserId }).from(schema.adminUsers)
    .where(isNotNull(schema.adminUsers.tgUserId)).catch(() => [])
  for (const { tgUserId } of operators) {
    if (!tgUserId || sent.has(String(tgUserId))) continue
    sent.add(String(tgUserId))
    await sendText(tgUserId, html).catch(() => null)
  }
}

export async function sayToMember(member: Pick<Member, 'id' | 'tenantId' | 'tgChatId'>, html: string, opts: { postId?: string | null, extra?: Record<string, unknown> } = {}) {
  const sent = await sendText(member.tgChatId, html, opts.extra)
  await db.insert(schema.messages).values({
    tenantId: member.tenantId, memberId: member.id, direction: 'out',
    text: html.replace(/<[^>]+>/g, ''), postId: opts.postId ?? null, tgMessageId: sent?.message_id ?? null,
  })
  return sent
}

export async function sayRich(member: Pick<Member, 'id' | 'tenantId' | 'tgChatId'>, markdown: string, opts: { postId?: string | null, extra?: Record<string, unknown> } = {}) {
  const sent = await sendRich(member.tgChatId, markdown, opts.extra)
  await db.insert(schema.messages).values({
    tenantId: member.tenantId, memberId: member.id, direction: 'out',
    text: mdPlain(markdown), postId: opts.postId ?? null, tgMessageId: sent?.message_id ?? null,
  })
  return sent
}

async function postAudience(post: Post): Promise<Member[]> {
  const members = await activeMembers(post.tenantId)
  const picked = members.filter(m => m.id === post.createdByMemberId || m.roles.includes('approver'))
  return picked.length ? picked : members
}

export async function checkDraft(
  tenantId: string, draft: DraftInput, opts: { forbidden?: string[], contextText?: string, platform?: string } = {},
): Promise<string[]> {
  const warnings = [...draft.warnings.filter(Boolean)]
  const full = `${draft.text}\n\n${draft.hashtags.join(' ')}`
  if (draft.format !== 'rich' && full.length > CAPTION_LIMIT) warnings.push(`Текст длиннее подписи к изображению (${full.length} знаков): будет отправлен отдельным сообщением`)
  for (const word of opts.forbidden ?? []) {
    const w = word.trim().toLowerCase()
    if (w.length >= 3 && w.length <= 40 && draft.text.toLowerCase().includes(w)) warnings.push(`В тексте есть запрещённое профилем: «${word}»`)
  }
  const cited = await chunksByIds(tenantId, draft.facts.map(f => f.chunk_id).filter((x): x is string => !!x))
  const general = draft.facts.filter(f => f.general)
  const evidence = `${cited.map(c => c.text).join('\n')}\n${general.map(f => f.claim).join('\n')}\n${opts.contextText ?? ''}`.replace(/[\s ]/g, '')
  const plain = draft.text.replace(/https?:\/\/\S+/g, ' ')
  const numbers = [...new Set(plain.match(/\d[\d\s .,]*\d|\d/g)?.map(n => n.replace(/[\s ]/g, '').replace(/[.,]$/, '')) ?? [])]
  const unconfirmed = numbers.filter(n => !evidence.includes(n) && !evidence.includes(n.replace(',', '.')))
  if (unconfirmed.length) warnings.push(`Проверьте цифры — их нет в материалах компании: ${unconfirmed.slice(0, 6).join(', ')}`)
  if (general.length) warnings.push(`Сверьте общеизвестные факты: ${general.slice(0, 4).map(f => `«${f.claim.slice(0, 80)}»`).join('; ')}`)
  const noSource = draft.facts.filter(f => !f.chunk_id && !f.general)
  if (noSource.length) warnings.push(`Не нашёл в материалах подтверждения: ${noSource.slice(0, 3).map(f => `«${f.claim.slice(0, 80)}»`).join('; ')}`)
  return humanWarnings(warnings)
}

export async function renderVersionImage(
  run: AiRun | null, tenant: Tenant, draft: DraftInput, rubric?: string | null,
  opts: { prevCard?: PostCard | null, newPhoto?: boolean, refresh?: boolean } = {},
) {
  const { template, fields } = cardFor({ title: draft.title, text: draft.text, rubric, card: draft.card }, opts.prevCard, { refresh: opts.refresh })
  const sameTemplate = opts.prevCard?.template === template
  return drawCard(tenant, { template, fields, photo: opts.prevCard?.photo, seen: opts.prevCard?.seen }, {
    run, newPhoto: opts.newPhoto || (!!opts.prevCard && !sameTemplate && !opts.prevCard.photo?.media_id),
    query: photoQuery(draft), prompt: draft.image_prompt,
  })
}

function versionCard(version: Version, rubric?: string | null): PostCard {
  if (version.card) return version.card
  const { template, fields } = cardFor({ title: version.title, text: version.text, rubric })
  return { template, fields, photo: null, seen: [] }
}

export interface CardPatch {
  template?: CardTemplateId
  fields?: Record<string, string>
  photo?: { action: 'next' } | { action: 'ai' } | { action: 'upload', buf: Buffer, mime: string, title?: string } | null
  custom?: { buf: Buffer, mime: string } | null
}

export async function updatePostCard(tenantId: string, postId: string, patch: CardPatch, actor: { type: 'operator' | 'member', id: string | null }) {
  const tenant = await getTenant(tenantId)
  const post = await getPost(tenantId, postId)
  if (!post?.currentVersionId) throw new PostStateError('Пост не найден')
  if (post.kind !== 'post') throw new PostStateError('У ролика нет карточки')
  if (!['draft', 'in_review', 'approved', 'scheduled'].includes(post.status)) throw new PostStateError('Пост уже опубликован, публикуется или отклонён — изменить его нельзя')
  const version = (await getVersion(tenantId, post.currentVersionId))!
  const card = versionCard(version, post.rubric)
  let fields = { ...card.fields }
  let template = card.template
  if (patch.template && patch.template !== card.template) {
    template = patch.template
    fields = switchTemplate(card, template, { title: version.title, text: version.text, rubric: post.rubric })
  }
  if (patch.fields) fields = { ...fields, ...patch.fields }
  let drawn: DrawnCard
  if (patch.custom) {
    const m = await saveMedia(tenantId, 'uploaded', patch.custom.buf, patch.custom.mime, { title: 'Готовая картинка' })
    drawn = { card: { ...card, custom: true }, mediaId: m.id, overflow: [], missing: [], imageMeta: { kind: 'template', source: 'custom' } }
  }
  else {
    drawn = await drawCard(tenant, { template, fields, photo: card.photo, seen: card.seen }, {
      run: { tenantId, calls: 0 },
      newPhoto: patch.photo?.action === 'next',
      generate: patch.photo?.action === 'ai',
      upload: patch.photo?.action === 'upload' ? patch.photo : null,
      query: photoQuery({ title: fields.title || version.title, image_prompt: version.imagePrompt }),
      prompt: version.imagePrompt || `${version.title}, photorealistic`,
    })
    if (patch.photo?.action === 'ai' && drawn.card.photo?.media_id === card.photo?.media_id) throw new PostStateError('Не получилось сгенерировать картинку. Попробуйте ещё раз через минуту')
  }
  const decided = await db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
    eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.versionId, version.id), eq(schema.approvals.decision, 'approved'),
  )).limit(1)
  const inPlace = ['draft', 'in_review'].includes(post.status) && !decided.length
  const what = patch.custom ? 'custom_image' : patch.photo?.action === 'next' ? 'photo.next' : patch.photo?.action === 'ai' ? 'photo.ai' : patch.photo?.action === 'upload' ? 'photo.upload' : patch.template ? 'template' : 'fields'
  await audit(tenantId, actor.type, actor.id, 'post.card_changed', 'post', postId, { change: what, template, in_place: inPlace })
  if (inPlace) {
    await db.update(schema.postVersions).set({
      card: drawn.card, imageMediaId: drawn.mediaId, generationMeta: { ...version.generationMeta, image: drawn.imageMeta },
    }).where(and(eq(schema.postVersions.tenantId, tenantId), eq(schema.postVersions.id, version.id)))
    return { ...drawn, newVersion: false }
  }
  const draft: DraftInput = {
    title: version.title, text: version.text, hashtags: version.hashtags, image_prompt: version.imagePrompt, facts: version.facts, warnings: version.warnings,
  }
  await addVersion(tenantId, postId, { draft, author: 'human', comment: 'Изменена карточка', image: drawn })
  await sendForApproval(tenantId, postId)
  return { ...drawn, newVersion: true }
}

export type LayoutPatch =
  | { format: PostFormat }
  | { gallery: { action: 'add' } | { action: 'generate', prompt?: string | null } | { action: 'upload', buf: Buffer, mime: string } | { action: 'remove', media_id: string } | { action: 'move', media_id: string, to: number } | { action: 'mode', mode: PostGallery['mode'] } }

export async function updatePostLayout(tenantId: string, postId: string, patch: LayoutPatch, actor: { type: 'operator' | 'member' | 'agent', id: string | null }) {
  const post = await getPost(tenantId, postId)
  if (!post?.currentVersionId) throw new PostStateError('Пост не найден')
  if (post.kind !== 'post') throw new PostStateError('У ролика нет карусели и журнального формата')
  if (!['draft', 'in_review', 'approved', 'scheduled'].includes(post.status)) throw new PostStateError('Пост уже опубликован, публикуется или отклонён — изменить его нельзя')
  const version = (await getVersion(tenantId, post.currentVersionId))!
  let format = version.format
  let gallery: PostGallery | null = version.gallery ? { ...version.gallery, media_ids: [...version.gallery.media_ids] } : null
  const ids = () => gallery?.media_ids ?? []
  const cardPhoto = version.card?.photo?.media_id ?? ''
  if ('format' in patch) {
    format = patch.format
    if (format === 'rich' && !ids().length) {
      const picked = await pickGalleryPhotos(tenantId, photoQuery({ title: version.title, image_prompt: version.imagePrompt }), [cardPhoto], 2)
      if (picked.length) gallery = { mode: 'slideshow', media_ids: picked }
    }
  }
  else {
    const g = patch.gallery
    if (g.action === 'add' || g.action === 'upload' || g.action === 'generate') {
      if (ids().length >= GALLERY_MAX) throw new PostStateError(`В карусели не больше ${GALLERY_MAX + 1} фото`)
      let id: string | undefined
      if (g.action === 'generate') {
        const angles = ['close-up detail shot', 'wide view in a real setting', 'product in use', 'macro texture and light']
        const base = g.prompt?.trim() || version.imagePrompt || `${version.title}, photorealistic`
        const tenant = await getTenant(tenantId)
        const pick = await findPhoto(tenant, { query: version.title, prompt: `${base}. Variation: ${angles[ids().length % angles.length]}`, run: { tenantId, calls: 0 }, generate: true })
        if (!pick) throw new PostStateError('Не получилось сгенерировать фото. Попробуйте ещё раз через минуту')
        id = pick.photo.media_id ?? undefined
      }
      else if (g.action === 'upload') id = (await saveMedia(tenantId, 'uploaded', g.buf, g.mime, { title: 'Фото для карусели' })).id
      else [id] = await pickGalleryPhotos(tenantId, photoQuery({ title: version.title, image_prompt: version.imagePrompt }), [cardPhoto, ...ids()], 1)
      if (!id) throw new PostStateError('В фотобанке компании больше нет подходящих фото — загрузите своё')
      gallery = { mode: gallery?.mode ?? 'slideshow', media_ids: [...ids(), id] }
    }
    else if (g.action === 'remove') {
      const rest = ids().filter(x => x !== g.media_id)
      gallery = rest.length ? { mode: gallery!.mode, media_ids: rest } : null
    }
    else if (g.action === 'move') {
      const list = ids().filter(x => x !== g.media_id)
      if (list.length === ids().length) throw new PostStateError('Фото нет в карусели')
      list.splice(Math.max(0, Math.min(g.to, list.length)), 0, g.media_id)
      gallery = { mode: gallery!.mode, media_ids: list }
    }
    else if (gallery) gallery = { ...gallery, mode: g.mode }
  }
  const decided = await db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
    eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.versionId, version.id), eq(schema.approvals.decision, 'approved'),
  )).limit(1)
  const inPlace = ['draft', 'in_review'].includes(post.status) && !decided.length
  await audit(tenantId, actor.type === 'agent' ? 'operator' : actor.type, actor.id, 'post.layout_changed', 'post', postId, {
    change: 'format' in patch ? `format.${patch.format}` : `gallery.${patch.gallery.action}`, photos: ids().length + 1, in_place: inPlace, via: actor.type,
  })
  if (inPlace) {
    await db.update(schema.postVersions).set({ format, gallery })
      .where(and(eq(schema.postVersions.tenantId, tenantId), eq(schema.postVersions.id, version.id)))
    return { format, gallery, newVersion: false }
  }
  const draft: DraftInput = {
    title: version.title, text: version.text, hashtags: version.hashtags, image_prompt: version.imagePrompt, facts: version.facts, warnings: version.warnings, format, gallery,
  }
  await addVersion(tenantId, postId, { draft, author: 'human', comment: 'format' in patch ? 'Изменён формат' : 'Изменена карусель', keepImage: true })
  await sendForApproval(tenantId, postId)
  return { format, gallery, newVersion: true }
}

export interface CreatePostInput {
  draft: DraftInput
  meta?: CallMeta | null
  origin: Post['origin']
  kind?: Post['kind']
  memberId?: string | null
  scheduledAt?: Date | null
  rubric?: string | null
  topic?: string | null
  run?: AiRun | null
  author?: 'ai' | 'human'
  video?: PostVideo | null
  coverMediaId?: string | null
}

export async function createPost(tenantId: string, input: CreatePostInput): Promise<{ post: Post, version: Version }> {
  const tenant = await getTenant(tenantId)
  const integration = await activeIntegration(tenantId) ?? await activeIntegration(tenantId, 'vk')
  const isScript = input.kind === 'video_script'
  const image = isScript ? null : await renderVersionImage(input.run ?? null, tenant, input.draft, input.rubric)
  const format: PostFormat = isScript ? 'classic' : input.draft.format ?? tenant.settings.post_format ?? 'rich'
  let gallery = input.draft.gallery ?? null
  if (format === 'rich' && input.draft.gallery === undefined && image) {
    const ids = await pickGalleryPhotos(tenantId, photoQuery(input.draft), [image.card.photo?.media_id ?? ''], 2)
    gallery = ids.length ? { mode: 'slideshow', media_ids: ids } : null
  }
  return db.transaction(async (tx) => {
    const [post] = await tx.insert(schema.posts).values({
      tenantId, kind: input.kind ?? 'post', status: 'draft', platform: integration?.platform ?? 'telegram', integrationId: integration?.id ?? null,
      scheduledAt: input.scheduledAt ?? null, origin: input.origin, createdByMemberId: input.memberId ?? null,
      rubric: input.rubric ?? null, topic: input.topic ?? input.draft.title,
    }).returning()
    const [version] = await tx.insert(schema.postVersions).values({
      tenantId, postId: post!.id, n: 1, title: input.draft.title, text: input.draft.text, hashtags: input.draft.hashtags,
      imagePrompt: input.draft.image_prompt ?? null, imageMediaId: image?.mediaId ?? input.coverMediaId ?? null, facts: input.draft.facts,
      warnings: input.draft.warnings, author: input.author ?? 'ai', card: image?.card ?? null, video: input.video ?? null,
      format, gallery,
      generationMeta: { ...(input.meta ?? {}), ...(image ? { image: image.imageMeta } : {}) },
    }).returning()
    const [updated] = await tx.update(schema.posts).set({ currentVersionId: version!.id }).where(eq(schema.posts.id, post!.id)).returning()
    return { post: updated!, version: version! }
  })
}

export class PostStateError extends Error {}

export async function addVersion(tenantId: string, postId: string, input: {
  draft: DraftInput, meta?: CallMeta | null, comment?: string | null, author?: 'ai' | 'human', run?: AiRun | null,
  keepImage?: boolean,
  image?: DrawnCard | null,
  video?: { video: PostVideo, coverMediaId: string | null } | null,
}): Promise<{ post: Post, version: Version }> {
  const tenant = await getTenant(tenantId)
  const post = await getPost(tenantId, postId)
  if (!post) throw new PostStateError('Пост не найден')
  const prev = await getVersion(tenantId, post.currentVersionId)
  let imageMediaId = prev?.imageMediaId ?? null
  let imageMeta = prev?.generationMeta.image
  let card = prev?.card ?? null
  let video = prev?.video ?? null
  if (input.video) {
    video = input.video.video
    imageMediaId = input.video.coverMediaId ?? imageMediaId
  }
  const textChanged = prev?.title !== input.draft.title || prev?.text !== input.draft.text
  if (input.image) {
    imageMediaId = input.image.mediaId
    imageMeta = input.image.imageMeta
    card = input.image.card
  }
  else if (post.kind === 'post' && !card?.custom && (!input.keepImage || textChanged || !imageMediaId || input.draft.card)) {
    const manual = input.keepImage === true && !input.draft.card
    const prevCard = manual && card && prev?.title !== input.draft.title && card.fields.title === prev?.title
      ? { ...card, fields: { ...card.fields, title: input.draft.title } }
      : card
    const img = await renderVersionImage(input.run ?? null, tenant, input.draft, post.rubric, {
      prevCard, refresh: textChanged && !manual, newPhoto: input.keepImage === false,
    })
    imageMediaId = img.mediaId
    imageMeta = img.imageMeta
    card = img.card
  }
  return db.transaction(async (tx) => {
    const [locked] = await tx.update(schema.posts)
      .set({ status: 'draft', approvedVersionId: null })
      .where(and(
        eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId),
        inArray(schema.posts.status, ['draft', 'in_review', 'approved', 'scheduled']),
      )).returning()
    if (!locked) throw new PostStateError('Пост уже опубликован, публикуется или отклонён — изменить его нельзя')
    await tx.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() })
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.postId, postId), eq(schema.approvals.decision, 'pending')))
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${schema.postVersions.n}), 0)::int` })
      .from(schema.postVersions).where(eq(schema.postVersions.postId, postId)) as [{ n: number }]
    const [version] = await tx.insert(schema.postVersions).values({
      tenantId, postId, n: n + 1, title: input.draft.title, text: input.draft.text, hashtags: input.draft.hashtags,
      imagePrompt: input.draft.image_prompt ?? prev?.imagePrompt ?? null, imageMediaId, facts: input.draft.facts,
      warnings: input.draft.warnings, author: input.author ?? 'ai', comment: input.comment ?? null, card, video,
      format: input.draft.format ?? prev?.format ?? 'classic',
      gallery: input.draft.gallery !== undefined ? input.draft.gallery : prev?.gallery ?? null,
      generationMeta: { ...(input.meta ?? {}), ...(imageMeta ? { image: imageMeta } : {}) },
    }).returning()
    const [updated] = await tx.update(schema.posts).set({ currentVersionId: version!.id }).where(eq(schema.posts.id, postId)).returning()
    return { post: updated!, version: version! }
  })
}

function approvalKeyboard(approvalId: string, publicBaseUrl: string) {
  const kb = new InlineKeyboard()
    .text('✅ Одобрить', `ap:${approvalId}:a`)
    .text('✏️ На доработку', `ap:${approvalId}:c`).row()
    .text('⛔ Отклонить', `ap:${approvalId}:r`)
  if (publicBaseUrl.startsWith('https://')) kb.row().webApp('📱 Открыть в кабинете', `${publicBaseUrl}/app`)
  return kb
}

async function channelLabel(post: Post): Promise<string> {
  const label = (i: typeof schema.integrations.$inferSelect) => i.platform === 'vk'
    ? `ВКонтакте, ${i.username ? `vk.com/${i.username}` : i.title}`
    : `Telegram, ${i.username ? `@${i.username}` : i.title || i.externalId}`
  const all = await db.select().from(schema.integrations)
    .where(and(eq(schema.integrations.tenantId, post.tenantId), eq(schema.integrations.status, 'active')))
  const main = all.find(i => i.id === post.integrationId)
  if (!main) return 'канал не подключён'
  const extra = main.platform === 'telegram' ? all.filter(i => i.platform === 'vk') : []
  return [main, ...extra].map(label).join(' + ')
}

function cardFooterLines(post: Post, version: Version, tenant: Tenant, channel: string): string[] {
  const sources = [...new Set(version.facts.map(f => f.source_title).filter(Boolean))]
  const lines = [
    `📍 Площадка: ${channel}`,
    `🕒 Время: ${humanTime(post.scheduledAt, tenant.timezone)}`,
  ]
  const photos = (version.gallery?.media_ids.length ?? 0) + 1
  if (version.format === 'rich' && post.kind === 'post') lines.push(`📰 Формат: журнальный${photos > 1 ? `, карусель из ${photos} фото` : ''}`)
  else if (photos > 1) lines.push(`🖼 Карусель из ${photos} фото`)
  if (sources.length) lines.push(`📚 Факты из источников: ${sources.slice(0, 3).map(s => `«${String(s).slice(0, 50)}»`).join(', ')}`)
  for (const w of version.warnings.slice(0, 4)) lines.push(`⚠️ ${w}`)
  lines.push('🎙 Можно ответить текстом или голосом: «одобряю», «отклоняю» или что поправить.')
  return lines
}

export function cardFooter(post: Post, version: Version, tenant: Tenant, channel: string): string {
  return cardFooterLines(post, version, tenant, channel).map(esc).join('\n')
}

export function postBody(version: Version): string {
  const main = version.video?.status === 'ready' ? version.video.caption : classicText(version.format, version.text)
  return [main.trim(), version.hashtags.join(' ')].filter(Boolean).join('\n\n')
}

export async function withSourceLink(tenantId: string, draft: DraftInput): Promise<DraftInput> {
  if (hasUrl(draft.text)) return draft
  const ids = draft.facts.map(f => f.chunk_id).filter((x): x is string => !!x)
  if (!ids.length) return draft
  const rows = await db.select({ uri: schema.sources.uri, n: sql<number>`count(*)::int` }).from(schema.kbChunks)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.kbChunks.sourceId))
    .where(and(
      eq(schema.kbChunks.tenantId, tenantId), inArray(schema.kbChunks.id, ids),
      eq(schema.sources.kind, 'url'), eq(schema.sources.scope, 'company'),
    ))
    .groupBy(schema.sources.uri).orderBy(desc(sql`count(*)`)).limit(1)
  const uri = rows[0]?.uri
  if (!uri || !/^https?:\/\//.test(uri)) return draft
  const link = /\.(pdf|docx?|xlsx?|pptx?|zip|rar)(\?|$)/i.test(uri) ? `${new URL(uri).origin}/` : uri
  return { ...draft, text: `${draft.text.trim()}\n\nПодробнее: ${link}` }
}

export async function sendForApproval(tenantId: string, postId: string): Promise<{ sent: number }> {
  const tenant = await getTenant(tenantId)
  const post = await getPost(tenantId, postId)
  if (!post?.currentVersionId) throw new PostStateError('Пост не найден')
  const version = (await getVersion(tenantId, post.currentVersionId))!
  const approvers = await activeMembers(tenantId, 'approver')
  if (!approvers.length) {
    await notifyOperator(tenantId, `У компании «${tenant.name}» нет согласующих: пост «${version.title}» остаётся черновиком.`)
    for (const m of await activeMembers(tenantId)) {
      await sayToMember(m, 'Пост готов, но в компании нет согласующего. Попросите оператора назначить его.', { postId }).catch(() => null)
    }
    return { sent: 0 }
  }
  await db.update(schema.posts).set({ status: 'in_review' })
    .where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId), inArray(schema.posts.status, ['draft', 'in_review'])))

  const channel = await channelLabel(post)
  const head = `<b>На согласование</b> · версия ${version.n}${post.origin === 'schedule' ? ' · по расписанию' : ''}${post.kind === 'video_script' ? ' · сценарий видео' : ''}`
  const footer = cardFooter(post, version, tenant, channel)
  const body = version.video?.status === 'ready' ? esc(postBody(version)) : [mdToHtml(version.text), esc(version.hashtags.join(' '))].filter(Boolean).join('\n\n')
  const caption = `${head}\n\n${body}\n\n${footer}`
  const image = await readMedia(tenantId, version.imageMediaId)
  const video = version.video?.status === 'ready' ? await readMedia(tenantId, version.video.media_id) : null
  const slides = post.kind === 'post' && !video ? slidesOf(version) : []
  let useRich = version.format === 'rich' && post.kind === 'post' && !video
  const richCard = [
    `### 📝 На согласование · версия ${version.n}${post.origin === 'schedule' ? ' · по расписанию' : ''}`,
    richMarkdown(version.text, version.hashtags, slides, version.gallery?.mode),
    '---',
    cardFooterLines(post, version, tenant, channel).map(l => `> ${mdEsc(l)}`).join('\n>\n'),
  ].join('\n\n')
  const pack = await loadPack(tenant.settings.emoji_pack)
  const richCardE = pack ? emojiMarkdown(richCard, pack) : richCard
  const captionE = pack ? emojiHtml(caption, pack) : caption
  async function withEmoji<T>(send: (text: string) => Promise<T>, plain: string, styled: string): Promise<T> {
    if (styled === plain) return send(plain)
    try { return await send(styled) }
    catch (e) {
      if (!(e instanceof GrammyError) || e.error_code !== 400) throw e
      console.warn('[approval] значки набора эмодзи не приняты, отправляю обычными:', e.description)
      return send(plain)
    }
  }

  let sent = 0
  for (const member of approvers) {
    const [open] = await db.select({ id: schema.approvals.id }).from(schema.approvals).where(and(
      eq(schema.approvals.versionId, version.id), eq(schema.approvals.memberId, member.id), eq(schema.approvals.decision, 'pending'),
    ))
    if (open) continue
    const [approval] = await db.insert(schema.approvals)
      .values({ tenantId, postId, versionId: version.id, memberId: member.id, tgChatId: member.tgChatId }).returning()
    if (!approval) continue
    const keyboard = approvalKeyboard(approval.id, (await import('../config')).config.publicBaseUrl)
    try {
      let messageId: number | null = null
      if (useRich) {
        try { messageId = await withEmoji(md => sendRichWithMedia(tg(), member.tgChatId, md, slides, tenantId, { reply_markup: keyboard }), richCard, richCardE) }
        catch (e) {
          if (!richRejected(e)) throw e
          console.warn('[approval] rich-карточка не принята, отправляю обычной', (e as Error).message)
          useRich = false
        }
      }
      if (messageId !== null) {}
      else if (slides.length > 1) {
        await sendAlbum(tg(), member.tgChatId, slides, tenantId)
        const m = await withEmoji(c => tg().sendMessage(member.tgChatId, c.slice(0, 4000), { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } }), caption, captionE)
        messageId = m.message_id
      }
      else if (video && caption.length <= CAPTION_LIMIT) {
        const m = await withEmoji(c => tg().sendVideo(member.tgChatId, new InputFile(video, 'video.mp4'), {
          caption: c, parse_mode: 'HTML', reply_markup: keyboard, supports_streaming: true, width: 720, height: 1280, duration: version.video!.duration_sec,
        }), caption, captionE)
        messageId = m.message_id
      }
      else if (image && caption.length <= CAPTION_LIMIT) {
        const m = await withEmoji(c => tg().sendPhoto(member.tgChatId, new InputFile(image, 'post.png'), { caption: c, parse_mode: 'HTML', reply_markup: keyboard }), caption, captionE)
        messageId = m.message_id
      }
      else {
        if (video) await tg().sendVideo(member.tgChatId, new InputFile(video, 'video.mp4'), { supports_streaming: true, width: 720, height: 1280, duration: version.video!.duration_sec })
        else if (image) await tg().sendPhoto(member.tgChatId, new InputFile(image, 'post.png'))
        const m = await withEmoji(c => tg().sendMessage(member.tgChatId, c.slice(0, 4000), { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } }), caption, captionE)
        messageId = m.message_id
      }
      if (messageId === null) throw new Error('Telegram не принял карточку')
      await db.update(schema.approvals).set({ tgMessageId: messageId }).where(eq(schema.approvals.id, approval.id))
      await db.insert(schema.messages).values({
        tenantId, memberId: member.id, direction: 'out', postId, tgMessageId: messageId,
        text: `📋 Прислал на согласование ${post.kind === 'video_script' ? 'ролик' : 'пост'} «${version.title}»${version.n > 1 ? ` (версия ${version.n})` : ''}`,
      })
      sent++
    }
    catch (e) {
      console.warn('[approval] не удалось отправить карточку', member.id, (e as Error).message)
    }
  }
  await audit(tenantId, 'system', null, 'post.sent_for_approval', 'post', postId, { version: version.n, approvers: sent })
  return { sent }
}

export async function resendForApproval(tenantId: string, postId: string, actor: { type: 'operator' | 'member', id: string | null }) {
  const post = await getPost(tenantId, postId)
  if (!post) throw new PostStateError('Пост не найден')
  if (!['draft', 'in_review'].includes(post.status)) throw new PostStateError('Пост уже одобрен или опубликован — отправлять на согласование не нужно')
  const stale = await db.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() })
    .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.postId, postId), eq(schema.approvals.decision, 'pending'))).returning()
  for (const a of stale) await closeCard(a, '↻ Обновлено — смотрите новую карточку')
  await audit(tenantId, actor.type, actor.id, 'post.resent_for_approval', 'post', postId, { closed: stale.length })
  return sendForApproval(tenantId, postId)
}

async function closeCard(approval: typeof schema.approvals.$inferSelect, label: string) {
  if (!approval.tgChatId || !approval.tgMessageId) return
  await tg().editMessageReplyMarkup(approval.tgChatId, approval.tgMessageId, {
    reply_markup: new InlineKeyboard().text(label.slice(0, 60), 'noop'),
  }).catch(() => {})
}

export type DecisionResult =
  | { ok: false, reason: string }
  | { ok: true, action: 'approved' | 'rejected' | 'awaiting_comment' | 'approved_partial', postId: string }

export async function decideApproval(approvalId: string, tgUserId: number, action: 'a' | 'c' | 'r', comment?: string | null): Promise<DecisionResult> {
  if (!isUuid(approvalId)) return { ok: false, reason: 'Некорректная кнопка' }
  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId))
  if (!approval) return { ok: false, reason: 'Согласование не найдено' }
  const [member] = await db.select().from(schema.tenantMembers).where(eq(schema.tenantMembers.id, approval.memberId))
  if (!member || member.tgUserId !== tgUserId || member.tenantId !== approval.tenantId) {
    await audit(approval.tenantId, 'member', String(tgUserId), 'access.denied', 'approval', approvalId, { reason: 'foreign_approval' })
    return { ok: false, reason: 'Нет доступа к этому согласованию' }
  }
  if (member.status !== 'active' || !member.roles.includes('approver')) {
    await audit(approval.tenantId, 'member', member.id, 'access.denied', 'approval', approvalId, { reason: 'no_role' })
    return { ok: false, reason: 'У вас нет права согласования' }
  }
  if (approval.decision !== 'pending') return { ok: false, reason: 'Решение по этой карточке уже принято' }
  const tenantId = approval.tenantId
  const post = await getPost(tenantId, approval.postId)
  if (!post || post.currentVersionId !== approval.versionId || post.status !== 'in_review') {
    return { ok: false, reason: 'Эта версия уже неактуальна' }
  }
  const tenant = await getTenant(tenantId)
  const who = member.displayName || 'согласующий'
  const stamp = humanTime(new Date(), tenant.timezone)

  if (action === 'c') {
    await db.insert(schema.dialogStates).values({ tenantId, memberId: member.id, state: 'awaiting_comment', payload: { approval_id: approvalId } })
      .onConflictDoUpdate({ target: schema.dialogStates.memberId, set: { state: 'awaiting_comment', payload: { approval_id: approvalId }, updatedAt: new Date() } })
    return { ok: true, action: 'awaiting_comment', postId: post.id }
  }

  if (action === 'r') {
    const done = await db.transaction(async (tx) => {
      const [upd] = await tx.update(schema.approvals).set({ decision: 'rejected', decidedAt: new Date(), comment: comment?.trim().slice(0, 1000) || null })
        .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.decision, 'pending'))).returning()
      if (!upd) return false
      await tx.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() })
        .where(and(eq(schema.approvals.versionId, approval.versionId), eq(schema.approvals.decision, 'pending')))
      await tx.update(schema.posts).set({ status: 'rejected', approvedVersionId: null })
        .where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, post.id)))
      return true
    })
    if (!done) return { ok: false, reason: 'Решение по этой карточке уже принято' }
    await closeOtherCards(approval.versionId, approvalId, `⛔ Отклонено — ${who}`)
    await closeCard(approval, `⛔ Отклонено — ${who}, ${stamp}`)
    await audit(tenantId, 'member', member.id, 'approval.rejected', 'post', post.id, { approval_id: approvalId, reason: comment?.trim() || null })
    return { ok: true, action: 'rejected', postId: post.id }
  }

  const result = await db.transaction(async (tx) => {
    const [upd] = await tx.update(schema.approvals).set({ decision: 'approved', decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.decision, 'pending'))).returning()
    if (!upd) return 'gone' as const
    const pending = await tx.select({ id: schema.approvals.id }).from(schema.approvals)
      .where(and(eq(schema.approvals.versionId, approval.versionId), eq(schema.approvals.decision, 'pending')))
    if (tenant.settings.approval_rule === 'all' && pending.length) return 'partial' as const
    await tx.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() })
      .where(and(eq(schema.approvals.versionId, approval.versionId), eq(schema.approvals.decision, 'pending')))
    const future = post.scheduledAt && post.scheduledAt.getTime() > Date.now()
    const [p] = await tx.update(schema.posts)
      .set({ status: future ? 'scheduled' : 'approved', approvedVersionId: approval.versionId })
      .where(and(
        eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, post.id),
        eq(schema.posts.status, 'in_review'), eq(schema.posts.currentVersionId, approval.versionId),
      )).returning()
    return p ? 'approved' as const : 'gone' as const
  })
  if (result === 'gone') return { ok: false, reason: 'Эта версия уже неактуальна' }
  await closeCard(approval, `✅ Одобрено — ${who}, ${stamp}`)
  await audit(tenantId, 'member', member.id, 'approval.approved', 'post', post.id, { approval_id: approvalId, version_id: approval.versionId })
  if (result === 'partial') return { ok: true, action: 'approved_partial', postId: post.id }
  await closeOtherCards(approval.versionId, approvalId, `✅ Одобрено — ${who}`)
  return { ok: true, action: 'approved', postId: post.id }
}

async function closeOtherCards(versionId: string, exceptApprovalId: string, label: string) {
  const others = await db.select().from(schema.approvals).where(eq(schema.approvals.versionId, versionId))
  for (const a of others) if (a.id !== exceptApprovalId && a.decision === 'superseded') await closeCard(a, label)
}

export async function submitChangeRequest(member: Member, approvalId: string, comment: string): Promise<{ ok: boolean, reason?: string, postId?: string }> {
  const [approval] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.tenantId, member.tenantId), eq(schema.approvals.memberId, member.id)))
  if (!approval || approval.decision !== 'pending') return { ok: false, reason: 'Эта карточка уже неактуальна' }
  const post = await getPost(member.tenantId, approval.postId)
  if (!post || post.currentVersionId !== approval.versionId) return { ok: false, reason: 'Эта версия уже неактуальна' }
  await db.transaction(async (tx) => {
    await tx.update(schema.approvals).set({ decision: 'changes_requested', comment, decidedAt: new Date() }).where(eq(schema.approvals.id, approvalId))
    await tx.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() })
      .where(and(eq(schema.approvals.versionId, approval.versionId), eq(schema.approvals.decision, 'pending')))
    await tx.update(schema.posts).set({ status: 'draft', approvedVersionId: null })
      .where(and(eq(schema.posts.tenantId, member.tenantId), eq(schema.posts.id, post.id)))
  })
  await closeCard(approval, `✏️ На доработку — ${member.displayName || 'согласующий'}`)
  await closeOtherCards(approval.versionId, approvalId, '✏️ Возвращено на доработку')
  await audit(member.tenantId, 'member', member.id, 'approval.changes_requested', 'post', post.id, { comment })
  await enqueue({
    tenantId: member.tenantId, type: 'revise_post', dedupKey: `rev:${approvalId}`,
    payload: { post_id: post.id, comment, member_id: member.id },
  })
  return { ok: true, postId: post.id }
}

export async function reschedulePost(tenantId: string, postId: string, at: Date | null, opts: { keepApproval?: boolean } = {}): Promise<{ needsApproval: boolean }> {
  const post = await getPost(tenantId, postId)
  if (!post) throw new PostStateError('Пост не найден')
  if (!['draft', 'in_review', 'approved', 'scheduled'].includes(post.status)) {
    throw new PostStateError(`Пост в статусе «${STATUS_LABELS[post.status]}» — перенести нельзя`)
  }
  if (opts.keepApproval) {
    const future = at && at.getTime() > Date.now()
    const status = post.status === 'approved' || post.status === 'scheduled' ? (future ? 'scheduled' as const : 'approved' as const) : post.status
    const [upd] = await db.update(schema.posts).set({ scheduledAt: at, status })
      .where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId), inArray(schema.posts.status, ['draft', 'in_review', 'approved', 'scheduled']))).returning()
    if (!upd) throw new PostStateError('Пост уже публикуется — перенести нельзя')
    await audit(tenantId, 'system', null, 'post.rescheduled', 'post', postId, { at: at?.toISOString() ?? null, kept_approval: true })
    return { needsApproval: false }
  }
  const wasApproved = post.status === 'approved' || post.status === 'scheduled' || post.status === 'in_review'
  await db.transaction(async (tx) => {
    const [upd] = await tx.update(schema.posts)
      .set({ scheduledAt: at, ...(wasApproved ? { status: 'draft' as const, approvedVersionId: null } : {}) })
      .where(and(eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId), inArray(schema.posts.status, ['draft', 'in_review', 'approved', 'scheduled'])))
      .returning()
    if (!upd) throw new PostStateError('Пост уже публикуется — перенести нельзя')
    if (wasApproved) {
      await tx.update(schema.approvals).set({ decision: 'superseded', decidedAt: new Date() })
        .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.postId, postId), eq(schema.approvals.decision, 'pending')))
    }
  })
  await audit(tenantId, 'system', null, 'post.rescheduled', 'post', postId, { at: at?.toISOString() ?? null })
  return { needsApproval: wasApproved }
}

export async function publishNow(tenantId: string, postId: string, actor: { type: 'operator' | 'member', id: string | null }) {
  const [upd] = await db.update(schema.posts).set({ scheduledAt: new Date(), status: 'approved' }).where(and(
    eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId), eq(schema.posts.kind, 'post'),
    inArray(schema.posts.status, ['approved', 'scheduled']),
    sql`${schema.posts.approvedVersionId} IS NOT NULL AND ${schema.posts.approvedVersionId} = ${schema.posts.currentVersionId}`,
  )).returning()
  if (!upd) throw new PostStateError('Отправить сейчас можно только одобренный пост, который ещё не вышел')
  await audit(tenantId, actor.type, actor.id, 'post.publish_now', 'post', postId, {})
  await enqueue({ tenantId, type: 'publish_post', payload: { post_id: postId }, dedupKey: `pub:${postId}:${upd.integrationId ?? 'none'}`, maxAttempts: 1 })
}

export async function enqueueDuePublications(): Promise<number> {
  const due = await db.select({ id: schema.posts.id, tenantId: schema.posts.tenantId, integrationId: schema.posts.integrationId })
    .from(schema.posts).where(and(
      inArray(schema.posts.status, ['approved', 'scheduled']),
      eq(schema.posts.kind, 'post'),
      or(isNull(schema.posts.scheduledAt), lte(schema.posts.scheduledAt, new Date())),
      sql`${schema.posts.approvedVersionId} IS NOT NULL AND ${schema.posts.approvedVersionId} = ${schema.posts.currentVersionId}`,
    )).limit(20)
  let n = 0
  for (const p of due) {
    const id = await enqueue({
      tenantId: p.tenantId, type: 'publish_post', payload: { post_id: p.id },
      dedupKey: `pub:${p.id}:${p.integrationId ?? 'none'}`, maxAttempts: 1,
    })
    if (id) n++
  }
  return n
}

export function publicationUrl(integration: { username: string | null, externalId: string }, messageId: number): string {
  if (integration.username) return `https://t.me/${integration.username}/${messageId}`
  return `https://t.me/c/${integration.externalId.replace(/^-100/, '')}/${messageId}`
}

export async function publishPost(tenantId: string, postId: string): Promise<{ status: string, url?: string }> {
  const [post] = await db.update(schema.posts).set({ status: 'publishing' }).where(and(
    eq(schema.posts.tenantId, tenantId), eq(schema.posts.id, postId),
    inArray(schema.posts.status, ['approved', 'scheduled']),
    sql`${schema.posts.approvedVersionId} IS NOT NULL AND ${schema.posts.approvedVersionId} = ${schema.posts.currentVersionId}`,
  )).returning()
  if (!post) return { status: 'not_eligible' }
  const version = (await getVersion(tenantId, post.approvedVersionId))!
  const tenant = await getTenant(tenantId)

  const fail = async (status: 'failed' | 'uncertain', error: string, publicationId?: string) => {
    await db.update(schema.posts).set({ status: 'failed' }).where(eq(schema.posts.id, postId))
    if (publicationId) await db.update(schema.publications).set({ status, error }).where(eq(schema.publications.id, publicationId))
    await audit(tenantId, 'system', null, `publication.${status}`, 'post', postId, { error })
    const forMembers = status === 'uncertain'
      ? `Не знаю, вышел ли пост «${version.title}»: связь с площадкой оборвалась. Повторять не буду, чтобы не было дубля, — оператор проверит канал.`
      : `Пост «${version.title}» не удалось опубликовать. Оператор уже знает и разберётся.`
    const forOperator = status === 'uncertain'
      ? `Пост «${version.title}»: связь оборвалась (${error}), исход публикации неизвестен. Автоповтора нет — проверьте канал и отметьте результат в админке.`
      : `Пост «${version.title}» не опубликован: ${error}`
    for (const m of await postAudience(post)) await sayToMember(m, `⚠️ ${esc(forMembers)}`, { postId }).catch(() => null)
    await notifyOperator(tenantId, `[${tenant.name}] ${forOperator}`)
    return { status }
  }

  const finish = async (url: string, externalId: string) => {
    await db.update(schema.publications)
      .set({ status: 'published', externalPostId: externalId, url, publishedAt: new Date(), error: null })
      .where(eq(schema.publications.id, pub!.id))
    await db.update(schema.posts).set({ status: 'published' }).where(eq(schema.posts.id, postId))
    await audit(tenantId, 'system', null, 'publication.published', 'post', postId, { url, version: version.n })
    const extra = integration!.platform === 'telegram' ? await activeIntegration(tenantId, 'vk') : null
    const vkUrl = extra ? await crosspost(tenantId, post, version, extra).catch((e) => { console.warn('[publish] кросспост во ВКонтакте не удался', (e as Error).message); return null }) : null
    for (const m of await postAudience(post).catch(() => [])) {
      await sayToMember(m, `✅ Опубликовано: «${esc(version.title)}»\n${url}${vkUrl ? `\nВКонтакте: ${vkUrl}` : ''}`, { postId }).catch(() => null)
    }
    return { status: 'published', url }
  }

  const integration = post.integrationId
    ? (await db.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.id, post.integrationId))))[0]
    : await activeIntegration(tenantId)
  if (!integration || integration.status !== 'active') return fail('failed', 'Канал не подключён или доступ отозван')

  let [pub] = await db.insert(schema.publications).values({
    tenantId, postId, versionId: version.id, integrationId: integration.id, idempotencyKey: `${postId}:${integration.id}`, attempts: 1,
  }).onConflictDoNothing().returning()
  if (!pub) {
    const [existing] = await db.select().from(schema.publications)
      .where(and(eq(schema.publications.postId, postId), eq(schema.publications.integrationId, integration.id)))
    if (existing?.status === 'published') {
      await db.update(schema.posts).set({ status: 'published' }).where(eq(schema.posts.id, postId))
      return { status: 'already_published', url: existing.url ?? undefined }
    }
    if (existing?.status !== 'failed') {
      await db.update(schema.posts).set({ status: 'failed' }).where(eq(schema.posts.id, postId))
      return { status: 'blocked_uncertain' }
    }
    [pub] = await db.update(schema.publications)
      .set({ status: 'publishing', versionId: version.id, error: null, attempts: sql`${schema.publications.attempts} + 1` })
      .where(and(eq(schema.publications.id, existing.id), eq(schema.publications.status, 'failed'))).returning()
    if (!pub) return { status: 'blocked' }
  }

  if (integration.platform === 'vk') {
    try {
      const r = await sendToVk(tenantId, post, version, integration, pub.id)
      return finish(r.url, r.externalId)
    }
    catch (e) {
      if (e instanceof VkError) return fail('failed', e.message, pub.id)
      return fail('uncertain', 'нет ответа от ВКонтакте', pub.id)
    }
  }
  const token = integration.credentialsEnc ? decryptSecret(integration.credentialsEnc) : null
  const api = tg(token)
  let body: string
  let entities: MessageEntity[]
  if (version.video?.status === 'ready') {
    body = postBody(version)
    entities = await trackLinks(tenantId, post, pub.id, body, version.card?.template).catch(() => [])
  }
  else {
    const md = await trackLinksMarkdown(tenantId, post, pub.id, version.text, version.card?.template).catch(() => version.text)
    const f = mdEntities(md)
    body = [f.text, version.hashtags.join(' ')].filter(Boolean).join('\n\n')
    entities = f.entities as MessageEntity[]
  }
  const image = await readMedia(tenantId, version.imageMediaId)
  const video = version.video?.status === 'ready' ? await readMedia(tenantId, version.video.media_id) : null
  const slides = post.kind === 'post' && !video ? slidesOf(version) : []
  let useRich = version.format === 'rich' && post.kind === 'post' && !video
  const pack = tenant.settings.emoji_in_channel ? await loadPack(tenant.settings.emoji_pack) : null
  let useEmoji = !!pack
  let albumSent = false
  let messageId: number | null = null
  for (let attempt = 1; attempt <= 3 && messageId === null; attempt++) {
    const ents = useEmoji ? [...entities, ...emojiEntities(body, pack!)].sort((a, b) => a.offset - b.offset) : entities
    try {
      if (useRich) {
        try {
          const md = richMarkdown(await trackLinksMarkdown(tenantId, post, pub.id, version.text, version.card?.template), version.hashtags, slides, version.gallery?.mode)
          messageId = await sendRichWithMedia(api, integration.externalId, useEmoji ? emojiMarkdown(md, pack!) : md, slides, tenantId)
        }
        catch (e) {
          if (!richRejected(e)) throw e
          if (useEmoji) {
            console.warn('[publish] значки набора эмодзи не приняты в канале, публикую обычными:', (e as Error).message)
            useEmoji = false
            attempt--
            continue
          }
          console.warn('[publish] rich-пост не принят, публикую обычным', (e as Error).message)
          await audit(tenantId, 'system', null, 'publication.rich_fallback', 'post', postId, { error: (e as Error).message })
          useRich = false
        }
      }
      if (messageId !== null) {}
      else if (slides.length > 1) {
        if (body.length <= CAPTION_LIMIT) messageId = await sendAlbum(api, integration.externalId, slides, tenantId, { text: body, entities: ents })
        else {
          if (!albumSent) await sendAlbum(api, integration.externalId, slides, tenantId)
          albumSent = true
          const text = body.slice(0, 4096)
          messageId = (await api.sendMessage(integration.externalId, text, {
            entities: ents.filter(e => e.offset + e.length <= text.length), link_preview_options: { is_disabled: true },
          })).message_id
        }
      }
      else if (video && body.length <= CAPTION_LIMIT) {
        messageId = (await api.sendVideo(integration.externalId, new InputFile(video, 'video.mp4'), {
          caption: body, caption_entities: ents, supports_streaming: true, width: 720, height: 1280, duration: version.video!.duration_sec,
        })).message_id
      }
      else if (image && body.length <= CAPTION_LIMIT) {
        messageId = (await api.sendPhoto(integration.externalId, new InputFile(image, 'post.png'), { caption: body, caption_entities: ents })).message_id
      }
      else {
        if (!albumSent) {
          if (video) await api.sendVideo(integration.externalId, new InputFile(video, 'video.mp4'), { supports_streaming: true, width: 720, height: 1280, duration: version.video!.duration_sec })
          else if (image) await api.sendPhoto(integration.externalId, new InputFile(image, 'post.png'))
        }
        albumSent = true
        const text = body.slice(0, 4096)
        messageId = (await api.sendMessage(integration.externalId, text, {
          entities: ents.filter(e => e.offset + e.length <= text.length), link_preview_options: { is_disabled: true },
        })).message_id
      }
    }
    catch (e) {
      if (e instanceof GrammyError) {
        if (useEmoji && e.error_code === 400) {
          console.warn('[publish] значки набора эмодзи не приняты в канале, публикую обычными:', e.description)
          useEmoji = false
          attempt--
          continue
        }
        const temporary = e.error_code === 429 || e.error_code >= 500
        if (temporary && attempt < 3) {
          await new Promise(r => setTimeout(r, Math.min((e.parameters?.retry_after ?? 3) * 1000, 30_000)))
          continue
        }
        return fail('failed', `Telegram: ${e.description}`, pub.id)
      }
      const msg = e instanceof HttpError ? 'нет ответа от Telegram' : (e as Error).message
      return fail('uncertain', msg, pub.id)
    }
  }
  if (messageId === null) return fail('failed', 'Telegram не принял сообщение', pub.id)

  return finish(publicationUrl(integration, messageId), String(messageId))
}

async function crosspost(tenantId: string, post: Post, version: Version, integration: typeof schema.integrations.$inferSelect): Promise<string | null> {
  const [pub] = await db.insert(schema.publications).values({
    tenantId, postId: post.id, versionId: version.id, integrationId: integration.id, idempotencyKey: `${post.id}:${integration.id}`, attempts: 1,
  }).onConflictDoNothing().returning()
  if (!pub) return null
  try {
    const r = await sendToVk(tenantId, post, version, integration, pub.id)
    await db.update(schema.publications).set({ status: 'published', externalPostId: r.externalId, url: r.url, publishedAt: new Date(), error: null }).where(eq(schema.publications.id, pub.id))
    await audit(tenantId, 'system', null, 'publication.published', 'post', post.id, { url: r.url, version: version.n, platform: 'vk' })
    return r.url
  }
  catch (e) {
    const definite = e instanceof VkError
    const error = definite ? e.message : 'нет ответа от ВКонтакте'
    await db.update(schema.publications).set({ status: definite ? 'failed' : 'uncertain', error }).where(eq(schema.publications.id, pub.id))
    await audit(tenantId, 'system', null, `publication.${definite ? 'failed' : 'uncertain'}`, 'post', post.id, { error, platform: 'vk' })
    await notifyOperator(tenantId, `Пост «${version.title}» вышел в Telegram, но не попал во ВКонтакте: ${error}`)
    return null
  }
}

export async function recentPosts(tenantId: string, limit = 5) {
  const rows = await db.select({
    id: schema.posts.id, status: schema.posts.status, scheduledAt: schema.posts.scheduledAt, kind: schema.posts.kind,
    topic: schema.posts.topic, title: schema.postVersions.title, n: schema.postVersions.n, createdAt: schema.posts.createdAt,
  }).from(schema.posts)
    .leftJoin(schema.postVersions, eq(schema.postVersions.id, schema.posts.currentVersionId))
    .where(eq(schema.posts.tenantId, tenantId)).orderBy(desc(schema.posts.createdAt)).limit(limit)
  return rows
}
