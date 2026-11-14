import { CARD_TEMPLATES, type CardTemplateId, normalizeCard } from './card-templates'

const MONTHS = 'январ[ьяе]|феврал[ьяе]|март[ае]?|апрел[ьяе]|ма[йея]|июн[ьяе]|июл[ьяе]|август[ае]?|сентябр[ьяе]|октябр[ьяе]|ноябр[ьяе]|декабр[ьяе]|зима|весна|лето|осень'
const LABELS = /^(рубрика|заголовок|вопрос|ответ|подсказка|подпись|показатель|место|город|месяц и год|дата|тезисы|примеры|шаги|вехи|звенья(?: переработки)?|короткий ответ|(?:тезис|шаг|звено|пояснение|дата|что произошло) [123])\s*:\s*(.*)$/i
const clean = (v?: string | null) => (v || '').trim().replace(/[.?!]+$/, '')
const capitalize = (v: string) => v ? v[0]!.toLocaleUpperCase('ru') + v.slice(1) : ''
const sentences = (v: string) => v.split('\n').flatMap(line => line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).map(p => p.trim()).filter(Boolean)
const splitItems = (v: string) => v.split(/[;,]|\n/).map(p => clean(p.replace(/^\s*(?:[•–—-]|\d[.)])\s*/, ''))).filter(Boolean)

