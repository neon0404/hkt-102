import { remoteSpeechEnabled, remoteSynthesize } from '../speech-remote'
import { speakable } from './speech'

export interface Speech { rate: number, clips: Float32Array[] }

export async function synthesize(texts: string[]): Promise<Speech | null> {
  if (process.env.TTS_DISABLED === '1') return null
  if (!remoteSpeechEnabled()) return null
  try { return await remoteSynthesize(texts.map(speakable)) }
  catch (e) {
    console.warn('[tts] компьютер оператора недоступен:', (e as Error).message.slice(0, 160))
    return null
  }
}

export function speechTrack(speech: Speech, starts: number[], totalSec: number, lead = 0.25): Buffer {
  const n = Math.ceil(totalSec * speech.rate)
  const pcm = new Float32Array(n)
  speech.clips.forEach((clip, i) => {
    const at = Math.round(((starts[i] ?? 0) + lead) * speech.rate)
    for (let k = 0; k < clip.length && at + k < n; k++) pcm[at + k] = clip[k]! * 0.95
  })
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(speech.rate, 24); buf.writeUInt32LE(speech.rate * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * 32767))), 44 + i * 2)
  return buf
}
