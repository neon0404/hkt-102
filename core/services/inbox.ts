import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { enqueue } from '../jobs/queue'
import { esc } from '../telegram/api'
import { sayToMember, submitChangeRequest } from './posts'

type Member = typeof schema.tenantMembers.$inferSelect

export async function acceptMemberText(
  member: Member, text: string, opts: { tgMessageId?: number | null, dedupKey: string },
): Promise<{ kind: 'comment' | 'task', messageId?: string }> {
  const [state] = await db.select().from(schema.dialogStates).where(eq(schema.dialogStates.memberId, member.id))
  const decision = /^\s*(одобряю|одобрено|публикуй|публикуем|выкладывай|отклоняю|отклонить|не публикуем)(?!\p{L})/iu.test(text)
  if (state?.state === 'awaiting_comment' && decision) await db.delete(schema.dialogStates).where(eq(schema.dialogStates.id, state.id))
  else if (state?.state === 'awaiting_comment') {
    await db.delete(schema.dialogStates).where(eq(schema.dialogStates.id, state.id))
    await db.insert(schema.messages).values({ tenantId: member.tenantId, memberId: member.id, direction: 'in', text, tgMessageId: opts.tgMessageId ?? null, intent: 'approval_comment' })
    const res = await submitChangeRequest(member, String(state.payload.approval_id), text)
    await sayToMember(member, res.ok ? 'Принял комментарий, дорабатываю. Пришлю новую версию на согласование.' : esc(res.reason ?? 'Эта карточка уже неактуальна'), { postId: res.postId })
    return { kind: 'comment' }
  }
  const [msg] = await db.insert(schema.messages)
    .values({ tenantId: member.tenantId, memberId: member.id, direction: 'in', text, tgMessageId: opts.tgMessageId ?? null }).returning()
  await enqueue({ tenantId: member.tenantId, type: 'handle_message', dedupKey: opts.dedupKey, payload: { message_id: msg!.id, member_id: member.id } })
  return { kind: 'task', messageId: msg!.id }
}
