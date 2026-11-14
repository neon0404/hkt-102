import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config'
import * as schema from './schema'

const g = globalThis as unknown as { __pg?: ReturnType<typeof postgres> }
export const pg = g.__pg ?? (g.__pg = postgres(config.databaseUrl, { max: 10, onnotice: () => {} }))
export const db = drizzle(pg, { schema })
export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export { schema }
