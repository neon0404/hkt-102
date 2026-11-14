function partsInTz(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]))
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second! }
}

export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = partsInTz(date, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
  return Math.round((asUtc - date.getTime()) / 60000)
}

export function zonedToUtc(local: string, tz: string): Date | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)
  const offset = tzOffsetMinutes(new Date(guess), tz)
  return new Date(guess - offset * 60000)
}

const pad = (n: number) => String(n).padStart(2, '0')

export function localIso(date: Date, tz: string): string {
  const p = partsInTz(date, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`
}

export function localDate(date: Date, tz: string): string {
  return localIso(date, tz).slice(0, 10)
}

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export function weekdayInTz(date: Date, tz: string): string {
  const p = partsInTz(date, tz)
  return WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]!
}

export function humanTime(date: Date | null | undefined, tz: string): string {
  if (!date) return 'сразу после согласования'
  const p = partsInTz(date, tz)
  const off = tzOffsetMinutes(date, tz)
  const sign = off >= 0 ? '+' : '−'
  const hh = Math.floor(Math.abs(off) / 60)
  const mm = Math.abs(off) % 60
  return `${pad(p.d)}.${pad(p.m)}, ${pad(p.h)}:${pad(p.min)} (UTC${sign}${hh}${mm ? `:${pad(mm)}` : ''})`
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true }
  catch { return false }
}
