import { sql } from 'drizzle-orm'
import { db, pg } from '../core/db/client'

const rows = await db.execute(sql`
  SELECT operation, provider, model, count(*)::int AS calls, round(avg(input_tokens))::int AS avg_in, round(avg(output_tokens))::int AS avg_out,
         round(avg(duration_ms) / 1000.0, 1)::float AS avg_sec
  FROM llm_usage WHERE provider <> 'mock' GROUP BY 1, 2, 3 ORDER BY 1`)
console.table(rows)
await pg.end()
