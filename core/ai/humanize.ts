const KEEP = new Set(['chunk_id', 'used_chunk_ids', 'template', 'intent', 'sentiment', 'date', 'time', 'schedule_at', 'photo_query'])

const FRAGMENT: Record<string, string> = {
  фрагмент: 'материал', фрагмента: 'материала', фрагменту: 'материалу', фрагментом: 'материалом', фрагменте: 'материале',
  фрагменты: 'материалы', фрагментов: 'материалов', фрагментам: 'материалам', фрагментами: 'материалами', фрагментах: 'материалах',
}

const ALIAS = String.raw`(?<![\p{L}\p{N}])\[?c\d{1,2}\]?(?![\p{L}\p{N}])`
const ALIAS_LIST = String.raw`${ALIAS}(?:\s*(?:,|и|and)\s*${ALIAS})*`

export function humanize(s: string): string {
  const out = s
    .replace(new RegExp(String.raw`\(?\s*(?:chunk_ids?|used_chunk_ids)\s*[:=]?\s*(?:${ALIAS_LIST})?\s*\)?\s*[—–:-]?\s*`, 'giu'), ' ')
    .replace(new RegExp(String.raw`\s*[(]?\s*(?:(?:по\s+)?(?:фрагмент\p{L}*|источник\p{L}*)\s+)?${ALIAS_LIST}\s*[)]?`, 'gu'), ' ')
    .replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')
    .replace(/(^|\n)\s*(?:warnings?|notes?|facts?|caption|hook|reply|reason)\s*:\s*/gi, '$1')
    .replace(/(?<!\p{L})фрагмент\p{L}*/giu, (w) => {
      const to = FRAGMENT[w.toLowerCase()]
      if (!to) return w
      return w[0] !== w[0]!.toLowerCase() ? to[0]!.toUpperCase() + to.slice(1) : to
    })
    .replace(/\s*[—–-]\s*(?=[.,;!?]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:—–-]+/, '')
    .trim()
  const fixed = out.replace(/[,;]\s*(?=[.!?])/g, '')
  return fixed && /^\p{Ll}/u.test(fixed) && !s.trim().startsWith(fixed.slice(0, 4)) ? fixed[0]!.toUpperCase() + fixed.slice(1) : fixed
}

export function isReferenceNoise(s: string): boolean {
  const refs = new RegExp(String.raw`${ALIAS}|chunk|фрагмент`, 'iu')
  return refs.test(s) && /указан|подтвержд|ссыл|задани|псевдоним/iu.test(s) && humanize(s).split(/\s+/).length < 12
}

export const humanWarnings = (list: string[]) => [...new Set(list.filter(w => !isReferenceNoise(w)).map(humanize).filter(Boolean))]

export function humanizeDeep<T>(value: T, key = ''): T {
  if (KEEP.has(key)) return value
  if (typeof value === 'string') return humanize(value) as T
  if (key === 'warnings' && Array.isArray(value)) return humanWarnings(value.filter((v): v is string => typeof v === 'string')) as T
  if (Array.isArray(value)) return value.map(v => humanizeDeep(v, key)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, humanizeDeep(v, k)])) as T
  }
  return value
}
