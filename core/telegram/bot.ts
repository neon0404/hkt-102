import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { Bot, type Context, InlineKeyboard } from 'grammy'
import { audit } from '../audit'
import { config } from '../config'
import { db, schema } from '../db/client'
import { sendCommentReply, statusText } from '../jobs/handlers'
import { enqueue } from '../jobs/queue'
import { acceptMemberText } from '../services/inbox'
import { decideApproval, getTenant, sayToMember, submitChangeRequest } from '../services/posts'
import { esc, tgClient } from './api'
import { mdEsc, sendRich } from './rich'

type Member = typeof schema.tenantMembers.$inferSelect

export async function resolveMember(tgUserId: number): Promise<{ member: Member, all: Member[] } | null> {
  const all = await db.select().from(schema.tenantMembers)
    .where(and(eq(schema.tenantMembers.tgUserId, tgUserId), eq(schema.tenantMembers.status, 'active')))
    .orderBy(desc(schema.tenantMembers.createdAt))
  if (!all.length) return null
  if (all.length === 1) return { member: all[0]!, all }
  const [session] = await db.select().from(schema.tgSessions).where(eq(schema.tgSessions.tgUserId, tgUserId))
  return { member: all.find(m => m.tenantId === session?.activeTenantId) ?? all[0]!, all }
}

async function setActiveTenant(tgUserId: number, tenantId: string) {
  await db.insert(schema.tgSessions).values({ tgUserId, activeTenantId: tenantId })
    .onConflictDoUpdate({ target: schema.tgSessions.tgUserId, set: { activeTenantId: tenantId, updatedAt: new Date() } })
}

const HELP = `## 👋 Я AI-маркетолог
Пишите или говорите **голосом** обычным языком.

### Что умею
| Скажите | Что будет |
|:---|:---|
| «Подготовь пост о новом продукте на завтра в 10:00» | пост с карточкой на согласование |
| «Сделай короткий ролик о том, как делают стекло» | вертикальное видео с озвучкой |
| «Составь контент-план на неделю» | темы по дням, приму одной кнопкой |
| «Что с последним постом?» | статусы материалов |
| «Покажи отчёт» | цифры, выводы и что делать дальше |

### Решения — кнопкой или словами
- ✅ «Одобряю», «Публикуй завтра в 9»
- ✏️ «Сделай короче и добавь призыв»
- ✖️ «Отклоняю»

> Публикация выходит **только после вашего согласования**.

/status — последние материалы · /company — сменить компанию · /cancel — отменить ввод`

