import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

const dataDir = resolve(process.cwd(), 'data/pg')
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'app',
  password: 'app',
  port: 5433,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
})

const fresh = !existsSync(resolve(dataDir, 'PG_VERSION'))
if (fresh) await pg.initialise()
await pg.start()
if (fresh) await pg.createDatabase('marketer')
console.log('PostgreSQL запущен на порту 5433 (БД marketer). Ctrl+C — остановить.')

const stop = async () => { await pg.stop(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
