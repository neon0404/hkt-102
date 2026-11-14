export const CARD_TEMPLATE_IDS = ['product', 'guide', 'people', 'project', 'event', 'ecology', 'plant', 'service', 'quiz'] as const
export type CardTemplateId = typeof CARD_TEMPLATE_IDS[number]

export interface CardField {
  key: string
  label: string
  max: number
  wide?: boolean
  optional?: boolean
}

export interface CardTemplate {
  id: CardTemplateId
  name: string
  when: string
  photo: boolean
  dark: boolean
  fields: CardField[]
}

const f = (key: string, label: string, max: number, wide = false, optional = false): CardField => ({ key, label, max, wide, optional })
const title = (max: number) => f('title', 'Заголовок', max, true)
const question = (max: number) => f('question', 'Вопрос', max, true)
const items = (label: string, count: number, max: number) => Array.from({ length: count }, (_, i) => f(`item${i}`, `${label} ${i + 1}`, max, true))
const pairs = (first: string, second: string, firstMax: number, secondMax: number) =>
  Array.from({ length: 3 }, (_, i) => [f(`key${i}`, `${first} ${i + 1}`, firstMax), f(`item${i}`, `${second} ${i + 1}`, secondMax)]).flat()

export const TAG_FIELD = f('tag', 'Рубрика', 24, true)

export const CARD_TEMPLATES: Record<CardTemplateId, CardTemplate> = {
  product: { id: 'product', name: 'Крупная цифра', when: 'главный показатель продукта или новости: процент, объём, срок', photo: true, dark: true, fields: [title(24), f('value', 'Показатель', 12), f('detail', 'Подпись к цифре', 46)] },
  guide: { id: 'guide', name: 'Вопрос и три тезиса', when: 'полезный совет: вопрос, короткий ответ и три примера применения', photo: true, dark: false, fields: [question(48), f('detail', 'Короткий ответ', 90, true), ...items('Тезис', 3, 18)] },
  people: { id: 'people', name: 'Фото с двумя тезисами', when: 'люди, команда, карьера, обучение', photo: true, dark: true, fields: [title(24), ...items('Тезис', 2, 18)] },
  project: { id: 'project', name: 'Фото в мозаике', when: 'реализованный объект, кейс, любая новость с фотографией', photo: true, dark: false, fields: [title(28), f('detail', 'Подпись к фото', 46, true)] },
  event: { id: 'event', name: 'Событие и фото', when: 'выставка, форум, мероприятие с датой и местом', photo: true, dark: false, fields: [f('value', 'День или диапазон', 8), f('period', 'Месяц и год', 20), title(26), f('detail', 'Место', 22, true)] },
  ecology: { id: 'ecology', name: 'Три звена', when: 'цепочка из трёх связанных понятий: процесс, цикл, экология', photo: true, dark: false, fields: [title(28), ...pairs('Звено', 'Пояснение', 12, 28)] },
  plant: { id: 'plant', name: 'Три вехи', when: 'история, хронология: три даты и события', photo: true, dark: true, fields: [title(24), ...pairs('Дата', 'Что произошло', 22, 40)] },
  service: { id: 'service', name: 'Три шага', when: 'инструкция или порядок действий из трёх шагов', photo: false, dark: false, fields: [title(46), ...items('Шаг', 3, 32)] },
  quiz: { id: 'quiz', name: 'Вопрос аудитории', when: 'вопрос-квиз подписчикам с ответом', photo: true, dark: true, fields: [question(50), f('detail', 'Подсказка', 44, true), f('answer', 'Ответ', 54, true, true)] },
}

export const cardFields = (id: CardTemplateId): CardField[] => [TAG_FIELD, ...CARD_TEMPLATES[id].fields]

export const isCardTemplate = (v: unknown): v is CardTemplateId => typeof v === 'string' && (CARD_TEMPLATE_IDS as readonly string[]).includes(v)

export type CardPhotoSource = 'library' | 'web' | 'ai' | 'upload' | 'none'

export interface CardPhoto {
  media_id: string | null
  source: CardPhotoSource
  credit?: string | null
  ref?: string | null
}

export interface PostCard {
  template: CardTemplateId
  fields: Record<string, string>
  photo?: CardPhoto | null
  seen?: string[]
  custom?: boolean
}

export const PHOTO_SOURCE_LABELS: Record<CardPhotoSource, string> = {
  library: 'Фотобанк компании', web: 'Фото из интернета', ai: 'Сгенерировано AI', upload: 'Загружено вручную', none: 'Фирменный фон',
}

const DANGLING = /\s+(?:в|во|на|под|над|для|и|или|а|но|с|со|о|об|к|ко|по|из|от|до|за|у|не|без|при|про|через|как|что|чтобы|the|of|for|and|to|in|on)$/i

function fit(v: string, max: number): string {
  if (v.length <= max) return v
  const cut = v.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  let out = space > max * 0.5 ? cut.slice(0, space) : v.slice(0, max)
  for (let prev = ''; prev !== out;) {
    prev = out
    out = out.replace(/[\s,.;:—–-]+$/, '')
    if (out.split(' ').length > 2) out = out.replace(DANGLING, '')
  }
  return out
}

export function cardPrompt(): string {
  return Object.values(CARD_TEMPLATES).map(t => `- ${t.id} («${t.name}»): ${t.when}. Поля: ${t.fields.map(x => `${x.key.replace(/\d$/, 'N')} ≤${x.max}`).filter((x, i, a) => a.indexOf(x) === i).join(', ')}`).join('\n')
}

export function normalizeCard(card: { template: CardTemplateId, fields: Record<string, unknown> }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of cardFields(card.template)) {
    const v = card.fields[field.key]
    const plain = typeof v === 'string' ? v.replace(/(\*\*|__|~~|==|\|\|)/g, '').replace(/^#{1,6}\s+/, '').replace(/`/g, '') : ''
    out[field.key] = plain ? fit(plain.replace(/\s+/g, ' ').trim(), field.max) : ''
  }
  return out
}
