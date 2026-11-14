import { LimitError } from '../core/ai/ops'
import { ProviderError } from '../core/ai/provider'
import { config } from '../core/config'
import { refreshPostStats } from '../core/analytics'
import { db, pg, schema } from '../core/db/client'
import { runMigrations } from '../core/db/migrate'
import { handlers, PermanentError, reportJobFailure } from '../core/jobs/handlers'
import { claimJob, completeJob, failJob, heartbeat, requeueStuck } from '../core/jobs/queue'
import { systemTick } from '../core/scheduler'
import { createBot } from '../core/telegram/bot'

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2)
let stopping = false

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args)

async function runOne(): Promise<boolean> {
  const job = await claimJob()
  if (!job) return false
  const handler = handlers[job.type]
  const started = Date.now()
  try {
    if (!handler) throw new PermanentError(`Неизвестный тип задачи: ${job.type}`)
    const result = await handler(job)
    await completeJob(job.id, result)
    log(`[job] ${job.type} ${job.id} ok ${Date.now() - started}ms`, JSON.stringify(result).slice(0, 200))
  }
  catch (e) {
    const err = e as Error
    const retryable = !(e instanceof PermanentError) && !(e instanceof LimitError)
      && (e instanceof ProviderError ? e.retryable : true)
    const outcome = await failJob(job, err.message.slice(0, 1000), retryable)
    log(`[job] ${job.type} ${job.id} ${outcome}: ${err.message}`)
    if (outcome === 'failed') await reportJobFailure(job, e).catch(x => log('[job] не удалось сообщить об ошибке', x))
  }
  return true
}

async function executorLoop(n: number) {
  while (!stopping) {
    try {
      if (!await runOne()) await sleep(1000)
    }
    catch (e) {
      log(`[executor ${n}] ошибка цикла`, e)
      await sleep(3000)
    }
  }
}

async function schedulerLoop() {
  while (!stopping) {
    try {
      const r = await systemTick()
      if (r.started || r.skipped || r.publications || r.plan) log('[scheduler]', JSON.stringify(r))
    }
    catch (e) { log('[scheduler] ошибка такта', e) }
    await sleep(15_000)
  }
}

let statsAt = 0
async function refreshAllStats() {
  if (Date.now() - statsAt < 30 * 60_000) return
  statsAt = Date.now()
  const tenants = await db.select({ id: schema.tenants.id }).from(schema.tenants)
  let updated = 0
  for (const t of tenants) updated += (await refreshPostStats(t.id).catch(() => ({ updated: 0 }))).updated
  if (updated) log(`[stats] обновлены показатели постов: ${updated}`)
}

async function maintenanceLoop() {
  while (!stopping) {
    try {
      await heartbeat()
      const n = await requeueStuck()
      if (n) log(`[queue] возвращено зависших задач: ${n}`)
      await refreshAllStats()
    }
    catch (e) { log('[maintenance] ошибка', e) }
    await sleep(30_000)
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  await runMigrations()
  log(`[worker] старт: провайдер по умолчанию ${config.llmProvider}, исполнителей ${CONCURRENCY}`)
  void maintenanceLoop()
  void schedulerLoop()
  for (let i = 0; i < CONCURRENCY; i++) void executorLoop(i)

  if (config.telegramBotToken) {
    const bot = createBot()
    await bot.api.setMyCommands([
      { command: 'status', description: 'Последние материалы' },
      { command: 'company', description: 'Сменить компанию' },
      { command: 'help', description: 'Что я умею' },
      { command: 'cancel', description: 'Отменить ввод' },
    ]).catch(() => {})
    if (config.publicBaseUrl.startsWith('https://')) {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Кабинет', web_app: { url: `${config.publicBaseUrl}/app` } } }).catch(() => {})
    }
    void bot.start({
      allowed_updates: ['message', 'callback_query'],
      onStart: me => log(`[bot] @${me.username} запущен (long polling)`),
    })
    const stop = async () => { stopping = true; await bot.stop(); await pg.end({ timeout: 5 }); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  }
  else {
    log('[bot] TELEGRAM_BOT_TOKEN не задан — бот не запущен')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
