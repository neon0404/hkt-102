import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { audit } from '../audit'
import { sha256 } from '../crypto'
import { db, schema } from '../db/client'

const PREFIX = 'smm_'

export async function createApiToken(tenantId: string, name: string, actor: string) {
  const clean = name.trim().slice(0, 60)
  if (clean.length < 2) throw new Error('Назовите подключение, например «Claude Desktop маркетолога»')
  const token = `${PREFIX}${randomBytes(24).toString('base64url')}`
  const [row] = await db.insert(schema.apiTokens).values({
    tenantId, name: clean, prefix: token.slice(0, 10), tokenHash: sha256(token), createdBy: actor,
  }).returning()
  await audit(tenantId, 'operator', actor, 'api_token.created', 'api_token', row!.id, { name: clean })
  return { id: row!.id, name: clean, token }
}

export async function listApiTokens(tenantId: string) {
  return db.select({
    id: schema.apiTokens.id, name: schema.apiTokens.name, prefix: schema.apiTokens.prefix,
    last_used_at: schema.apiTokens.lastUsedAt, revoked_at: schema.apiTokens.revokedAt, created_at: schema.apiTokens.createdAt,
  }).from(schema.apiTokens).where(eq(schema.apiTokens.tenantId, tenantId)).orderBy(desc(schema.apiTokens.createdAt))
}

export async function revokeApiToken(tenantId: string, id: string, actor: string) {
  const [row] = await db.update(schema.apiTokens).set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.tenantId, tenantId), eq(schema.apiTokens.id, id), isNull(schema.apiTokens.revokedAt))).returning()
  if (row) await audit(tenantId, 'operator', actor, 'api_token.revoked', 'api_token', id, { name: row.name })
  return !!row
}

export interface AgentIdentity { tenantId: string, tokenId: string, name: string }

const touched = new Map<string, number>()

export async function resolveApiToken(header: string | undefined | null): Promise<AgentIdentity | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token?.startsWith(PREFIX) || token.length > 100) return null
  const [row] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, sha256(token)))
  if (!row || row.revokedAt) return null
  const [tenant] = await db.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, row.tenantId))
  if (!tenant || tenant.status === 'disabled') return null
  if (Date.now() - (touched.get(row.id) ?? 0) > 60_000) {
    touched.set(row.id, Date.now())
    await db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, row.id))
  }
  return { tenantId: row.tenantId, tokenId: row.id, name: row.name }
}
