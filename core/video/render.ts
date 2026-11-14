import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Canvas, createCanvas, type Image, type SKRSContext2D } from '@napi-rs/canvas'
import type { AiRun } from '../ai/ops'
import type { VideoScriptOut } from '../ai/schemas'
import type { TenantSettings } from '../db/schema'
import { readMedia } from '../media'
import {
  type Brand, brandFonts, contained, covered, decor, type Drawable, ensureFonts, imageFrom, type Palette, paletteFor, tintedLogo, wrap,
} from '../image/card-render'
import { findPhoto } from '../image/photos'
import { speechTrack, synthesize } from './tts'

export const W = 720
export const H = 1280
const FPS = 25
const FADE = 0.4
const END_SEC = 2.6

type Tenant = { id: string, name: string, settings: TenantSettings }
type Scene = VideoScriptOut['scenes'][number]

export interface VideoScene { onScreen: string, subtitle: string, sec: number, photo: Drawable | null }

export function sceneDurations(scenes: Scene[], total: number): number[] {
  const parsed = scenes.map((s) => {
    const m = s.time.replace(',', '.').match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/)
    return m ? Number(m[2]) - Number(m[1]) : null
  })
  const fallback = Math.max(2.5, (total || 30) / Math.max(1, scenes.length))
  return parsed.map((d, i) => {
    const readable = 1.2 + (scenes[i]!.voiceover?.length ?? 0) / 14
    return Math.round(Math.min(8, Math.max(2.5, d && d > 0 ? d : fallback, Math.min(readable, 8))) * 10) / 10
  })
}

const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

interface Frame { ctx: SKRSContext2D, pal: Palette, fonts: { display: string, text: string }, logo: Drawable | null, pattern: Drawable | null, tenantName: string }

function drawLogo(f: Frame, x: number, y: number, w: number, h: number, color = '#ffffff') {
  const { ctx } = f
  if (f.logo) { contained(ctx, f.logo, x, y, w, h); return }
  ctx.font = `800 26px ${f.fonts.display}`
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillText(f.tenantName.toLocaleUpperCase('ru').slice(0, 24), x, y + 6)
}

function fitText(ctx: SKRSContext2D, text: string, font: (px: number) => string, width: number, rows: number, max: number, min: number) {
  for (let px = max; px >= min; px -= 2) {
    ctx.font = font(px)
    const lines = wrap(ctx, text, width)
    if (lines.length <= rows) return { px, lines }
  }
  ctx.font = font(min)
  return { px: min, lines: wrap(ctx, text, width).slice(0, rows) }
}

