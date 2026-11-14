import { trackLinks } from '../analytics'
import type { schema } from '../db/client'
import { readMedia } from '../media'
import { slidesOf } from '../services/post-media'
import { mdEntities } from '../telegram/rich'
import { uploadWallPhoto, vkPostUrl, wallPost } from './api'
import { integrationCreds } from './oauth'

type Version = typeof schema.postVersions.$inferSelect
type Integration = typeof schema.integrations.$inferSelect

export async function vkText(tenantId: string, post: { id: string, rubric?: string | null }, publicationId: string, version: Version): Promise<string> {
  const main = version.video?.status === 'ready' ? version.video.caption : mdEntities(version.text).text
  const body = [main.trim(), version.hashtags.join(' ')].filter(Boolean).join('\n\n')
  const links = await trackLinks(tenantId, post, publicationId, body, version.card?.template).catch(() => [])
  let out = body
  for (const l of [...links].sort((a, b) => b.offset - a.offset)) {
    if (l.type === 'text_link' && l.url) out = out.slice(0, l.offset) + l.url + out.slice(l.offset + l.length)
  }
  return out
}

const isJpeg = (b: Buffer) => b[0] === 0xFF && b[1] === 0xD8

export async function sendToVk(tenantId: string, post: { id: string, rubric?: string | null, kind: string }, version: Version, integration: Integration, publicationId: string): Promise<{ externalId: string, url: string }> {
  const token = (await integrationCreds(integration)).access_token
  const groupId = Number(integration.externalId)
  const message = await vkText(tenantId, post, publicationId, version)
  const ids = post.kind === 'post' && version.video?.status !== 'ready' ? slidesOf(version) : [version.imageMediaId].filter((x): x is string => !!x)
  const attachments: string[] = []
  for (const id of ids.slice(0, 10)) {
    const buf = await readMedia(tenantId, id)
    if (buf) attachments.push(await uploadWallPhoto(groupId, token, buf, isJpeg(buf) ? 'image/jpeg' : 'image/png'))
  }
  const postId = await wallPost(groupId, token, message, attachments)
  return { externalId: String(postId), url: vkPostUrl(groupId, postId) }
}
