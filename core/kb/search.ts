import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'

export interface KbChunk { id: string, sourceId: string, title: string, text: string }

const STOP = new Set([
  'что', 'как', 'это', 'для', 'или', 'при', 'про', 'над', 'под', 'его', 'еще', 'ещё', 'уже', 'они', 'она', 'оно', 'мы', 'вы',
  'наш', 'наша', 'наши', 'нас', 'вас', 'чтобы', 'если', 'когда', 'пост', 'поста', 'посты', 'подготовь', 'сделай', 'напиши',
  'публикацию', 'публикация', 'расскажи', 'нужно', 'надо', 'можно', 'очень', 'также', 'который', 'которая', 'которые',
  'компании', 'компания', 'канал', 'канала', 'будет', 'было', 'были', 'есть', 'нет', 'да', 'the', 'and', 'for',
])

export function buildTsQuery(text: string): string | null {
  const words = [...new Set(
    text.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{3,}/gi) ?? [],
  )].filter(w => !STOP.has(w)).slice(0, 24)
  return words.length ? words.join(' | ') : null
}

export async function searchChunks(
  tenantId: string, query: string, opts: { limit?: number, scope?: 'company' | 'competitor' } = {},
): Promise<KbChunk[]> {
  const tsq = buildTsQuery(query)
  if (!tsq) return []
  const limit = opts.limit ?? 8
  const scope = opts.scope ?? 'company'
  const rows = await db.execute<{ id: string, source_id: string, title: string, text: string }>(sql`
    SELECT c.id, c.source_id, s.title, c.text
    FROM kb_chunks c JOIN sources s ON s.id = c.source_id
    WHERE c.tenant_id = ${tenantId} AND s.tenant_id = ${tenantId} AND s.scope = ${scope}
      AND c.tsv @@ to_tsquery('russian', ${tsq})
    ORDER BY ts_rank_cd(c.tsv, to_tsquery('russian', ${tsq})) DESC
    LIMIT ${limit}
  `)
  return rows.map(r => ({ id: r.id, sourceId: r.source_id, title: r.title, text: r.text }))
}

export async function firstChunks(tenantId: string, limit: number, scope: 'company' | 'competitor' = 'company'): Promise<KbChunk[]> {
  const rows = await db.execute<{ id: string, source_id: string, title: string, text: string }>(sql`
    SELECT id, source_id, title, text FROM (
      SELECT c.id, c.source_id, s.title, c.text, c.ord, s.created_at,
             row_number() OVER (PARTITION BY c.source_id ORDER BY c.ord) AS rn,
             count(*) OVER (PARTITION BY c.source_id) AS total
      FROM kb_chunks c JOIN sources s ON s.id = c.source_id
      WHERE c.tenant_id = ${tenantId} AND s.tenant_id = ${tenantId} AND s.scope = ${scope} AND s.status = 'ready'
    ) x
    ORDER BY rn, created_at
    LIMIT ${limit}
  `)
  return rows.map(r => ({ id: r.id, sourceId: r.source_id, title: r.title, text: r.text }))
}

export async function chunksByIds(tenantId: string, ids: string[]): Promise<KbChunk[]> {
  if (!ids.length) return []
  const rows = await db.select({
    id: schema.kbChunks.id, sourceId: schema.kbChunks.sourceId, text: schema.kbChunks.text, title: schema.sources.title,
  }).from(schema.kbChunks)
    .innerJoin(schema.sources, eq(schema.sources.id, schema.kbChunks.sourceId))
    .where(and(eq(schema.kbChunks.tenantId, tenantId), inArray(schema.kbChunks.id, ids)))
    .orderBy(asc(schema.kbChunks.ord))
  return rows
}