export function stripMarkdown(md: string): string {
  return md
    .replace(/<\/?(details|summary|u|ins|sub|sup|tg-[a-z-]+)[^>]*>/g, '\n')
    .replace(/^!\[[^\]]*\]\([^)]*\)$/gm, '')
    .replace(/^\|\s*:?-{3,}.*$/gm, '')
    .replace(/^\|\s*(.*?)\s*\|\s*$/gm, (_, row: string) => row.split(/\s*\|\s*/).filter(Boolean).join(': '))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+\[[ x]\]\s+/gm, '$1- ')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/(\*\*|__|~~|==|\|\|)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\w*])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\\([\\`*_~=|[\]#<>$-])/g, '$1')
}

function readNews(news: string) {
  const lines = stripMarkdown(news).trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const named: Record<string, string> = {}
  const body = lines.filter((line) => {
    const m = line.match(LABELS)
    if (!m) return true
    named[m[1]!.toLowerCase()] = m[2]!.trim()
    return false
  })
  const plain = body.join('\n')
  const parts = sentences(plain)
  const first = body[0] || ''
  const title = named['заголовок'] || clean(body.length > 1 && first.length <= 75 ? first : parts[0])
  const asked = named['вопрос'] || (parts.find(p => p.endsWith('?')) ?? '')
  const itemKey = Object.keys(named).find(k => ['тезисы', 'примеры', 'шаги', 'вехи', 'звенья', 'звенья переработки'].includes(k))
  const bulletLines = body.filter(l => /^(?:[•–—-]|\d[.)])\s+/.test(l)).map(l => l.replace(/^\s*(?:[•–—-]|\d[.)])\s*/, ''))
  const bulletItems = bulletLines.length >= 2 ? bulletLines.map(l => clean(l.match(/^([^:]{2,28}):\s/)?.[1] ?? l)) : splitItems(bulletLines.join('\n'))
  return { named, plain, body, parts, title, asked, items: itemKey ? splitItems(named[itemKey]!) : bulletItems }
}

const TOPICS: Array<[RegExp, string, CardTemplateId]> = [
  [/форум|выставк|конференц|семинар|вебинар/i, 'Событие', 'event'],
  [/вторсыр|стеклобо|переработ|ресурс|эколог/i, 'Экология', 'ecology'],
  [/квалификац|ваканс|стажиров|обучени|сотрудник|команд/i, 'Карьера', 'people'],
  [/отгруз|завод|производств|выпуск|линии/i, 'Производство', 'plant'],
  [/заказ|образц|заявк|как оформить|шаг/i, 'Сервис', 'service'],
  [/клубный дом|остеклени[яе] (?:здани|объект|клубн)|фасад|жилой комплекс|реализованн/i, 'Проект', 'project'],
  [/светопропускан|толщин|характеристик|продукт|марк[аи]/i, 'Продукт', 'product'],
]

export function inferTag(text: string, rubric?: string | null): string {
  const news = readNews(text)
  if (news.named['рубрика']) return news.named['рубрика']
  if (news.named['звенья переработки']) return 'Экология'
  if (rubric && rubric.length <= 24) return rubric
  return TOPICS.find(([p]) => p.test(news.plain))?.[1] || (news.asked ? 'Гайд' : 'Новость')
}

export function guessTemplate(text: string): CardTemplateId {
  const { plain, asked, named } = readNews(text)
  if (named['звенья'] || named['звенья переработки']) return 'ecology'
  if (/(\d+[,.]?\d*\s*%)|\d[\d\s]*(?:м²|м³|тонн|шт\.)/i.test(plain) && !/\d{4}\s*[—–-]/.test(plain)) return 'product'
  if (new RegExp(`\\d{1,2}(?:\\s*(?:по|[-–—])\\s*\\d{1,2})?\\s+(?:${MONTHS})`, 'i').test(plain) && /форум|выставк|конференц|семинар|мероприят/i.test(plain)) return 'event'
  if ((plain.match(new RegExp(`(?:${MONTHS})?\\s*\\d{4}\\s*[—–:-]`, 'gi'))?.length ?? 0) >= 2) return 'plant'
  if (/сначала|затем|шаг/i.test(plain)) return 'service'
  if (asked && /ответ:/i.test(text)) return 'quiz'
  if (asked) return 'guide'
  return TOPICS.find(([p]) => p.test(plain))?.[2] ?? 'project'
}

export function extractCardFields(id: CardTemplateId, text: string, opts: { title?: string, rubric?: string | null } = {}): Record<string, string> {
  const news = readNews(text)
  const { named, plain, body, parts, asked, items } = news
  const title = opts.title || news.title
  const values: Record<string, string> = { tag: inferTag(text, opts.rubric), title }
  const percent = plain.match(/\d+(?:[,.]\d+)?\s*%/)?.[0].replace(/\s/g, '')
  const model = plain.match(/\b[A-Z][a-z]+\s+[A-Z]\d+\b/)?.[0]
  const thickness = plain.match(/\b\d+(?:[,.]\d+)?\s*мм(?=\s|[.,;!]|$)/i)?.[0]
  const factLabel = /светопропускани/i.test(plain) ? 'Светопропускание' : ''

  if (id === 'product') {
    const measurement = plain.match(/\d+(?:[  ]\d{3})*(?:[,.]\d+)?\s*(?:м²|м³|кг|тыс\.|млн|тонн[ыа]?|ед\.|шт\.)(?=\s|[.,;!]|$)/i)
    values.value = named['показатель'] || percent || measurement?.[0] || plain.match(/\b\d[\d  ]*(?:[,.]\d+)?\b/)?.[0]?.trim() || ''
    values.detail = named['подпись'] || [factLabel, thickness].filter(Boolean).join(' · ') || clean(parts.find(p => p.includes(values.value!) && p.length <= 60) ?? '')
  }
  if (id === 'guide') {
    values.question = asked || (title.endsWith('?') ? title : '')
    values.detail = named['короткий ответ'] || named['ответ'] || clean(parts.find(p => p !== asked && !p.endsWith('?')) ?? '')
  }
  if (id === 'project') {
    const short = parts.slice(title === clean(parts[0]) ? 1 : 0).map(clean).find(p => p.length >= 8 && p.length <= 46)
    values.detail = named['подпись'] || capitalize(plain.match(/стекло\s+[A-ZА-ЯЁ]\d+[\w-]*(?:\s+[A-Za-z]+)?/u)?.[0] ?? '') || short || ''
  }
  if (id === 'event') {
    const date = plain.match(new RegExp(`(?:с\\s+)?(\\d{1,2})(?:\\s*(?:по|[-–—])\\s*(\\d{1,2}))?\\s+(${MONTHS})(?:\\s+(\\d{4}))?`, 'i'))
    values.value = named['дата'] || (date ? [date[1], date[2]].filter(Boolean).join('–') : '')
    values.period = named['месяц и год'] || (date ? [date[3], date[4]].filter(Boolean).join(' ') : '')
    values.detail = named['место'] || named['город']
      || plain.match(/(?:^|\s)в\s+(Москве|Казани|Уфе|Санкт-Петербурге|Екатеринбурге|Новосибирске|Самаре|Нижнем Новгороде)/)?.[1]
      || plain.match(/(?:г\.\s*|город\s+)([А-ЯЁ][а-яё-]+)/u)?.[1]
      || (/онлайн/i.test(plain) ? 'Онлайн' : '')
    const city: Record<string, string> = { Москве: 'Москва', Казани: 'Казань', Уфе: 'Уфа', 'Санкт-Петербурге': 'Санкт-Петербург', Екатеринбурге: 'Екатеринбург', Новосибирске: 'Новосибирск', Самаре: 'Самара', 'Нижнем Новгороде': 'Нижний Новгород' }
    values.detail = city[values.detail] ?? values.detail
  }
  if (id === 'quiz') {
    values.question = asked || (factLabel && percent ? 'Сколько света пропускает стекло?' : title.endsWith('?') ? title : '')
    values.detail = named['подсказка'] || [model, thickness].filter(Boolean).join(' · ')
    values.answer = named['ответ'] || (factLabel ? percent ?? '' : '')
  }

  const dateLine = new RegExp(`^((?:\\d{1,2}\\s+)?(?:${MONTHS})\\s+\\d{4}|\\d{4})\\s*[-–—:]\\s*(.+)$`, 'i')
  const pairList = id === 'plant'
    ? [...(named['вехи'] ? splitItems(named['вехи']) : []), ...body.flatMap(l => l.split(/(?<=[.;])\s+/))]
        .map(l => l.trim().match(dateLine)).filter(Boolean).map(m => [m![1]!, m![2]!])
    : items.map(l => l.split(/\s+[–—-]\s+|\s*:\s*/)).filter(p => p.length === 2)
  const usages = ([[/витрин/i, 'Витрина'], [/музе[йяе]|музейны/i, 'Музей'], [/смотров/i, 'Смотровая']] as const)
    .filter(([p]) => p.test(plain)).map(([, n]) => n)
  const steps = plain.match(/сначала\s+([^,.]+),\s*затем\s+([^,.]+?)\s+и\s+([^,.!?]+)/i)?.slice(1) ?? []
  const candidates: string[] = items.length ? items : id === 'guide' ? [...usages] : id === 'service' ? steps : id === 'people' ? parts.slice(1).filter(p => p.length <= 30) : []
  for (let i = 0; i < 3; i++) {
    const n = i + 1
    if (id === 'ecology' || id === 'plant') {
      values[`key${i}`] = named[`${id === 'plant' ? 'дата' : 'звено'} ${n}`] || capitalize(clean(pairList[i]?.[0]))
      values[`item${i}`] = named[`${id === 'plant' ? 'что произошло' : 'пояснение'} ${n}`] || clean(pairList[i]?.[1])
    }
    else {
      const explicit = named[`${id === 'service' ? 'шаг' : 'тезис'} ${n}`]
      const c = candidates[i]
      values[`item${i}`] = explicit || (c && !/\s[–—]\s/.test(c) ? (id === 'service' ? clean(c) : capitalize(clean(c))) : '')
    }
  }
  return normalizeCard({ template: id, fields: values })
}

export function completeCardFields(id: CardTemplateId, fromModel: Record<string, string>, text: string, opts: { title?: string, rubric?: string | null } = {}) {
  const rules = extractCardFields(id, text, opts)
  const out: Record<string, string> = {}
  for (const field of [{ key: 'tag' }, ...CARD_TEMPLATES[id].fields]) out[field.key] = fromModel[field.key]?.trim() || rules[field.key] || ''
  return normalizeCard({ template: id, fields: out })
}
