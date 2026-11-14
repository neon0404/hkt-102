import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractCardFields, guessTemplate } from '../core/image/card-extract'
import { renderCard } from '../core/image/card-render'
import { CARD_TEMPLATE_IDS, CARD_TEMPLATES, normalizeCard } from '../core/image/card-templates'

const NEWS: Record<string, string> = {
  product: 'Clearview X2\nСветопропускание антибликового стекла Clearview X2 толщиной 4 мм составляет 97%.',
  guide: 'Где помогает антиблик?\nКогда отражения мешают увидеть объект за стеклом.\nПодходит для торговых витрин, музейных экспозиций и смотровых площадок.',
  people: 'Расти в профессии\nДля сотрудников доступны программы обучения и повышения квалификации.\nТезисы: обучение, квалификация.',
  project: 'Клубный дом «Соты»\nДля остекления клубного дома в Уфе использовали стекло T1 Grey.',
  event: 'Форум «Казаныш»\nС 6 по 8 февраля 2025 года компания участвовала в архитектурном форуме в Казани.',
  ecology: 'Стеклу — вторую жизнь\nЗвенья переработки: стекло — вторсырьё; завод — производство; ресурсы — экономия.',
  plant: 'Стекло Over Size\nИюль 2022 — первый выпуск.\nАпрель 2024 — первая отгрузка.\nЛето 2024 — обновление линий покрытий.',
  service: 'Как заказать образцы\nСначала выберите образцы, затем сверьте заказ и оставьте контакты.',
  quiz: 'Сколько света пропускает стекло?\nРубрика: Квиз\nПодсказка: Clearview X2 · 4 мм\nОтвет: 97%',
}

test('макет угадывается по тексту новости', () => {
  for (const id of CARD_TEMPLATE_IDS) assert.equal(guessTemplate(NEWS[id]!), id, id)
})

test('поля макета заполняются из текста', () => {
  const event = extractCardFields('event', NEWS.event!)
  assert.deepEqual([event.value, event.period, event.title, event.detail], ['6–8', 'февраля 2025', 'Форум «Казаныш»', 'Казань'])
  const product = extractCardFields('product', NEWS.product!)
  assert.equal(product.value, '97%')
  const plant = extractCardFields('plant', NEWS.plant!)
  assert.deepEqual([plant.key0, plant.item1], ['Июль 2022', 'первая отгрузка'])
  for (const id of CARD_TEMPLATE_IDS) {
    const fields = extractCardFields(id, NEWS[id]!)
    const missing = CARD_TEMPLATES[id].fields.filter(f => !f.optional && !fields[f.key])
    assert.equal(missing.length, 0, `${id}: пусто ${missing.map(f => f.key)}`)
  }
})

test('длинные значения режутся по границе слова', () => {
  const f = normalizeCard({ template: 'project', fields: { title: 'Очень длинный заголовок, который точно не поместится в макет' } })
  assert.ok(f.title!.length <= 28)
  assert.ok(!/[\s,]$/.test(f.title!))
})

test('каждый макет отрисовывается 1080×1080 без переполнения', async () => {
  for (const id of CARD_TEMPLATE_IDS) {
    const res = await renderCard({ tenantId: 'test', tenantName: 'Компания', brand: { primary: '#2f6fb0' }, template: id, fields: extractCardFields(id, NEWS[id]!) })
    assert.equal(res.png.readUInt32BE(16), 1080, id)
    assert.deepEqual(res.overflow, [], `${id}: не поместилось ${res.overflow}`)
    assert.deepEqual(res.missing, [], id)
  }
})

test('Карточка из журнального текста: без значков разметки и без склейки заголовка с вопросом', async () => {
  const { extractCardFields } = await import('../core/image/card-extract')
  const md = 'Из чего состоит стеклопакет\n### 🔍 Стёкла и пространство\nЧто находится между вами и улицей?\n- **Стекло:** обычное, энергосберегающее\n- **Заполнение:** воздух или аргон\n- ==Безопасность== важна'
  const f = extractCardFields('guide', md, { title: 'Из чего состоит стеклопакет' })
  for (const v of Object.values(f)) assert.doesNotMatch(v, /\*\*|==|###/)
  assert.equal(f.question, 'Что находится между вами и улицей?')
  assert.deepEqual([f.item0, f.item1], ['Стекло', 'Заполнение'])
})