function drawScene(f: Frame, s: VideoScene, t: number, index: number, count: number, hook: boolean) {
  const { ctx, pal } = f
  const p = t / s.sec
  ctx.fillStyle = pal.dark
  ctx.fillRect(0, 0, W, H)
  if (s.photo) {
    const zoom = 1.08 + 0.07 * p
    const dx = (index % 2 ? -1 : 1) * 12 * p
    ctx.save()
    ctx.translate(W / 2 + dx, H / 2)
    ctx.scale(zoom, zoom)
    covered(ctx, s.photo, -W / 2, -H / 2, W, H)
    ctx.restore()
  }
  else if (f.pattern) {
    ctx.globalAlpha = 0.35
    covered(ctx, f.pattern, 0, 0, W, H)
    ctx.globalAlpha = 1
  }
  const g = ctx.createLinearGradient(0, H * 0.32, 0, H)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.45, `${pal.dark}cc`)
  g.addColorStop(1, `${pal.dark}f5`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  const top = ctx.createLinearGradient(0, 0, 0, 220)
  top.addColorStop(0, 'rgba(0,0,0,0.45)')
  top.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, W, 220)

  const gap = 8, bw = (W - 64 - gap * (count - 1)) / count
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillRect(32 + i * (bw + gap), 34, bw, 5)
    const fill = i < index ? 1 : i === index ? p : 0
    if (fill > 0) { ctx.fillStyle = '#ffffff'; ctx.fillRect(32 + i * (bw + gap), 34, bw * fill, 5) }
  }
  drawLogo(f, 32, 62, 170, 64)

  const appear = ease(t / 0.55)
  const lift = (1 - appear) * 40
  ctx.globalAlpha = appear
  const left = 48, width = W - 96
  const head = s.onScreen.trim()
  const sub = s.subtitle.trim()
  ctx.font = `500 30px ${f.fonts.text}`
  const subLines = sub ? wrap(ctx, sub, width).slice(0, 5) : []
  const subH = subLines.length * 42
  const bottom = H - 120
  let y = bottom - subH
  if (head) {
    const { px, lines } = fitText(ctx, hook ? head.toLocaleUpperCase('ru') : head, n => `800 ${n}px ${f.fonts.display}`, width, hook ? 4 : 3, hook ? 74 : 60, 36)
    const lh = px * 1.08
    y -= lines.length * lh + 30
    ctx.fillStyle = pal.accent
    ctx.fillRect(left, y - 26 + lift, 72, 8)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    for (const [i, line] of lines.entries()) ctx.fillText(line, left, y + i * lh + lift)
    y += lines.length * lh + 30
  }
  ctx.font = `500 30px ${f.fonts.text}`
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  for (const [i, line] of subLines.entries()) ctx.fillText(line, left, y + i * 42 + lift * 0.6)
  ctx.globalAlpha = 1
}

function drawEnd(f: Frame, title: string, t: number) {
  const { ctx, pal } = f
  ctx.fillStyle = pal.teal
  ctx.fillRect(0, 0, W, H)
  if (f.pattern) { ctx.globalAlpha = 0.25; covered(ctx, f.pattern, 0, 0, W, H); ctx.globalAlpha = 1 }
  const a = ease(t / 0.6)
  ctx.globalAlpha = a
  const lw = 380, lh = 150
  drawLogo(f, (W - lw) / 2, H * 0.36 - lh / 2, lw, lh)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillRect(W / 2 - 40, H * 0.36 + lh / 2 + 36, 80, 4)
  const { px, lines } = fitText(ctx, title, n => `800 ${n}px ${f.fonts.display}`, W - 140, 3, 48, 30)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const [i, line] of lines.entries()) ctx.fillText(line, W / 2, H * 0.36 + lh / 2 + 70 + i * px * 1.1 + (1 - a) * 30)
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1
}

function prepared(img: Image | null): Canvas | null {
  if (!img) return null
  const c = createCanvas(W, H)
  covered(c.getContext('2d'), img, 0, 0, W, H)
  return c
}

export interface VideoInput {
  tenant: Tenant
  script: VideoScriptOut
  run?: AiRun | null
  offline?: boolean
}

export interface RenderedVideo { mp4: Buffer, cover: Buffer, durationSec: number, photos: number, voiced: boolean }

