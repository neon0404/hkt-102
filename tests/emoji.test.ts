import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emojiEntities, emojiHtml, emojiMarkdown, keepPackEmoji, packName } from '../core/telegram/emoji-pack'

const pack = new Map([['🔥', '111'], ['✔', '222'], ['🏢', '333']])

test('packName: ссылка t.me/addemoji и имя набора', () => {
  assert.equal(packName('https://t.me/addemoji/nowemoji'), 'nowemoji')
  assert.equal(packName('nowemoji'), 'nowemoji')
  assert.equal(packName('не набор'), null)
  assert.equal(packName(''), null)
})

test('keepPackEmoji: в тексте остаются только эмодзи из набора', () => {
  assert.equal(keepPackEmoji('### 🔬 Как устроено', pack), '### Как устроено')
  assert.equal(keepPackEmoji('### 🏢 Фасады', pack), '### 🏢 Фасады')
  assert.equal(keepPackEmoji('Горячо 🔥 и 😀 точно ✔️', pack), 'Горячо 🔥 и точно ✔️')
  assert.equal(keepPackEmoji('😀 Привет', pack), 'Привет')
  assert.equal(keepPackEmoji('Clearview™ © 2026 → 4 мм', pack), 'Clearview™ © 2026 → 4 мм')
})

test('emojiEntities: смещения в UTF-16, только эмодзи набора', () => {
  const text = 'Ок 🔥 и ✔️ и 😀'
  const ents = emojiEntities(text, pack)
  assert.deepEqual(ents.map(e => [text.slice(e.offset, e.offset + e.length), (e as any).custom_emoji_id]), [['🔥', '111'], ['✔️', '222']])
})

test('emojiHtml и emojiMarkdown: значки набора, теги не трогаются', () => {
  assert.equal(emojiHtml('<b>🔥 жарко</b> 😀', pack), '<b><tg-emoji emoji-id="111">🔥</tg-emoji> жарко</b> 😀')
  assert.equal(emojiMarkdown('### 🏢 Фасады', pack), '### ![](tg://emoji?id=333) Фасады')
})
