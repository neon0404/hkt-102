import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadDotEnv() {
  const file = resolve(process.cwd(), '.env')
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
loadDotEnv()

function env(name: string, fallback = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://app:app@localhost:5433/marketer'),
  secretKey: env('SECRET_KEY', 'dev-secret-change-me'),
  credentialsKey: env('CREDENTIALS_ENCRYPTION_KEY', 'dev-credentials-key-change-me'),
  adminEmail: env('ADMIN_EMAIL', 'admin@example.com'),
  adminPassword: env('ADMIN_PASSWORD', 'admin'),
  telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
  telegramChannelId: env('TELEGRAM_CHANNEL_ID'),
  operatorAlertChatId: env('OPERATOR_ALERT_CHAT_ID'),
  llmProvider: env('LLM_PROVIDER', 'chatgpt_account') as 'mock' | 'api' | 'chatgpt_account',
  llmApiBaseUrl: env('LLM_API_BASE_URL', 'https://api.openai.com/v1'),
  llmApiKey: env('LLM_API_KEY'),
  llmModel: env('LLM_MODEL'),
  codexBin: env('CODEX_BIN', 'codex'),
  codexModel: env('CODEX_MODEL'),
  codexReasoning: env('CODEX_REASONING', 'low'),
  imageProvider: env('IMAGE_PROVIDER', 'template') as 'template' | 'chatgpt_account' | 'api',
  imageModel: env('IMAGE_MODEL', 'gpt-image-1'),
  mediaDir: resolve(env('MEDIA_DIR', './data/media')),
  defaultTimezone: env('DEFAULT_TIMEZONE', 'Asia/Yekaterinburg'),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3000'),
  outboundProxy: env('OUTBOUND_PROXY'),
}

if (process.env.NODE_ENV === 'production' && (config.secretKey === 'dev-secret-change-me' || config.credentialsKey === 'dev-credentials-key-change-me')) {
  console.error('[config] SECRET_KEY или CREDENTIALS_ENCRYPTION_KEY не заданы: сессии и ключи каналов защищены ключом по умолчанию')
}

export type AppConfig = typeof config
