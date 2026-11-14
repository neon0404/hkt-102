const url = () => process.env.SPEECH_URL?.trim().replace(/\/$/, '') || ''
const token = () => process.env.SPEECH_TOKEN?.trim() || ''
let downUntil = 0

export const remoteSpeechEnabled = () => !!url() && !!token() && Date.now() > downUntil

async function call(path: string, body: Buffer | string, contentType: string, timeoutMs: number): Promise<any> {
  try {
    const res = await fetch(`${url()}${path}`, {
      method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { 'content-type': contentType, 'x-token': token() }, signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`речевой сервис ответил ${res.status}`)
    return await res.json()
  }
  catch (e) {
    downUntil = Date.now() + 120_000
    throw e
  }
}

export async function remoteTranscribe(audio: Buffer): Promise<string> {
  const r = await call('/stt', audio, 'application/octet-stream', 45_000) as { text?: string }
  return (r.text ?? '').trim()
}

export async function remoteSynthesize(texts: string[]): Promise<{ rate: number, clips: Float32Array[] }> {
  const r = await call('/tts', JSON.stringify({ texts }), 'application/json', 90_000) as { rate: number, clips: string[] }
  return {
    rate: r.rate,
    clips: r.clips.map((b) => {
      const buf = Buffer.from(b, 'base64')
      const copy = new Uint8Array(buf.byteLength - (buf.byteLength % 4))
      copy.set(buf.subarray(0, copy.length))
      return new Float32Array(copy.buffer)
    }),
  }
}
