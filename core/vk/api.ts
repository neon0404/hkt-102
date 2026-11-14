const API = 'https://api.vk.com/method'
const VERSION = '5.199'

export class VkError extends Error {
  constructor(public code: number, message: string, public temporary = false) { super(message) }
}

const TEMPORARY = new Set([6, 9, 10, 29])

export async function vkCall<T = any>(method: string, params: Record<string, string | number | undefined>, token: string, timeoutMs = 20_000): Promise<T> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') body.set(k, String(v))
  body.set('access_token', token)
  body.set('v', VERSION)
  const res = await fetch(`${API}/${method}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) })
  const json = await res.json() as { response?: T, error?: { error_code: number, error_msg: string } }
  if (json.error) throw new VkError(json.error.error_code, humanVkError(json.error.error_code, json.error.error_msg), TEMPORARY.has(json.error.error_code))
  return json.response as T
}

export function humanVkError(code: number, msg: string): string {
  if (code === 5) return 'ВКонтакте не принял ключ доступа: он неверный, просрочен или отозван'
  if (code === 15 || code === 7) return 'У ключа нет прав: нужен ключ администратора сообщества с правами wall, photos, groups, offline'
  if (code === 27) return 'Это ключ сообщества — для публикации на стену нужен ключ пользователя-администратора'
  if (code === 214) return 'Публикация на стене сообщества запрещена — откройте стену или дайте права администратора'
  if (code === 100) return `Неверный запрос к ВКонтакте: ${msg}`
  if (TEMPORARY.has(code)) return 'ВКонтакте временно не отвечает, попробуйте позже'
  return `ВКонтакте: ${msg}`
}

export function groupRef(input: string): string | null {
  const v = input.trim().replace(/^(https?:\/\/)?(m\.)?vk\.(com|ru)\//, '').replace(/^@/, '').replace(/[/?#].*$/, '')
  if (!v) return null
  const id = v.match(/^(?:club|public|event)?(\d+)$/)
  if (id) return id[1]!
  return /^[A-Za-z0-9_.]{2,64}$/.test(v) ? v : null
}

export interface VkGroup { id: number, name: string, screen_name: string, is_admin?: 0 | 1 | boolean, admin_level?: number }

export async function canPostToWall(group: VkGroup, token: string): Promise<string | null> {
  if ((group.is_admin === 1 || group.is_admin === true) && (group.admin_level === undefined || group.admin_level >= 2)) return null
  if ((group.is_admin === 1 || group.is_admin === true) && (group.admin_level ?? 0) < 2) return `Владелец ключа — модератор сообщества «${group.name}». Для публикации нужны права редактора или администратора.`
  try {
    const res = await vkCall<{ items: Array<number | { id: number }> }>('groups.get', { filter: 'editor', count: 1000 }, token)
    if (res.items.some(x => (typeof x === 'number' ? x : x.id) === group.id)) return null
    return `Владелец ключа не администратор и не редактор сообщества «${group.name}». Проверьте, что ключ получен под тем аккаунтом, который управляет сообществом.`
  }
  catch (e) {
    if (e instanceof VkError && (e.code === 15 || e.code === 7)) return 'В ключе нет права groups — выпустите ключ заново с правами wall, photos, groups, offline'
    throw e
  }
}

export async function getGroup(ref: string, token: string): Promise<VkGroup> {
  const res = await vkCall<any>('groups.getById', { group_id: ref, fields: 'is_admin,admin_level,screen_name' }, token)
  const group = (Array.isArray(res) ? res : res?.groups)?.[0] as VkGroup | undefined
  if (!group) throw new VkError(100, 'Сообщество не найдено')
  return group
}

export async function uploadWallPhoto(groupId: number, token: string, buf: Buffer, mime = 'image/png'): Promise<string> {
  const { upload_url } = await vkCall<{ upload_url: string }>('photos.getWallUploadServer', { group_id: groupId }, token)
  const form = new FormData()
  form.append('photo', new Blob([new Uint8Array(buf)], { type: mime }), mime === 'image/jpeg' ? 'photo.jpg' : 'photo.png')
  const up = await fetch(upload_url, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
  const u = await up.json() as { server: number, photo: string, hash: string }
  if (!u.photo || u.photo === '[]') throw new VkError(100, 'ВКонтакте не принял фото')
  const saved = await vkCall<Array<{ id: number, owner_id: number }>>('photos.saveWallPhoto', { group_id: groupId, photo: u.photo, server: u.server, hash: u.hash }, token)
  const p = saved[0]
  if (!p) throw new VkError(100, 'ВКонтакте не сохранил фото')
  return `photo${p.owner_id}_${p.id}`
}

export async function wallPost(groupId: number, token: string, message: string, attachments: string[]): Promise<number> {
  const res = await vkCall<{ post_id: number }>('wall.post', {
    owner_id: -groupId, from_group: 1, message: message.slice(0, 15_000), attachments: attachments.slice(0, 10).join(','),
  }, token, 30_000)
  return res.post_id
}

export const vkPostUrl = (groupId: number | string, postId: number | string) => `https://vk.com/wall-${groupId}_${postId}`
