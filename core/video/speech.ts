const UNITS = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']

function below1000(n: number, feminine = false): string[] {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10
  const out = [HUNDREDS[h]!]
  if (t === 1) out.push(TEENS[u]!)
  else {
    out.push(TENS[t]!)
    out.push(feminine && u === 1 ? 'одна' : feminine && u === 2 ? 'две' : UNITS[u]!)
  }
  return out.filter(Boolean)
}

const plural = (n: number, [one, few, many]: [string, string, string]) => {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many
}

export function numberToWords(n: number): string {
  if (n === 0) return 'ноль'
  const parts: string[] = []
  const millions = Math.floor(n / 1e6), thousands = Math.floor((n % 1e6) / 1000), rest = n % 1000
  if (millions) parts.push(...below1000(millions), plural(millions, ['миллион', 'миллиона', 'миллионов']))
  if (thousands) parts.push(...below1000(thousands, true), plural(thousands, ['тысяча', 'тысячи', 'тысяч']))
  if (rest) parts.push(...below1000(rest))
  return parts.join(' ')
}

const LAT: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'й', z: 'з',
}
const DIGRAPHS: Array<[RegExp, string]> = [[/sh/g, 'ш'], [/ch/g, 'ч'], [/th/g, 'т'], [/ph/g, 'ф'], [/ee/g, 'и'], [/oo/g, 'у'], [/iew/g, 'ью'], [/ew/g, 'ью'], [/ck/g, 'к']]

function translit(word: string): string {
  let w = word.toLowerCase()
  for (const [re, to] of DIGRAPHS) w = w.replace(re, to)
  return [...w].map(ch => LAT[ch] ?? ch).join('')
}

export function speakable(text: string): string {
  return text
    .replace(/([A-Za-zА-Яа-яЁё])(\d)/g, '$1 $2')
    .replace(/(\d+)[,.](\d+)/g, (_, a, b) => `${numberToWords(Number(a))} и ${numberToWords(Number(b))}`)
    .replace(/(\d+)\s*%/g, (_, a) => `${numberToWords(Number(a))} ${plural(Number(a), ['процент', 'процента', 'процентов'])}`)
    .replace(/(\d+)\s*мм(?![а-яё])/gi, (_, a) => `${numberToWords(Number(a))} ${plural(Number(a), ['миллиметр', 'миллиметра', 'миллиметров'])}`)
    .replace(/(\d+)\s*м(?![а-яё])/gi, (_, a) => `${numberToWords(Number(a))} ${plural(Number(a), ['метр', 'метра', 'метров'])}`)
    .replace(/\d+/g, a => numberToWords(Number(a)))
    .replace(/[A-Za-z]+/g, translit)
    .replace(/[«»"“”()\[\]]/g, '')
    .replace(/[—–]/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
