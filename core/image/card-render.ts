import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Canvas, createCanvas, GlobalFonts, Image, loadImage, Path2D, type SKRSContext2D } from '@napi-rs/canvas'
import type { TenantSettings } from '../db/schema'
import { readMedia } from '../media'
import * as shapes from './card-shapes'
import { CARD_TEMPLATES, type CardTemplateId, cardFields } from './card-templates'

const SIZE = 1080
const GRID = 384

function assetDir(): string {
  for (const dir of [resolve(process.cwd(), 'core/image/assets'), resolve(process.cwd(), '../core/image/assets')]) if (existsSync(dir)) return dir
  return resolve(process.cwd(), 'core/image/assets')
}
function fontDir(): string {
  for (const dir of [resolve(process.cwd(), 'app/assets/fonts'), resolve(process.cwd(), '../app/assets/fonts')]) if (existsSync(dir)) return dir
  return resolve(process.cwd(), 'app/assets/fonts')
}

let fontsReady = false
export function ensureFonts() {
  if (fontsReady) return
  const dir = fontDir()
  GlobalFonts.registerFromPath(resolve(dir, 'IntroBlack.ttf'), 'CardDisplay')
  for (const w of ['regular', 'medium', 'demi', 'bold']) GlobalFonts.registerFromPath(resolve(dir, `AvenirNextCyr-${w}.ttf`), 'CardText')
  fontsReady = true
}

const tenantFonts = new Map<string, { display?: string, text?: string }>()
export async function brandFonts(tenantId: string, brand: Brand): Promise<{ display: string, text: string }> {
  const key = `${tenantId}:${brand.font_bold_media_id ?? ''}:${brand.font_regular_media_id ?? ''}`
  let entry = tenantFonts.get(key)
  if (!entry) {
    entry = {}
    const bold = await readMedia(tenantId, brand.font_bold_media_id)
    if (bold && GlobalFonts.register(bold, `B${key}`)) entry.display = `B${key}`
    const regular = await readMedia(tenantId, brand.font_regular_media_id)
    if (regular && GlobalFonts.register(regular, `R${key}`)) entry.text = `R${key}`
    tenantFonts.set(key, entry)
  }
  return { display: entry.display ? `"${entry.display}", CardDisplay` : 'CardDisplay', text: entry.text ? `"${entry.text}", CardText` : 'CardText' }
}

type RGB = [number, number, number]
const toRgb = (hex: string): RGB => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as RGB
const toHex = (c: RGB) => `#${c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`
const mix = (a: string, b: string, t: number) => { const [x, y] = [toRgb(a), toRgb(b)]; return toHex(x.map((v, i) => v + (y[i]! - v) * t) as RGB) }
const rgba = (hex: string, a: number) => { const [r, g, b] = toRgb(hex); return `rgba(${r},${g},${b},${a})` }
function normHex(hex: string | undefined | null, fallback: string): string {
  const h = (hex ?? '').trim()
  if (/^#[0-9a-f]{6}$/i.test(h)) return h.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(h)) return `#${[...h.slice(1)].map(c => c + c).join('')}`.toLowerCase()
  return fallback
}
function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

export interface Palette {
  teal: string
  dark: string
  light: string
  soft: string
  accent: string
  photoBase: string
  line: string
  chip: string
  deep: string
  decorDark: string
  decorLight: string
  decorRing: string
  white: string
  hue: number
}

export function paletteFor(primaryHex?: string | null): Palette {
  const teal = normHex(primaryHex, '#196c7f')
  const [h] = rgbToHsl(toRgb(teal))
  const hsl = (shift: number, s: number, l: number) => toHex(hslToRgb((h + shift + 360) % 360, s, l))
  return {
    teal,
    dark: hsl(-4, 1, 0.145),
    light: hsl(-3.8, 0.333, 0.949),
    soft: hsl(-11, 0.069, 0.875),
    accent: toHex(hslToRgb(h, 1, 0.36)),
    photoBase: mix(teal, '#000000', 0.15),
    line: mix(teal, '#ffffff', 0.08),
    chip: hsl(-1.8, 0.173, 0.794),
    deep: hsl(-3.6, 0.7, 0.196),
    decorDark: hsl(-6, 0.377, 0.239),
    decorLight: hsl(-11, 0.06, 0.871),
    decorRing: hsl(-1, 0.15, 0.788),
    white: '#ffffff',
    hue: h,
  }
}

const decorCache = new Map<string, Image>()
export async function decor(name: 'decor-1' | 'decor-2', hue: number): Promise<Image> {
  const key = `${name}:${Math.round(hue)}`
  const hit = decorCache.get(key)
  if (hit) return hit
  const src = await loadImage(resolve(assetDir(), `${name}.png`))
  const base = rgbToHsl(toRgb('#196c7f'))[0]
  const delta = hue - base
  const c = createCanvas(src.width, src.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(src, 0, 0)
  if (Math.abs(delta) > 4) {
    const data = ctx.getImageData(0, 0, src.width, src.height)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue
      const [hh, s, l] = rgbToHsl([px[i]!, px[i + 1]!, px[i + 2]!])
      if (s < 0.12) continue
      const [r, g, b] = hslToRgb((hh + delta + 360) % 360, s, l)
      px[i] = r; px[i + 1] = g; px[i + 2] = b
    }
    ctx.putImageData(data, 0, 0)
  }
  const img = await loadImage(c.toBuffer('image/png'))
  decorCache.set(key, img)
  return img
}

export async function imageFrom(buf: Buffer | null): Promise<Image | null> {
  if (!buf) return null
  try { return await loadImage(buf) }
  catch { return null }
}

export function tintedLogo(img: Image, color: string): Canvas {
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, img.width, img.height)
  return c
}

