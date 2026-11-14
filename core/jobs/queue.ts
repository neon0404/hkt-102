import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'

export interface EnqueueInput {
  tenantId: string | null
  type: string
  payload?: Record<string, unknown>
  dedupKey?: string | null
  runAfter?: Date
  maxAttempts?: number
  scheduledJobId?: string | null
}

export async function enqueue(input: EnqueueInput): Promise<string | null> {
  const rows = await db.insert(schema.jobRuns).values({
    tenantId: input.tenantId, type: input.type, payload: input.payload ?? {},
    dedupKey: input.dedupKey ?? null, runAfter: input.runAfter ?? new Date(),
    maxAttempts: input.maxAttempts ?? 3, scheduledJobId: input.scheduledJobId ?? null,
  }).onConflictDoNothing({ target: schema.jobRuns.dedupKey }).returning({ id: schema.jobRuns.id })
  return rows[0]?.id ?? null
}

export type JobRow = typeof schema.jobRuns.$inferSelect

export async function claimJob(): Promise<JobRow | null> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE job_runs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM job_runs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `)
  const id = rows[0]?.id
  if (!id) return null
  const [job] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, id))
  return job ?? null
}

export async function completeJob(id: string, result: Record<string, unknown> = {}) {
  await db.update(schema.jobRuns)
    .set({ status: 'succeeded', result, error: null, finishedAt: new Date(), lockedAt: null })
    .where(eq(schema.jobRuns.id, id))
}

const RETRY_DELAYS_SEC = [30, 120, 600]

export async function failJob(job: JobRow, error: string, retryable: boolean): Promise<'retry' | 'failed'> {
  if (retryable && job.attempts < job.maxAttempts) {
    const delay = RETRY_DELAYS_SEC[Math.min(job.attempts - 1, RETRY_DELAYS_SEC.length - 1)]!
    await db.update(schema.jobRuns)
      .set({ status: 'queued', error, lockedAt: null, runAfter: new Date(Date.now() + delay * 1000) })
      .where(eq(schema.jobRuns.id, job.id))
    return 'retry'
  }
  await db.update(schema.jobRuns)
    .set({ status: 'failed', error, finishedAt: new Date(), lockedAt: null })
    .where(eq(schema.jobRuns.id, job.id))
  return 'failed'
}

export async function requeueStuck(): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE job_runs SET status = 'queued', locked_at = NULL, error = 'Возвращена в очередь после перезапуска'
    WHERE status = 'running' AND locked_at < now() - interval '5 minutes' AND type <> 'publish_post'
    RETURNING id
  `)
  await db.execute(sql`
    UPDATE job_runs SET status = 'failed', locked_at = NULL, finished_at = now(),
      error = 'Исход публикации неизвестен после перезапуска — требуется решение оператора'
    WHERE status = 'running' AND locked_at < now() - interval '5 minutes' AND type = 'publish_post'
  `)
  return rows.length
}

export async function heartbeat(key = 'worker') {
  await db.insert(schema.systemState).values({ key, value: { at: new Date().toISOString(), pid: process.pid } })
    .onConflictDoUpdate({ target: schema.systemState.key, set: { value: { at: new Date().toISOString(), pid: process.pid }, updatedAt: new Date() } })
}
