import { Api, GrammyError, HttpError, InputFile } from 'grammy'
import { config } from '../config'

const apis = new Map<string, Api>()

export const sentListeners = new Set<(chatId: number | string) => void>()
const SILENT = new Set(['sendChatAction', 'sendRichMessageDraft', 'sendMessageDraft'])

function proxiedFetch(url: any, init: any = {}): any {
  const { signal, ...rest } = init
  let native: AbortSignal | undefined
  if (signal) {
    const c = new AbortController()
    if (signal.aborted) c.abort()
    else signal.addEventListener('abort', () => c.abort())
    native = c.signal
  }
  const streamed = rest.body && typeof rest.body !== 'string' && !(rest.body instanceof URLSearchParams)
  return globalThis.fetch(url, { ...rest, signal: native, ...(streamed ? { duplex: 'half' } : {}) })
}

export function tgClient(): { fetch: any } | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy ? { fetch: proxiedFetch } : undefined
}

export function tg(token?: string | null): Api {
  const t = token || config.telegramBotToken
  if (!t) throw new Error('Не задан TELEGRAM_BOT_TOKEN')
  let api = apis.get(t)
  if (!api) {
    api = new Api(t, tgClient())
    api.config.use((prev, method, payload, signal) => {
      const chat = (payload as { chat_id?: number | string } | undefined)?.chat_id
      if (method.startsWith('send') && !SILENT.has(method) && chat !== undefined) for (const l of sentListeners) l(chat)
      return prev(method, payload, signal)
    })
    apis.set(t, api)
  }
  return api
}

let botInfo: { id: number, username: string } | null = null
export async function getBotInfo() {
  if (!botInfo) {
    const me = await tg().getMe()
    botInfo = { id: me.id, username: me.username }
  }
  return botInfo
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function sendText(chatId: number | string, html: string, extra: Record<string, unknown> = {}) {
  try {
    return await tg().sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra } as any)
  }
  catch (e) {
    console.warn('[tg] не удалось отправить сообщение', chatId, (e as Error).message)
    return null
  }
}

export { GrammyError, HttpError, InputFile }