export type Brand = NonNullable<TenantSettings['brand']>
export type Drawable = Image | Canvas
const dims = (d: Drawable) => ({ w: d.width, h: d.height })

export function covered(ctx: SKRSContext2D, img: Drawable, x: number, y: number, w: number, h: number, focusX = 0.5) {
  const { w: iw, h: ih } = dims(img)
  const scale = Math.max(w / iw, h / ih)
  const width = iw * scale, height = ih * scale
  ctx.drawImage(img as Image, x + (w - width) * focusX, y + (h - height) / 2, width, height)
}

export function contained(ctx: SKRSContext2D, img: Drawable, x: number, y: number, w: number, h: number) {
  const { w: iw, h: ih } = dims(img)
  const scale = Math.min(w / iw, h / ih)
  ctx.drawImage(img as Image, x, y + (h - ih * scale) / 2, iw * scale, ih * scale)
}

const PHOTO: Partial<Record<CardTemplateId, { box: [number, number, number, number], mask?: Path2D, focusX?: number }>> = {
  product: { box: [0, 0, 384, 384], focusX: 1 },
  quiz: { box: [0, 0, 384, 384], focusX: 1 },
  guide: { box: [241.2, 193.6, 142.8, 190.4], mask: new Path2D(shapes.guidePhoto) },
  people: { box: [0, 127.2, 288, 256.8], mask: new Path2D(shapes.peoplePhoto) },
  project: { box: [0, 86.2, 384, 213.2], mask: new Path2D(shapes.mosaic) },
  event: { box: [28.7, 175.2, 326.5, 183.6], mask: new Path2D(shapes.eventPhoto) },
  ecology: { box: [29, 126.9, 326.2, 137.5], mask: new Path2D(shapes.ecologyPhoto) },
  plant: { box: [0, 126.9, 384, 137.5] },
}

function brandFill(ctx: SKRSContext2D, pal: Palette, x: number, y: number, w: number, h: number, pattern: Drawable | null) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h)
  g.addColorStop(0, pal.teal)
  g.addColorStop(1, pal.dark)
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)
  if (pattern) {
    covered(ctx, pattern, x, y, w, h)
    return
  }
  ctx.fillStyle = rgba('#ffffff', 0.08)
  ctx.beginPath(); ctx.arc(x + w * 0.78, y + h * 0.3, Math.max(w, h) * 0.38, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = rgba('#ffffff', 0.18)
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(x + w * 0.25, y + h * 0.8, Math.max(w, h) * 0.22, 0, Math.PI * 2); ctx.stroke()
}

