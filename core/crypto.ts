import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto'
import { config } from './config'

const key = () => createHash('sha256').update(config.credentialsKey).digest()

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.')
}

export function decryptSecret(enc: string): string {
  const [iv, tag, data] = enc.split('.').map(p => Buffer.from(p, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', key(), iv!)
  decipher.setAuthTag(tag!)
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8')
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 32).toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'base64url')
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), 32)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export const randomCode = (bytes = 18) => randomBytes(bytes).toString('base64url')

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

export function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', config.secretKey).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken<T = Record<string, unknown>>(token: string | undefined | null): T | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', config.secretKey).update(body).digest()
  const actual = Buffer.from(sig, 'base64url')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number }
    if (payload.exp && payload.exp < Date.now()) return null
    return payload
  }
  catch { return null }
}

export function verifyTelegramInitData(initData: string, botToken: string, maxAgeSec = 86400) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null
  params.delete('hash')
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(dataCheck).digest()
  const actual = Buffer.from(hash, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  const authDate = Number(params.get('auth_date') || 0)
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null
  try {
    return JSON.parse(params.get('user') || 'null') as { id: number, first_name?: string, username?: string } | null
  }
  catch { return null }
}
