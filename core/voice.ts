import { remoteSpeechEnabled, remoteTranscribe } from './speech-remote'

export class VoiceError extends Error {}

const UNAVAILABLE = 'Голосовые распознаёт компьютер оператора, а он сейчас недоступен. Напишите задачу текстом'

export async function transcribe(audio: Buffer): Promise<string> {
  if (remoteSpeechEnabled()) {
    try { return await remoteTranscribe(audio) }
    catch (e) { console.warn('[voice] компьютер оператора недоступен:', (e as Error).message.slice(0, 160)) }
  }
  throw new VoiceError(UNAVAILABLE)
}