export async function renderVideo(input: VideoInput): Promise<RenderedVideo> {
  ensureFonts()
  const { tenant, script } = input
  const brand: Brand = tenant.settings.brand ?? {}
  const pal = paletteFor(brand.primary)
  const fonts = await brandFonts(tenant.id, brand)
  const [logoLight, logoColor, pattern] = await Promise.all([
    readMedia(tenant.id, brand.logo_light_media_id).then(imageFrom),
    readMedia(tenant.id, brand.logo_media_id).then(imageFrom),
    readMedia(tenant.id, brand.pattern_media_id).then(imageFrom),
  ])
  const logo = logoLight ?? (logoColor ? tintedLogo(logoColor, '#ffffff') : null)
  const scenes = script.scenes.slice(0, 7)
  const durations = sceneDurations(scenes, script.duration_sec)
  const speech = input.offline ? null : await synthesize(scenes.map(s => s.speech || s.voiceover))
  if (speech) speech.clips.forEach((c, i) => { durations[i] = Math.max(durations[i]!, Math.round((c.length / speech.rate + 0.7) * 10) / 10) })

  const seen: string[] = []
  const list: VideoScene[] = []
  for (const [i, s] of scenes.entries()) {
    const pick = input.offline ? null : await findPhoto(tenant, { query: s.photo_query || s.visual, seen, run: null, any: true }).catch(() => null)
    if (pick?.photo.ref) seen.push(pick.photo.ref)
    list.push({ onScreen: s.on_screen || (i === 0 ? script.hook : ''), subtitle: s.voiceover, sec: durations[i]!, photo: prepared(await imageFrom(pick?.buf ?? null)) })
  }
  const frame0: Frame = { ctx: null as any, pal, fonts, logo, pattern: pattern ?? await decor('decor-2', pal.hue), tenantName: tenant.name }
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const f = { ...frame0, ctx }
  const total = list.reduce((a, s) => a + s.sec, 0) + END_SEC
  const frames = Math.round(total * FPS)

  const starts: number[] = []
  list.reduce((acc, s) => { starts.push(acc); return acc + s.sec }, 0)
  const endStart = list.reduce((a, s) => a + s.sec, 0)
  function paint(time: number) {
    if (time >= endStart) {
      const t = time - endStart
      if (t < FADE && list.length) {
        const last = list.at(-1)!
        drawScene(f, last, last.sec, list.length - 1, list.length, list.length === 1)
        ctx.globalAlpha = t / FADE
        ctx.drawImage(sceneSnapshot(() => drawEnd(f, script.title, t)), 0, 0)
        ctx.globalAlpha = 1
      }
      else drawEnd(f, script.title, t)
      return
    }
    let i = starts.findLastIndex(s => s <= time)
    if (i < 0) i = 0
    const t = time - starts[i]!
    if (i > 0 && t < FADE) {
      const prev = list[i - 1]!
      drawScene(f, prev, prev.sec, i - 1, list.length, i - 1 === 0)
      ctx.globalAlpha = t / FADE
      ctx.drawImage(sceneSnapshot(() => drawScene(f, list[i]!, t, i, list.length, false)), 0, 0)
      ctx.globalAlpha = 1
    }
    else drawScene(f, list[i]!, t, i, list.length, i === 0)
  }
  const overlay = createCanvas(W, H)
  const octx = overlay.getContext('2d')
  function sceneSnapshot(draw: () => void): Canvas {
    const saved = f.ctx
    f.ctx = octx
    octx.globalAlpha = 1
    draw()
    f.ctx = saved
    return overlay
  }

  const dir = await mkdtemp(join(tmpdir(), 'aim-video-'))
  const out = join(dir, 'out.mp4')
  try {
    const voice = join(dir, 'voice.wav')
    if (speech) await writeFile(voice, speechTrack(speech, starts, total))
    const audioIn = speech ? ['-i', voice] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']
    const ff = spawn(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
      ...audioIn, '-ar', '44100', '-ac', '2',
      '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-threads', '2', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', out,
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    ff.stderr.on('data', (d) => { stderr += d })
    const done = new Promise<void>((res, rej) => {
      ff.on('error', e => rej(new Error(`ffmpeg не запустился: ${e.message}`)))
      ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-300)}`)))
    })
    let cover: Buffer | null = null
    for (let n = 0; n < frames; n++) {
      paint(n / FPS)
      if (n === Math.round(1.2 * FPS)) cover = await canvas.encode('jpeg', 88)
      const raw = ctx.getImageData(0, 0, W, H).data
      if (!ff.stdin.write(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))) await new Promise(r => ff.stdin.once('drain', r))
    }
    ff.stdin.end()
    await done
    return { mp4: await readFile(out), cover: cover ?? await canvas.encode('jpeg', 88), durationSec: Math.round(total), photos: seen.length, voiced: !!speech }
  }
  finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
