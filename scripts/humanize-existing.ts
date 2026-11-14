import { eq } from 'drizzle-orm'
import { humanize, humanWarnings } from '../core/ai/humanize'
import { db, pg, schema } from '../core/db/client'

const dry = process.argv.includes('--dry')
let changed = 0
const note = (what: string, before: string, after: string) => {
  changed++
  if (dry) console.log(`[${what}]\n  было:  ${before.slice(0, 140)}\n  стало: ${after.slice(0, 140)}`)
}

const versions = await db.select({ id: schema.postVersions.id, warnings: schema.postVersions.warnings, text: schema.postVersions.text, kind: schema.posts.kind })
  .from(schema.postVersions).innerJoin(schema.posts, eq(schema.posts.id, schema.postVersions.postId))
for (const v of versions) {
  const warnings = humanWarnings(v.warnings)
  const text = v.kind === 'video_script' ? v.text.split('\n').map(l => (l.trim() ? humanize(l) : l)).join('\n') : v.text
  if (JSON.stringify(warnings) !== JSON.stringify(v.warnings) || text !== v.text) {
    note('версия', JSON.stringify(v.warnings) + (text !== v.text ? ' +сценарий' : ''), JSON.stringify(warnings))
    if (!dry) await db.update(schema.postVersions).set({ warnings, text }).where(eq(schema.postVersions.id, v.id))
  }
}

for (const p of await db.select({ id: schema.posts.id, topic: schema.posts.topic }).from(schema.posts)) {
  if (!p.topic) continue
  const topic = humanize(p.topic)
  if (topic !== p.topic) { note('тема', p.topic, topic); if (!dry) await db.update(schema.posts).set({ topic }).where(eq(schema.posts.id, p.id)) }
}

for (const i of await db.select().from(schema.planItems)) {
  const topic = humanize(i.topic), reason = i.reason ? humanize(i.reason) : i.reason
  if (topic !== i.topic || reason !== i.reason) { note('план', i.topic, topic); if (!dry) await db.update(schema.planItems).set({ topic, reason }).where(eq(schema.planItems.id, i.id)) }
}

for (const m of await db.select({ id: schema.messages.id, text: schema.messages.text }).from(schema.messages).where(eq(schema.messages.direction, 'out'))) {
  const card = m.text.match(/^\[карточка согласования, версия (\d+)\] ([^:]+):/)
  const text = card ? `📋 Прислал на согласование «${card[2]!.trim()}»${card[1] !== '1' ? ` (версия ${card[1]})` : ''}` : humanize(m.text)
  if (text !== m.text) { note('чат', m.text, text); if (!dry) await db.update(schema.messages).set({ text }).where(eq(schema.messages.id, m.id)) }
}

console.log(`${dry ? 'нашлось бы' : 'исправлено'}: ${changed}`)
await pg.end()
