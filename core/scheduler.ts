import { Cron } from 'croner'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { db, schema } from './db/client'
import { enqueue } from './jobs/queue'
import { enqueueDuePublications } from './services/posts'
import { zonedToUtc } from './time'

const MAX_LATENESS_MS = 6 * 3600 * 1000

export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  try { return new Cron(cron, { timezone }).nextRun(from) }
  catch { return null }
}

export function isValidCron(cron: string): boolean {
  try { new Cron(cron); return cron.trim().split(/\s+/).length === 5 }
  catch { return false }
}

export async function schedulerTick(now = new Date()): Promise<{ started: number, skipped: number }> {
  let started = 0
  let skipped = 0
  await db.transaction(async (tx) => {
    const due = await tx.execute<{ id: string }>(sql`
      SELECT id FROM scheduled_jobs WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= ${now.toISOString()}::timestamptz
      FOR UPDATE SKIP LOCKED LIMIT 50
    `)
    for (const { id } of due) {
      const [job] = await tx.select().from(schema.scheduledJobs).where(eq(schema.scheduledJobs.id, id))
      if (!job?.nextRunAt) continue
      const planned = job.nextRunAt
      const dedupKey = `sched:${job.id}:${planned.toISOString()}`
      const late = now.getTime() - planned.getTime() > MAX_LATENESS_MS
      const rows = await tx.insert(schema.jobRuns).values({
        tenantId: job.tenantId, scheduledJobId: job.id, type: job.type, dedupKey,
        payload: { ...job.params, seen: undefined, scheduled_job_id: job.id, planned_at: planned.toISOString() },
        ...(late ? { status: 'skipped' as const, error: 'Пропущен: сервис был недоступен дольше 6 часов', finishedAt: now } : {}),
      }).onConflictDoNothing({ target: schema.jobRuns.dedupKey }).returning({ id: schema.jobRuns.id })
      if (rows.length) late ? skipped++ : started++
      await tx.update(schema.scheduledJobs)
        .set({ nextRunAt: nextRun(job.cron, job.timezone, now), lastRunAt: late ? job.lastRunAt : now })
        .where(eq(schema.scheduledJobs.id, job.id))
    }
  })
  return { started, skipped }
}

export async function enqueueDuePlanItems(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + 2 * 86400_000).toISOString().slice(0, 10)
  const items = await db.select({ id: schema.planItems.id, tenantId: schema.planItems.tenantId, date: schema.planItems.date, time: schema.planItems.time, tz: schema.tenants.timezone })
    .from(schema.planItems).innerJoin(schema.tenants, eq(schema.tenants.id, schema.planItems.tenantId))
    .where(and(eq(schema.planItems.status, 'accepted'), lte(schema.planItems.date, horizon))).limit(50)
  let n = 0
  for (const item of items) {
    const at = zonedToUtc(`${item.date}T${item.time}`, item.tz)
    if (!at) continue
    if (at.getTime() < now.getTime() - 3600_000) {
      await db.update(schema.planItems).set({ status: 'skipped' }).where(eq(schema.planItems.id, item.id))
      continue
    }
    if (at.getTime() - now.getTime() <= 86400_000) {
      if (await enqueue({ tenantId: item.tenantId, type: 'draft_plan_item', payload: { plan_item_id: item.id }, dedupKey: `plan:${item.id}` })) n++
    }
  }
  return n
}

export async function systemTick() {
  const sched = await schedulerTick()
  const publications = await enqueueDuePublications()
  const plan = await enqueueDuePlanItems()
  return { ...sched, publications, plan }
}

export { inArray }
