import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mdCell, mdDetails, mdEntities, mdEsc, mdPlain, mdTable, mdToHtml } from '../core/telegram/rich'

test('mdEsc: текст людей не превращается в разметку', () => {
  assert.equal(mdEsc('**жирно** | 50% #1 <b>'), '\\*\\*жирно\\*\\* \\| 50% \\#1 \\<b\\>')
  assert.equal(mdCell('строка\nвторая | третья'), 'строка вторая \\| третья')
  assert.equal(mdCell('  '), '—')
})

test('mdTable: заголовок, выравнивание, строки', () => {
  const t = mdTable(['А', 'Б'], [['1', '2']], ['l', 'r'])
  assert.equal(t, '| А | Б |\n| :--- | ---: |\n| 1 | 2 |')
})

test('mdPlain: простой текст для истории диалога', () => {
  const md = `## 📋 Заголовок\n\n${mdTable(['Материал', 'Статус'], [['**Пост**', 'Опубликован']])}\n\n- [ ] сделать\n> цитата\n${mdDetails('Почему', '- *курсив*')}`
  const plain = mdPlain(md)
  assert.match(plain, /^📋 Заголовок/)
  assert.match(plain, /Материал · Статус/)
  assert.match(plain, /Пост · Опубликован/)
  assert.match(plain, /• сделать/)
  assert.match(plain, /• курсив/)
  assert.doesNotMatch(plain, /[|*#<>]|---/)
})

test('mdToHtml: запасной вариант понятен в обычном Telegram', () => {
  const html = mdToHtml(`# Отчёт\n| Показатель | Значение |\n| :--- | ---: |\n| Просмотры | **840** |\n> вывод <важно>\n- [x] готово\n- пункт с \`кодом\` и [ссылкой](https://t.me/x)\n${mdDetails('Идеи', '- раз')}`)
  assert.match(html, /^<b>Отчёт<\/b>/)
  assert.match(html, /Показатель · Значение/)
  assert.match(html, /Просмотры · <b>840<\/b>/)
  assert.match(html, /<blockquote>вывод &lt;важно&gt;<\/blockquote>/)
  assert.match(html, /✅ готово/)
  assert.match(html, /• пункт с <code>кодом<\/code> и <a href="https:\/\/t.me\/x">ссылкой<\/a>/)
  assert.match(html, /<b>Идеи<\/b>/)
  assert.doesNotMatch(html, /---|details|summary/)
})

test('mdToHtml: экранированные символы остаются символами', () => {
  assert.equal(mdToHtml(mdEsc('50% * 2 = <100>')), '50% * 2 = &lt;100&gt;')
})

test('mdEntities: обычный пост без значков разметки, выделение — сущностями', () => {
  const r = mdEntities('### 🔬 Заголовок\nСтекло — **основа**, ==важно==.\n\n- пункт\n\n> цитата\n\n[сайт](https://example.com) и file_name')
  assert.equal(r.text, '🔬 Заголовок\nСтекло — основа, важно.\n\n• пункт\n\nцитата\n\nсайт и file_name')
  const got = r.entities.map(e => [e.type, r.text.slice(e.offset, e.offset + e.length), e.url ?? ''])
  assert.deepEqual(got, [
    ['bold', '🔬 Заголовок', ''], ['bold', 'основа', ''], ['bold', 'важно', ''], ['blockquote', 'цитата', ''], ['text_link', 'сайт', 'https://example.com'],
  ])
  assert.doesNotMatch(r.text, /[#*=>]/)
})
