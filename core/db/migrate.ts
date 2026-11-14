import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, pg } from './client'

export async function runMigrations() {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'core/db/migrations') })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(async () => { console.log('migrations applied'); await pg.end() })
    .catch(async (e) => { console.error(e); await pg.end(); process.exit(1) })
}
