import { config } from '../../config'
import { type ImageResult, type LlmProvider, ProviderError, type StructuredRequest, type StructuredResult } from '../provider'

export class ApiProvider implements LlmProvider {
  name = 'api' as const

  private async call(path: string, body: unknown, timeoutMs: number) {
    if (!config.llmApiKey) throw new ProviderError('auth', 'Не задан LLM_API_KEY', this.name)
    let res: Response
    try {
      res = await fetch(`${config.llmApiBaseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${config.llmApiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    catch (e) {
      const timeout = (e as Error).name === 'TimeoutError'
      throw new ProviderError(timeout ? 'timeout' : 'unavailable', `Сервис модели недоступен: ${(e as Error).message}`, this.name)
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'limit' : res.status >= 500 ? 'unavailable' : 'invalid_response'
      throw new ProviderError(kind, `Ошибка API ${res.status}: ${text}`, this.name)
    }
    return res.json() as Promise<any>
  }

  async generateStructured(req: StructuredRequest): Promise<StructuredResult> {
    const started = Date.now()
    const model = config.llmModel || 'gpt-4o-mini'
    const json = await this.call('/chat/completions', {
      model,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
    }, req.timeoutMs ?? 120_000)
    const text = json.choices?.[0]?.message?.content ?? ''
    let data: unknown
    try { data = JSON.parse(text) }
    catch { throw new ProviderError('invalid_response', `Ответ не является JSON: ${String(text).slice(0, 200)}`, this.name) }
    return {
      data, provider: this.name, model,
      inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - started,
    }
  }

  async generateImage(prompt: string): Promise<ImageResult | null> {
    const started = Date.now()
    const json = await this.call('/images/generations', {
      model: config.imageModel, prompt: `${prompt}. No text, no letters, no people, no logos.`, size: '1024x1024', n: 1,
    }, 180_000)
    const item = json.data?.[0]
    let png: Buffer | null = null
    if (item?.b64_json) png = Buffer.from(item.b64_json, 'base64')
    else if (item?.url) png = Buffer.from(await (await fetch(item.url)).arrayBuffer())
    if (!png) return null
    return { png, provider: this.name, model: config.imageModel, durationMs: Date.now() - started }
  }
}
