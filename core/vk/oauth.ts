import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { config } from '../config'
import { decryptSecret, encryptSecret } from '../crypto'
import { db, schema } from '../db/client'
import { VkError } from './api'

const ID = 'https://id.vk.com'
const SCOPE = 'wall photos groups'

export const vkClientId = () => process.env.VK_CLIENT_ID?.trim() || ''
export const vkRedirectUri = () => `${config.publicBaseUrl}/api/v1/vk/callback`

export interface VkCreds { access_token: string, refresh_token?: string, device_id?: string, expires_at?: number }

interface Pending { tenantId: string, group: string, operator: string, verifier: string, exp: number }
const pending = new Map<string, Pending>()

const b64url = (b: Buffer) => b.toString('base64url')

export function vkAuthorizeUrl(p: { tenantId: string, group: string, operator: string }): string {
  if (!vkClientId()) throw new VkError(100, 'Не задан VK_CLIENT_ID — ID приложения VK ID')
  const now = Date.now()
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k)
  const state = b64url(randomBytes(24))
  const verifier = b64url(randomBytes(48))
  pending.set(state, { ...p, verifier, exp: now + 10 * 60_000 })
  const q = new URLSearchParams({
    response_type: 'code', client_id: vkClientId(), redirect_uri: vkRedirectUri(), state, scope: SCOPE,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  })
  return `${ID}/authorize?${q}`
}

export function takePending(state: string): Pending | null {
  const p = pending.get(state)
  pending.delete(state)
  return p && p.exp > Date.now() ? p : null
}

async function idAuth(params: Record<string, string>): Promise<VkCreds> {
  const res = await fetch(`${ID}/oauth2/auth`, {
    method: 'POST', body: new URLSearchParams({ client_id: vkClientId(), ...params }), signal: AbortSignal.timeout(20_000),
  })
  const json = await res.json() as any
  if (!json.access_token) throw new VkError(5, `ВКонтакте не выдал ключ: ${json.error_description || json.error || res.status}`)
  return {
    access_token: json.access_token, refresh_token: json.refresh_token, device_id: params.device_id,
    expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  }
}

export function exchangeCode(code: string, verifier: string, deviceId: string, state: string): Promise<VkCreds> {
  return idAuth({ grant_type: 'authorization_code', code, code_verifier: verifier, device_id: deviceId, redirect_uri: vkRedirectUri(), state })
}

export async function refreshCreds(c: VkCreds): Promise<VkCreds> {
  if (!c.refresh_token || !c.device_id) return c
  const next = await idAuth({ grant_type: 'refresh_token', refresh_token: c.refresh_token, device_id: c.device_id, state: b64url(randomBytes(16)) })
  return { ...next, refresh_token: next.refresh_token || c.refresh_token }
}

export function parseCreds(raw: string): VkCreds {
  if (raw.trim().startsWith('{')) return JSON.parse(raw) as VkCreds
  return { access_token: raw.trim() }
}

export async function integrationCreds(integration: typeof schema.integrations.$inferSelect): Promise<VkCreds> {
  if (!integration.credentialsEnc) throw new VkError(5, 'Нет ключа доступа ВКонтакте — переподключите сообщество')
  let creds = parseCreds(decryptSecret(integration.credentialsEnc))
  if (creds.refresh_token && (creds.expires_at ?? 0) < Date.now() + 120_000) {
    creds = await refreshCreds(creds)
    await db.update(schema.integrations).set({ credentialsEnc: encryptSecret(JSON.stringify(creds)) }).where(eq(schema.integrations.id, integration.id))
  }
  return creds
}
