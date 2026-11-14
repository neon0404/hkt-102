import { desc, eq } from 'drizzle-orm'
import { db, pg, schema } from '../core/db/client'

const [slug, action] = process.argv.slice(2)
const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug!))
if (!tenant) throw new Error('нет компании')
const [profile] = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.tenantId, tenant.id)).orderBy(desc(schema.brandProfiles.version)).limit(1)
if (profile && action === 'confirm') {
  await db.update(schema.brandProfiles).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(schema.brandProfiles.id, profile.id))
  console.log('профиль подтверждён')
}
if (profile) {
  const d = profile.data
  console.log(`ПРОФИЛЬ v${profile.version} (${profile.status})\n`, d.description, '\nРубрики:', d.rubrics.join(' | '), '\nТон:', d.tone, '\nЗапреты:', d.forbidden.join(' | '), '\nСтратегия:', d.strategy)
  console.log('Факты:', d.facts.length, 'с источником:', d.facts.filter(f => f.chunk_id).length, '\n -', d.facts.slice(0, 5).map(f => f.claim).join('\n - '))
}
const posts = await db.select().from(schema.posts).where(eq(schema.posts.tenantId, tenant.id)).orderBy(desc(schema.posts.createdAt)).limit(3)
for (const p of posts) {
  const [v] = await db.select().from(schema.postVersions).where(eq(schema.postVersions.id, p.currentVersionId!))
  console.log(`\nПОСТ [${p.status}] ${p.origin} рубрика=${p.rubric} v${v?.n}\nЗаголовок: ${v?.title}\n${v?.text}\n${v?.hashtags.join(' ')}\nФакты: ${JSON.stringify(v?.facts.map(f => [f.claim.slice(0, 60), f.source_title]))}\nПредупреждения: ${JSON.stringify(v?.warnings)}\nmeta: ${JSON.stringify(v?.generationMeta)}\nmedia: ${v?.imageMediaId}`)
}
await pg.end()