async function redeemInvite(ctx: Context, code: string) {
  const from = ctx.from!
  const invalid = 'Ссылка недействительна, запросите новую у оператора.'
  if (!/^[\w-]{16,64}$/.test(code)) return ctx.reply(invalid)
  const [invite] = await db.select().from(schema.invites)
    .where(and(eq(schema.invites.code, code), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())))
  if (!invite) {
    await audit(null, 'member', String(from.id), 'invite.rejected', 'invite', null, {})
    return ctx.reply(invalid)
  }
  const tenant = await getTenant(invite.tenantId)
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id)
  const member = await db.transaction(async (tx) => {
    const [used] = await tx.update(schema.invites).set({ usedAt: new Date() })
      .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.usedAt))).returning()
    if (!used) return null
    const [existing] = await tx.select().from(schema.tenantMembers)
      .where(and(eq(schema.tenantMembers.tenantId, invite.tenantId), eq(schema.tenantMembers.tgUserId, from.id)))
    let m: Member
    if (existing) {
      const roles = [...new Set([...(existing.status === 'active' ? existing.roles : []), ...invite.roles])]
      ;[m] = await tx.update(schema.tenantMembers).set({ roles, status: 'active', tgChatId: ctx.chat!.id, displayName: name })
        .where(eq(schema.tenantMembers.id, existing.id)).returning() as [Member]
    }
    else {
      [m] = await tx.insert(schema.tenantMembers)
        .values({ tenantId: invite.tenantId, tgUserId: from.id, tgChatId: ctx.chat!.id, displayName: name, roles: invite.roles }).returning() as [Member]
    }
    await tx.update(schema.invites).set({ usedByMemberId: m.id }).where(eq(schema.invites.id, invite.id))
    return m
  })
  if (!member) return ctx.reply(invalid)
  await setActiveTenant(from.id, invite.tenantId)
  await audit(invite.tenantId, 'member', member.id, 'member.joined', 'member', member.id, { roles: member.roles })
  const roles = member.roles.map(r => r === 'approver' ? 'согласующий' : 'клиент').join(', ')
  return sendRich(ctx.chat!.id, `Здравствуйте, **${mdEsc(name)}**! Вы подключены к компании «${mdEsc(tenant.name)}» (${roles}).\n\n${HELP}`)
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramBotToken, { client: tgClient() })

  bot.use(async (ctx, next) => {
    const rows = await db.insert(schema.processedUpdates).values({ updateId: ctx.update.update_id }).onConflictDoNothing().returning()
    if (!rows.length) return
    await next()
  })

  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type === 'private') return next()
    const msg = ctx.message
    const text = msg.text ?? msg.caption
    if (!text || msg.is_automatic_forward || msg.from?.is_bot) return
    const origin = msg.reply_to_message
    const channelId = origin?.sender_chat?.type === 'channel' ? String(origin.sender_chat.id) : null
    if (!channelId) return
    const [integration] = await db.select().from(schema.integrations)
      .where(and(eq(schema.integrations.platform, 'telegram'), eq(schema.integrations.externalId, channelId), eq(schema.integrations.status, 'active')))
    if (!integration) return
    const forwardedId = (origin as any)?.forward_origin?.message_id ?? (origin as any)?.forward_from_message_id
    const [pub] = forwardedId
      ? await db.select().from(schema.publications).where(and(
          eq(schema.publications.tenantId, integration.tenantId), eq(schema.publications.integrationId, integration.id),
          eq(schema.publications.externalPostId, String(forwardedId)),
        ))
      : []
    const [comment] = await db.insert(schema.comments).values({
      tenantId: integration.tenantId, integrationId: integration.id, publicationId: pub?.id ?? null,
      externalChatId: String(ctx.chat.id), externalMessageId: String(msg.message_id),
      authorName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' '), text: text.slice(0, 2000),
    }).onConflictDoNothing().returning()
    if (comment) await enqueue({ tenantId: integration.tenantId, type: 'comment_reply', payload: { comment_id: comment.id }, dedupKey: `cmt:${comment.id}` })
  })

  bot.command('start', async (ctx) => {
    const code = ctx.match?.trim()
    if (code) return redeemInvite(ctx, code)
    const r = await resolveMember(ctx.from!.id)
    if (!r) return ctx.reply('Здравствуйте! Чтобы начать, откройте ссылку-приглашение от оператора сервиса.')
    const tenant = await getTenant(r.member.tenantId)
    return sendRich(ctx.chat.id, `Вы работаете с компанией «**${mdEsc(tenant.name)}**».\n\n${HELP}`)
  })

  bot.command('help', ctx => sendRich(ctx.chat.id, HELP))

  bot.command('cancel', async (ctx) => {
    const r = await resolveMember(ctx.from!.id)
    if (r) await db.delete(schema.dialogStates).where(eq(schema.dialogStates.memberId, r.member.id))
    return ctx.reply('Ввод отменён.')
  })

  bot.command('status', async (ctx) => {
    const r = await resolveMember(ctx.from!.id)
    if (!r) return ctx.reply('Доступа нет. Запросите ссылку-приглашение у оператора.')
    const tenant = await getTenant(r.member.tenantId)
    return sendRich(ctx.chat.id, await statusText(r.member.tenantId, tenant.timezone))
  })

  bot.command('company', async (ctx) => {
    const r = await resolveMember(ctx.from!.id)
    if (!r) return ctx.reply('Доступа нет. Запросите ссылку-приглашение у оператора.')
    if (r.all.length < 2) {
      const tenant = await getTenant(r.member.tenantId)
      return ctx.reply(`Вы подключены к одной компании: «${tenant.name}».`)
    }
    const kb = new InlineKeyboard()
    for (const m of r.all) {
      const t = await getTenant(m.tenantId)
      kb.text(`${m.tenantId === r.member.tenantId ? '● ' : ''}${t.name}`, `co:${m.tenantId}`).row()
    }
    return ctx.reply('С какой компанией работаем?', { reply_markup: kb })
  })

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data
    const tgUserId = ctx.from.id
    const answer = (text?: string, alert = false) => ctx.answerCallbackQuery(text ? { text: text.slice(0, 190), show_alert: alert } : undefined).catch(() => {})
    if (data === 'noop') return answer()

    if (data.startsWith('ap:')) {
      const [, approvalId, action] = data.split(':')
      if (!approvalId || !['a', 'c', 'r'].includes(action ?? '')) return answer('Некорректная кнопка')
      const res = await decideApproval(approvalId, tgUserId, action as 'a' | 'c' | 'r')
      if (!res.ok) return answer(res.reason, true)
      await answer()
      const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId))
      const [who] = await db.select().from(schema.tenantMembers).where(eq(schema.tenantMembers.id, approval!.memberId))
      if (!who) return
      if (res.action === 'awaiting_comment') {
        await sayToMember(who, 'Что изменить? Напишите комментарий одним сообщением (/cancel — отменить).', { postId: res.postId })
      }
      else if (res.action === 'approved') {
        await sayToMember(who, 'Одобрено. Опубликую в назначенное время и пришлю ссылку.', { postId: res.postId })
      }
      else if (res.action === 'approved_partial') {
        await sayToMember(who, 'Ваше одобрение учтено. Жду решения остальных согласующих.', { postId: res.postId })
      }
      else if (res.action === 'rejected') {
        await sayToMember(who, 'Отклонено. Этот материал опубликован не будет.', { postId: res.postId })
      }
      return
    }

    const r = await resolveMember(tgUserId)
    if (!r) return answer('Доступа нет', true)

    if (data.startsWith('co:')) {
      const tenantId = data.slice(3)
      const target = r.all.find(m => m.tenantId === tenantId)
      if (!target) { await audit(null, 'member', String(tgUserId), 'access.denied', 'tenant', tenantId, { reason: 'switch' }); return answer('Нет доступа к этой компании', true) }
      await setActiveTenant(tgUserId, tenantId)
      const tenant = await getTenant(tenantId)
      await answer()
      return ctx.editMessageText(`Работаем с компанией «${tenant.name}».`).catch(() => {})
    }

    if (data.startsWith('pl:')) {
      const [, batchId, action] = data.split(':')
      const items = await db.select().from(schema.planItems).where(eq(schema.planItems.batchId, batchId!))
      const member = r.all.find(m => m.tenantId === items[0]?.tenantId)
      if (!items.length || !member) return answer('План не найден', true)
      if (items.some(i => i.status !== 'idea')) return answer('По этому плану решение уже принято', true)
      const status = action === 'a' ? 'accepted' : 'skipped'
      await db.update(schema.planItems).set({ status }).where(and(eq(schema.planItems.tenantId, member.tenantId), eq(schema.planItems.batchId, batchId!)))
      await audit(member.tenantId, 'member', member.id, `plan.${status}`, 'plan', batchId!, { items: items.length })
      await answer()
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(action === 'a' ? '✅ План принят' : '✖️ План отклонён', 'noop') }).catch(() => {})
      return sayToMember(member, action === 'a'
        ? 'План принят. Каждый пост подготовлю за сутки до даты и пришлю на согласование.'
        : 'План отклонён. Напишите, что изменить, — предложу новый.')
    }

    if (data.startsWith('cm:')) {
      const [, commentId, action] = data.split(':')
      const [comment] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId!))
      const member = r.all.find(m => m.tenantId === comment?.tenantId && m.roles.includes('approver'))
      if (!comment || !member) return answer('Нет доступа', true)
      if (action === 's') {
        const ok = await sendCommentReply(member.tenantId, comment.id, member.id)
        await answer(ok ? 'Ответ отправлен' : 'Не удалось отправить ответ', !ok)
        if (ok) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('📨 Ответ отправлен', 'noop') }).catch(() => {})
      }
      else {
        await db.update(schema.comments).set({ status: 'ignored' }).where(and(eq(schema.comments.id, comment.id), eq(schema.comments.status, 'drafted')))
        await answer('Пропущено')
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('Пропущено', 'noop') }).catch(() => {})
      }
      return
    }
    return answer()
  })

  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private') return
    const r = await resolveMember(ctx.from.id)
    if (!r) {
      await audit(null, 'member', String(ctx.from.id), 'access.denied', 'bot', null, { reason: 'not_a_member' })
      return ctx.reply('Доступа нет. Запросите ссылку-приглашение у оператора сервиса.')
    }
    const { member } = r
    const text = ctx.message.text.trim().slice(0, 4000)
    if (member.tgChatId !== ctx.chat.id) {
      await db.update(schema.tenantMembers).set({ tgChatId: ctx.chat.id }).where(eq(schema.tenantMembers.id, member.id))
      member.tgChatId = ctx.chat.id
    }

    const r2 = await acceptMemberText(member, text, { tgMessageId: ctx.message.message_id, dedupKey: `msg:${ctx.update.update_id}` })
    void r2
  })

  bot.on(['message:voice', 'message:audio', 'message:video_note'], async (ctx) => {
    if (ctx.chat.type !== 'private') return
    const r = await resolveMember(ctx.from.id)
    if (!r) return ctx.reply('Доступа нет. Запросите ссылку-приглашение у оператора сервиса.')
    const file = ctx.message.voice ?? ctx.message.audio ?? ctx.message.video_note
    if (!file) return
    if ((file.duration ?? 0) > 120) return ctx.reply('Голосовое длиннее двух минут — сократите, пожалуйста, или напишите текстом.')
    if (r.member.tgChatId !== ctx.chat.id) await db.update(schema.tenantMembers).set({ tgChatId: ctx.chat.id }).where(eq(schema.tenantMembers.id, r.member.id))
    await enqueue({
      tenantId: r.member.tenantId, type: 'voice_message', dedupKey: `voice:${ctx.update.update_id}`,
      payload: { member_id: r.member.id, file_id: file.file_id, tg_message_id: ctx.message.message_id },
    })
    await ctx.reply('🎙 Слушаю…')
  })

  bot.on('message', async (ctx) => {
    if (ctx.chat.type === 'private') await ctx.reply('Принимаю текст и голосовые. Опишите задачу словами.')
  })

  bot.catch((err) => {
    console.error('[bot] ошибка обработки обновления', err.error)
  })

  return bot
}
