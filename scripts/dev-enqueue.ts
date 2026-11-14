import { eq } from 'drizzle-orm'
import { db, pg, schema } from '../core/db/client'
import { enqueue } from '../core/jobs/queue'

const [slug, type, payload] = process.argv.slice(2)
const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug!))
if (!tenant) throw new Error('нет компании')
const id = await enqueue({ tenantId: tenant.id, type: type!, payload: payload ? JSON.parse(payload) : {} })
console.log('job', id)
await pg.end()