function paintPhoto(ctx: SKRSContext2D, id: CardTemplateId, pal: Palette, photo: Drawable | null, pattern: Drawable | null) {
  const spot = PHOTO[id]!
  const [x, y, w, h] = spot.box
  ctx.save()
  if (spot.mask) ctx.clip(spot.mask)
  else { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip() }
  ctx.fillStyle = pal.photoBase
  ctx.fillRect(x, y, w, h)
  if (photo) covered(ctx, photo, x, y, w, h, spot.focusX)
  else brandFill(ctx, pal, x, y, w, h, pattern)
  if (id === 'product') {
    const shade = ctx.createLinearGradient(384, 0, 0, 0)
    shade.addColorStop(0, rgba(pal.dark, 0))
    shade.addColorStop(1, rgba(pal.dark, 1))
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, 384, 384)
  }
  if (id === 'quiz') {
    const shade = ctx.createLinearGradient(0, 384, 0, 0)
    shade.addColorStop(0, rgba(pal.dark, 1))
    shade.addColorStop(0.504808, rgba(pal.dark, 0))
    shade.addColorStop(1, rgba(pal.dark, 1))
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, 384, 384)
  }
  ctx.restore()
}

function guideDecor(ctx: SKRSContext2D, pal: Palette) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(-25.8, 211.8, 101.2, 153.6)
  ctx.clip()
  ctx.fillStyle = pal.teal
  ctx.fill(new Path2D(shapes.guideShape))
  ctx.fillStyle = pal.decorLight
  ctx.fill(new Path2D(shapes.guideLight))
  ctx.fillStyle = pal.decorDark
  ctx.fill(new Path2D(shapes.guideDark))
  ctx.strokeStyle = pal.decorRing
  ctx.lineWidth = 0.9
  ctx.stroke(new Path2D(shapes.guideRing))
  ctx.restore()
}

function quizGlass(ctx: SKRSContext2D) {
  const g = ctx.createLinearGradient(0, 82.3, 0, 236.7)
  g.addColorStop(0, 'rgba(255,255,255,0.54)')
  g.addColorStop(1, 'rgba(255,255,255,0.135)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(192, 159.5, 77.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.save()
  ctx.clip(new Path2D(shapes.quizRingMask))
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fill(new Path2D(shapes.quizRing))
  ctx.restore()
}

export function wrap(ctx: SKRSContext2D, value: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of value.split(/\s+/)) {
    if (!line || ctx.measureText(`${line} ${word}`).width <= width) line += (line ? ' ' : '') + word
    else { lines.push(line); line = word }
  }
  return [...lines, line]
}

export interface CardRenderInput {
  tenantId: string
  tenantName: string
  brand: TenantSettings['brand']
  template: CardTemplateId
  fields: Record<string, string>
  photo?: Buffer | null
}

export interface CardRenderResult {
  png: Buffer
  overflow: string[]
  missing: string[]
}

