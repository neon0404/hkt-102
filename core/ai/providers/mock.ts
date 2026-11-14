import { extractCardFields, guessTemplate } from '../../image/card-extract'
import type { ImageResult, LlmProvider, StructuredRequest, StructuredResult } from '../provider'

export class MockProvider implements LlmProvider {
  name = 'mock' as const

  async generateStructured(req: StructuredRequest): Promise<StructuredResult> {
    const data = this.fixture(req)
    return { data, provider: this.name, model: 'mock', inputTokens: Math.round(req.user.length / 3), outputTokens: 120, durationMs: 5 }
  }

  async generateImage(_prompt: string): Promise<ImageResult | null> {
    return null
  }

  private fixture(req: StructuredRequest): unknown {
    const user = req.user
    const firstAlias = user.match(/\[(c\d+)\]/)?.[1] ?? null
    const firstChunk = user.match(/\[c1\][^\n]*\n([^\n]{20,200})/)?.[1]?.trim() ?? ''
    const topic = user.match(/Тема: ([^\n]+)/)?.[1]?.trim() ?? 'Новости компании'
    const message = user.match(/<сообщение_пользователя>\n([\s\S]*?)\n<\/сообщение_пользователя>/)?.[1]?.trim() ?? ''

    switch (req.operation) {
      case 'build_brand_profile':
        return {
          description: firstChunk || 'Описание формируется по материалам компании.',
          products: [], audiences: [], advantages: [], tone: 'дружелюбный, без канцелярита',
          rubrics: ['Новости компании', 'Продукты', 'Люди', 'Полезное'],
          forbidden: [], required_phrases: [],
          facts: firstAlias && firstChunk ? [{ claim: firstChunk.slice(0, 160), chunk_id: firstAlias }] : [],
          strategy: 'Регулярные публикации 3 раза в неделю с чередованием рубрик.',
        }
      case 'route_message': {
        const m = message.toLowerCase()
        const intent = /одобряю|публикуй|выкладывай/.test(m)
          ? 'approve'
          : /отклоняю|не публикуем|в мусор/.test(m)
            ? 'reject'
            : /короче|длиннее|измени|перепиши|другую картинк|добавь|убери/.test(m)
          ? 'revise_post'
          : /перенес/.test(m)
            ? 'reschedule_post'
            : /статус|что с/.test(m)
              ? 'status'
              : /план/.test(m)
                ? 'create_plan'
                : /отч[её]т/.test(m)
                  ? 'report'
                  : /сценари|ролик|видео/.test(m)
                    ? 'video_script'
                    : /пост|публикац|напиши|подготовь/.test(m) ? 'create_post' : /\?/.test(m) ? 'ask_question' : 'unknown'
        return {
          intent,
          params: { topic: intent === 'create_post' ? message.slice(0, 120) : null, instructions: intent === 'revise_post' ? message : null, schedule_at: null, publish_now: false },
          reply: intent === 'ask_question'
            ? (firstChunk ? `По материалам компании: ${firstChunk}` : 'В материалах компании таких сведений нет.')
            : intent === 'unknown' ? 'Уточните, пожалуйста, что нужно сделать: подготовить пост, план или отчёт?' : 'Принял, готовлю.',
          used_chunk_ids: intent === 'ask_question' && firstAlias ? [firstAlias] : [],
        }
      }
      case 'generate_post':
      case 'revise_post': {
        const shorter = /короче/i.test(user)
        const base = firstChunk ? `${topic}. ${firstChunk}` : `${topic}. Подробности — в следующих публикациях.`
        const template = guessTemplate(`${topic}
${base}`)
        const f = extractCardFields(template, `${topic}
${base}`, { title: topic.slice(0, 58) })
        const card = {
          template, tag: f.tag ?? '', title: f.title ?? '', question: f.question ?? '', value: f.value ?? '', period: f.period ?? '',
          detail: f.detail ?? '', answer: f.answer ?? '', photo_query: topic.slice(0, 60),
          items: [0, 1, 2].map(i => ({ key: f[`key${i}`] ?? '', text: f[`item${i}`] ?? '' })).filter(x => x.text || x.key),
        }
        return {
          card,
          title: topic.slice(0, 58),
          text: shorter ? base.slice(0, 160) : base,
          hashtags: ['#новости', '#компания'],
          image_prompt: 'abstract clean background',
          facts: firstAlias && firstChunk ? [{ claim: firstChunk.slice(0, 160), chunk_id: firstAlias }] : [],
          warnings: firstAlias ? [] : ['В материалах компании нет сведений по теме — проверьте текст'],
        }
      }
      case 'pick_topic':
        return { topic: `Тема из рубрики: ${user.match(/Рубрика: ([^\n]+)/)?.[1] ?? 'Новости компании'}`, rubric: user.match(/Рубрика: ([^\n]+)/)?.[1] ?? 'Новости компании', reason: 'Давно не выходило' }
      case 'create_plan': {
        const today = new Date()
        const items = [1, 3, 5].map((d, i) => {
          const dt = new Date(today.getTime() + d * 86400000)
          return { date: dt.toISOString().slice(0, 10), time: '10:00', rubric: ['Новости компании', 'Продукты', 'Люди'][i]!, topic: `Тема ${i + 1} по материалам компании`, reason: 'Поддержать регулярность' }
        })
        return { items, comment: 'План из трёх публикаций с чередованием рубрик.' }
      }
      case 'generate_report':
        return { summary: 'Отчёт сформирован по показателям периода.', findings: ['Показатели приведены в блоке данных'], hypotheses: ['Проверить другое время публикации'], actions: ['Сохранить регулярность'] }
      case 'video_script':
        return {
          title: topic, duration_sec: 30, hook: 'Знаете ли вы…',
          scenes: [
            { time: '0–3 с', visual: 'Крупный план', voiceover: 'Знаете ли вы…', on_screen: 'Знаете ли вы?', speech: 'знаете ли вы', photo_query: 'glass facade' },
            { time: '3–12 с', visual: 'Основная часть', voiceover: (firstChunk || topic).slice(0, 160), on_screen: topic.slice(0, 40), speech: '', photo_query: 'glass factory' },
          ],
          shots_needed: ['Общий план', 'Крупные детали'], caption: topic, notes: 'Съёмка требует согласования.',
        }
      case 'analyze_competitor':
        return { summary: 'Анализ по собранным материалам.', content_themes: [], strengths: [], gaps: [], ideas_for_us: ['Рассказывать о своих преимуществах конкретнее'] }
      case 'comment_reply':
        return { sentiment: 'neutral', needs_reply: true, reply: 'Спасибо за комментарий! Передали вопрос коллегам.' }
      default:
        return {}
    }
  }
}
