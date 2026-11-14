import { config } from '../config'
import { ApiProvider } from './providers/api'
import { CodexProvider } from './providers/codex'
import { MockProvider } from './providers/mock'

export type ProviderName = 'mock' | 'api' | 'chatgpt_account'

export interface StructuredRequest {
  operation: string
  system: string
  user: string
  schema: Record<string, unknown>
  schemaName: string
  timeoutMs?: number
}

export interface StructuredResult {
  data: unknown
  provider: ProviderName
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface ImageResult {
  png: Buffer
  provider: ProviderName
  model: string
  durationMs: number
  inputTokens?: number
  outputTokens?: number
}

export interface LlmProvider {
  name: ProviderName
  generateStructured(req: StructuredRequest): Promise<StructuredResult>
  generateImage(prompt: string): Promise<ImageResult | null>
}

export type ProviderErrorKind = 'timeout' | 'auth' | 'limit' | 'unavailable' | 'invalid_response'

export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public provider: ProviderName) {
    super(message)
    this.name = 'ProviderError'
  }

  get retryable() {
    return this.kind === 'timeout' || this.kind === 'unavailable'
  }
}

const cache = new Map<ProviderName, LlmProvider>()

export function getProvider(name?: ProviderName | null): LlmProvider {
  const key = name || config.llmProvider
  let p = cache.get(key)
  if (!p) {
    p = key === 'mock' ? new MockProvider() : key === 'api' ? new ApiProvider() : new CodexProvider()
    cache.set(key, p)
  }
  return p
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  chatgpt_account: 'Аккаунт ChatGPT (Codex CLI по подписке)',
  api: 'API-ключ (OpenAI-совместимый)',
  mock: 'Заглушка (без модели)',
}