export async function renderCard(input: CardRenderInput): Promise<CardRenderResult> {
  ensureFonts()
  const brand: Brand = input.brand ?? {}
  const id = input.template
  const tpl = CARD_TEMPLATES[id]
  const pal = paletteFor(brand.primary)
  const fonts = await brandFonts(input.tenantId, brand)
  const values = input.fields
  const isDark = tpl.dark

  const [photo, pattern, logoColor, logoLight] = await Promise.all([
    imageFrom(input.photo ?? null),
    readMedia(input.tenantId, brand.pattern_media_id).then(imageFrom),
    readMedia(input.tenantId, brand.logo_media_id).then(imageFrom),
    readMedia(input.tenantId, brand.logo_light_media_id).then(imageFrom),
  ])

  const canvas = createCanvas(SIZE, SIZE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SIZE / GRID, SIZE / GRID)
  const overflow: string[] = []

  ctx.fillStyle = isDark ? pal.dark : pal.light
  ctx.fillRect(0, 0, GRID, GRID)
  if (tpl.photo) paintPhoto(ctx, id, pal, photo, pattern)
  if (id === 'guide') guideDecor(ctx, pal)
  if (id === 'service') ctx.drawImage(await decor('decor-2', pal.hue), 187.9, 174.1, 167.3, 167.3)

  const logo: Drawable | null = isDark
    ? (logoLight ?? (logoColor ? tintedLogo(logoColor, '#ffffff') : null))
    : (logoColor ?? (logoLight ? tintedLogo(logoLight, pal.teal) : null))
  if (logo) contained(ctx, logo, 28.8, 28.8, 81.6, 43.2)
  else {
    ctx.font = `400 15px ${fonts.display}`
    ctx.fillStyle = isDark ? pal.white : pal.teal
    ctx.textBaseline = 'top'
    ctx.textAlign = 'left'
    for (const [i, line] of wrap(ctx, input.tenantName.toLocaleUpperCase('ru'), 150).slice(0, 2).entries()) ctx.fillText(line, 28.8, 32 + i * 17)
  }

  interface Put {
    x: number
    top: number
    width: number
    size: number
    color: string
    rows?: number
    lh?: number
    align?: 'left' | 'center' | 'right'
    upper?: boolean
    display?: boolean
    weight?: number
    minimum?: number
    middle?: number
  }
  function put(key: string, p: Put): number {
    let value = values[key]?.trim() || ''
    if (!value) return p.top
    if (p.upper) value = value.toLocaleUpperCase('ru')
    const rows = p.rows ?? 1
    let size = p.size
    const family = p.display ? fonts.display : fonts.text
    const font = () => { ctx.font = `${p.display ? 400 : p.weight ?? 400} ${size}px ${family}` }
    const minimum = p.minimum ?? Math.ceil(size * 0.72)
    font()
    let lines = rows === 1 ? [value] : wrap(ctx, value, p.width)
    const fits = () => lines.length <= rows && lines.every(l => ctx.measureText(l).width <= p.width)
    while (!fits() && size > minimum) {
      size -= 0.5
      font()
      lines = rows === 1 ? [value] : wrap(ctx, value, p.width)
    }
    if (!fits()) {
      overflow.push(key)
      lines = lines.slice(0, rows).map((line, i, arr) => {
        if (ctx.measureText(line).width <= p.width && (i < arr.length - 1 || arr.join(' ') === value)) return line
        while (line && ctx.measureText(`${line}…`).width > p.width) line = line.slice(0, -1)
        return `${line.trimEnd()}…`
      })
    }
    ctx.textBaseline = 'alphabetic'
    const cap = ctx.measureText('Н').actualBoundingBoxAscent
    const step = size * (p.lh ?? 1)
    const top = p.middle !== undefined ? p.middle - (cap + (lines.length - 1) * step) / 2 : p.top
    ctx.textAlign = p.align ?? 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = p.color
    lines.forEach((line, i) => ctx.fillText(line, p.x, top + cap + i * step))
    return top + cap + (lines.length - 1) * step
  }
  const bar = (x: number, y: number, w: number, h: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }
  const circle = (x: number, y: number, r: number, color: string) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill() }
  const light = isDark ? pal.white : pal.dark
  const second = isDark ? pal.soft : pal.dark

  put('tag', { x: 355.2, top: 45, width: 211, size: 14.4, weight: 600, upper: true, align: 'right', color: isDark ? pal.white : pal.teal, minimum: 11 })

  switch (id) {
    case 'product':
      put('title', { x: 28.8, top: 217.4, width: 326, size: 33.6, display: true, color: light })
      put('value', { x: 28.8, top: 253, width: 326, size: 86, display: true, color: pal.soft, minimum: 40 })
      put('detail', { x: 28.8, top: 325.3, width: 326, size: 16.8, color: second })
      break
    case 'guide':
      put('question', { x: 28.8, top: 88.1, width: 326, size: 33.6, rows: 2, display: true, color: pal.dark })
      put('detail', { x: 28.8, top: 162.5, width: 300, size: 16.8, rows: 2, color: pal.dark })
      for (let i = 0; i < 3; i++) put(`item${i}`, { x: 92.8, top: 249.8 + 30 * i, width: 143, size: 19.4, display: true, color: pal.teal })
      break
    case 'people':
      put('title', { x: 28.8, top: 87.1, width: 326, size: 33.6, display: true, color: light })
      if (values.item0 || values.item1) bar(191.8, 265.5, 192.3, 74.4, pal.dark)
      for (let i = 0; i < 2; i++) {
        if (!values[`item${i}`]) continue
        bar(203.8, 277.5 + 30 * i, 2.4, 20.4, pal.teal)
        put(`item${i}`, { x: 212.2, top: 279.5 + 30 * i, width: 160, size: 20.4, color: pal.soft })
      }
      break
    case 'project':
      put('title', { x: 28.8, top: 310, width: 326, size: 28.8, display: true, color: pal.dark, minimum: 20 })
      put('detail', { x: 28.8, top: 344.6, width: 326, size: 16.8, color: pal.dark })
      break
    case 'event':
      put('value', { x: 28.8, top: 89, width: 150, size: 65.2, display: true, color: pal.teal, minimum: 34 })
      put('period', { x: 28.8, top: 147.4, width: 150, size: 16.8, color: pal.dark })
      put('title', { x: 192.4, top: 87.8, width: 163, size: 28.8, rows: 2, display: true, color: pal.teal })
      put('detail', { x: 192.4, top: 146.5, width: 163, size: 16.8, color: pal.dark })
      break
    case 'ecology': {
      put('title', { x: 28.8, top: 87.6, width: 326, size: 28.8, display: true, color: pal.dark })
      const cols: [number, number][] = [[28.8, 94.5], [135.3, 113.4], [260.7, 94.5]]
      cols.forEach(([x, w], i) => {
        if (!values[`key${i}`] && !values[`item${i}`]) return
        put(`key${i}`, { x: x + w / 2, top: 282.3, width: w + 8, size: 20.4, display: true, align: 'center', color: pal.dark })
        bar(x, 299.4, w, 2.4, pal.teal)
        put(`item${i}`, { x: x + w / 2, top: 304.4, width: w + 8, size: 16.8, rows: 2, align: 'center', color: pal.dark })
      })
      break
    }
    case 'plant':
      put('title', { x: 28.8, top: 87.5, width: 326, size: 33.6, display: true, color: light })
      for (let i = 0; i < 3; i++) {
        if (!values[`key${i}`] && !values[`item${i}`]) continue
        const x = 28.8 + i * 112.8
        bar(x, 279, 100.8, 2.4, pal.teal)
        const base = values[`key${i}`] ? put(`key${i}`, { x, top: 285.2, width: 100.8, size: 20.4, rows: 2, display: true, color: pal.soft }) : 279
        put(`item${i}`, { x, top: base + 6.8, width: 100.8, size: 16.8, rows: 3, color: pal.soft })
      }
      break
    case 'service':
      put('title', { x: 28.8, top: 87.6, width: 300, size: 33.6, rows: 2, display: true, color: pal.dark })
      for (let i = 0, n = 0; i < 3; i++) {
        if (!values[`item${i}`]) continue
        const mid = 225.25 + n * 48.3
        n++
        circle(41.5, mid, 12.75, pal.chip)
        ctx.font = `400 19.4px ${fonts.display}`
        ctx.textBaseline = 'alphabetic'
        const cap = ctx.measureText('1').actualBoundingBoxAscent
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = pal.teal
        ctx.fillText(String(n), 41, mid + cap / 2)
        put(`item${i}`, { x: 60.2, top: 0, middle: mid, width: 92, size: 20.4, rows: 2, color: pal.deep })
      }
      break
    case 'quiz': {
      quizGlass(ctx)
      ctx.font = `400 100px ${fonts.display}`
      const m = ctx.measureText('?')
      const k = 106.3 / (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)
      ctx.font = `400 ${100 * k}px ${fonts.display}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = pal.white
      ctx.fillText('?', 191, 106.3 + m.actualBoundingBoxAscent * k)
      put('question', { x: 192, top: 252.3, width: 330, size: 28.8, rows: 2, display: true, align: 'center', color: pal.white })
      put('detail', { x: 192, top: 324.8, width: 320, size: 16.8, align: 'center', color: pal.soft })
      break
    }
  }

  const missing = cardFields(id).filter(f => !f.optional && !values[f.key]?.trim()).map(f => f.key)
  return { png: canvas.toBuffer('image/png'), overflow, missing }
}
