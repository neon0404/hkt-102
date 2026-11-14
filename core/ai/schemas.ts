import { z } from 'zod'
import { CARD_TEMPLATE_IDS } from '../image/card-templates'

export const factSchema = z.object({
  claim: z.string().describe('Утверждение одной фразой'),
  chunk_id: z.string().nullable().describe('ID фрагмента базы знаний, который подтверждает утверждение; "general" — общеизвестный факт не о компании; null, если подтверждения нет'),
})

export const brandProfileSchema = z.object({
  description: z.string().describe('2–4 предложения о компании только по материалам'),
  products: z.array(z.string()).describe('Продукты и услуги'),
  audiences: z.array(z.string()).describe('Целевые аудитории'),
  advantages: z.array(z.string()).describe('Преимущества, названные в материалах'),
  tone: z.string().describe('Тон коммуникации'),
  rubrics: z.array(z.string()).describe('5–8 рубрик для регулярных публикаций'),
  forbidden: z.array(z.string()).describe('Чего нельзя утверждать или упоминать'),
  required_phrases: z.array(z.string()).describe('Обязательные формулировки, если они есть в материалах'),
  facts: z.array(factSchema).describe('10–25 проверяемых фактов с указанием фрагмента'),
  strategy: z.string().describe('Краткая маркетинговая стратегия: цели, акценты, частота публикаций'),
})
export type BrandProfileOut = z.infer<typeof brandProfileSchema>

export const INTENTS = [
  'create_post', 'revise_post', 'reschedule_post', 'ask_question', 'status',
  'create_plan', 'report', 'video_script', 'competitors', 'approve', 'reject', 'unknown',
] as const
export type Intent = typeof INTENTS[number]

export const routeSchema = z.object({
  intent: z.enum(INTENTS),
  params: z.object({
    topic: z.string().nullable().describe('Тема поста, плана или сценария'),
    instructions: z.string().nullable().describe('Что изменить в существующем посте либо пожелания к новому'),
    schedule_at: z.string().nullable().describe('Локальное время публикации компании в формате YYYY-MM-DDTHH:mm либо null'),
    publish_now: z.boolean().describe('true, если пользователь просит опубликовать сразу после согласования'),
  }),
  reply: z.string().describe('Короткий ответ пользователю. Для ask_question — полный ответ по материалам компании'),
  used_chunk_ids: z.array(z.string()).describe('ID фрагментов, на которые опирается ответ'),
})
export type RouteOut = z.infer<typeof routeSchema>

export const cardSchema = z.object({
  template: z.enum(CARD_TEMPLATE_IDS).describe('Макет карточки, подходящий к содержанию'),
  tag: z.string().describe('Рубрика на карточке: 1–2 слова'),
  title: z.string().describe('Заголовок на карточке; пусто, если в макете вместо него вопрос'),
  question: z.string().describe('Вопрос (макеты guide, quiz); иначе пусто'),
  value: z.string().describe('Крупная цифра или дата (product: «97%», event: «6–8»); иначе пусто'),
  period: z.string().describe('Только event: месяц и год, например «февраля 2025»; иначе пусто'),
  detail: z.string().describe('Подпись: к цифре, короткий ответ, подпись к фото, место события или подсказка'),
  answer: z.string().describe('Только quiz: ответ; иначе пусто'),
  items: z.array(z.object({
    key: z.string().describe('Только ecology и plant: звено или дата; иначе пусто'),
    text: z.string().describe('Тезис, шаг, пояснение или событие'),
  })).describe('До трёх пунктов (people — два)'),
  photo_query: z.string().describe('Запрос для поиска фото на английском, 2–4 слова, предметно'),
})
export type CardOut = z.infer<typeof cardSchema>

export const postDraftSchema = z.object({
  title: z.string().describe('Заголовок для изображения, до 60 знаков, без точки в конце'),
  text: z.string().describe('Готовый текст поста'),
  hashtags: z.array(z.string()).describe('2–4 хештега с символом #'),
  image_prompt: z.string().describe('Описание фонового изображения на английском: без текста, без людей'),
  card: cardSchema.describe('Карточка-изображение к посту: текст на ней берётся из текста поста'),
  facts: z.array(factSchema).describe('Каждое фактическое утверждение из текста и подтверждающий его фрагмент'),
  warnings: z.array(z.string()).describe('Что не удалось подтвердить материалами'),
})
export type PostDraftOut = z.infer<typeof postDraftSchema>

export const topicSchema = z.object({
  topic: z.string(),
  rubric: z.string(),
  reason: z.string().describe('Почему эта тема уместна сейчас'),
})
export type TopicOut = z.infer<typeof topicSchema>

export const planSchema = z.object({
  items: z.array(z.object({
    date: z.string().describe('YYYY-MM-DD'),
    time: z.string().describe('HH:mm'),
    rubric: z.string(),
    topic: z.string(),
    reason: z.string().describe('Маркетинговая цель публикации одной фразой'),
  })),
  comment: z.string().describe('Короткое пояснение логики плана'),
})
export type PlanOut = z.infer<typeof planSchema>

export const reportSchema = z.object({
  summary: z.string().describe('Итог периода в 2–3 предложениях с конкретными числами'),
  findings: z.array(z.string()).describe('Выводы, каждый опирается на показатель'),
  hypotheses: z.array(z.string()).describe('Гипотезы по улучшению'),
  actions: z.array(z.string()).describe('Рекомендуемые действия на следующую неделю'),
})
export type ReportOut = z.infer<typeof reportSchema>

export const videoScriptSchema = z.object({
  title: z.string(),
  duration_sec: z.number(),
  hook: z.string().describe('Первые 3 секунды'),
  scenes: z.array(z.object({
    time: z.string().describe('Например 0–3 с'),
    visual: z.string(),
    voiceover: z.string(),
    on_screen: z.string().describe('Крупный текст в кадре, до 40 знаков: суть сцены'),
    speech: z.string().describe('Тот же текст диктора для синтеза речи: только русские буквы, числа и проценты словами, латинские названия русскими буквами (Ultraview → Ультравью)'),
    photo_query: z.string().describe('2–4 английских слова для поиска фото к сцене'),
  })),
  shots_needed: z.array(z.string()).describe('Какие кадры нужно снять или запросить'),
  caption: z.string().describe('Подпись к ролику'),
  notes: z.string().describe('Что требует согласования или разрешений'),
})
export type VideoScriptOut = z.infer<typeof videoScriptSchema>

export const competitorSchema = z.object({
  summary: z.string(),
  content_themes: z.array(z.string()),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()).describe('Чего у конкурента нет, а у нас есть по материалам'),
  ideas_for_us: z.array(z.string()),
})
export type CompetitorOut = z.infer<typeof competitorSchema>

export const commentReplySchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative', 'question', 'spam']),
  needs_reply: z.boolean(),
  reply: z.string().describe('Черновик ответа от имени компании; пустая строка, если ответ не нужен'),
})
export type CommentReplyOut = z.infer<typeof commentReplySchema>

export const toJsonSchema = (schema: z.ZodType) => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}
