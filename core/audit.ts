import { db, schema } from './db/client'

type Actor = typeof schema.auditLogs.$inferInsert['actorType']

export async function audit(
  tenantId: string | null, actorType: Actor, actorId: string | null, action: string,
  entity?: string | null, entityId?: string | null, data: Record<string, unknown> = {},
) {
  try {
    await db.insert(schema.auditLogs).values({ tenantId, actorType, actorId, action, entity: entity ?? null, entityId: entityId ?? null, data })
  }
  catch (e) {
    console.error('[audit] не удалось записать действие', action, (e as Error).message)
  }
}
