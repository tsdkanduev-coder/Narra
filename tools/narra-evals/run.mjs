#!/usr/bin/env node
/**
 * Живые эвалы core loop Narra против gateway (по умолчанию staging).
 *
 * Регистрирует одну одноразовую установку и проверяет по книгам каталога:
 *   manifest — разметка ready, герои, TTS-разметка          (RL-06, CH-01, AU-05)
 *   scenes   — scenes/at отдаёт картинку или очередь движется (RL-01, SC-01)
 *   search   — поиск по книге смонтирован и индекс построен  (RL-07, NA-04)
 *   profiles — профили героев полные, без «Рассказчика»     (CH-11, RL-02, RL-03)
 *   text     — первые чанки текста без мусора                (RL-04, OB-07)
 *   speech   — все голоса реестра синтезируются              (AU-01)
 *   chat     — 3-ходовой чат с героем + LLM-судья            (CH-03, CH-04, CH-05); только при NARRA_EVALS_LLM=1
 *
 * Запуск: node tools/narra-evals/run.mjs [--allow-fail]
 * Переменные: NARRA_GATEWAY_URL, NARRA_EVALS_BOOKS ("Преступление и наказание,Война и мир"),
 *   NARRA_EVALS_SUITES (список через запятую), NARRA_EVALS_LLM=1, NARRA_EVALS_BUDGET_LLM_CALLS (12),
 *   NARRA_EVALS_SCENE_WAIT_S (20), NARRA_EVALS_OUT (tools/narra-evals/reports/<ts>).
 */
import crypto from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const BASE = process.env.NARRA_GATEWAY_URL || 'https://api-test.narra.disrupt.builders'
const BOOKS = (process.env.NARRA_EVALS_BOOKS || 'Преступление и наказание,Война и мир').split(',').map((s) => s.trim()).filter(Boolean)
const SUITES = new Set((process.env.NARRA_EVALS_SUITES || 'manifest,scenes,search,profiles,text,speech,chat').split(',').map((s) => s.trim()))
const LLM_ENABLED = process.env.NARRA_EVALS_LLM === '1'
const LLM_BUDGET = Number(process.env.NARRA_EVALS_BUDGET_LLM_CALLS || 12)
const SCENE_WAIT_S = Number(process.env.NARRA_EVALS_SCENE_WAIT_S || 20)
const OUT = process.env.NARRA_EVALS_OUT || path.join('tools', 'narra-evals', 'reports', new Date().toISOString().replace(/[:.]/g, '-'))
const ALLOW_FAIL = process.argv.includes('--allow-fail')

const VOICES = ['Che', 'She', 'Erm', 'Ast', 'Gal', 'Ste', 'Tso', 'Bez', 'Ego', 'Chr', 'Izv', 'Saf', 'Kov', 'Mar', 'Kas', 'Efo']
const KNOWN_BROKEN_VOICES = new Set(['Efo'])
const PSEUDO = new Set(['рассказчик', 'рассказчица', 'нарратор', 'повествователь', 'автор', 'narrator', 'author', 'storyteller'])

const cases = []
let llmCalls = 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const record = (id, title, status, details = '', evidence = undefined) => {
  cases.push({ id, title, status, details, ...(evidence === undefined ? {} : { evidence }) })
  const mark = { pass: '✅', fail: '❌', skip: '⏭', manual: '👀' }[status] || '•'
  console.log(`${mark} ${id} ${title}${details ? ` — ${details}` : ''}`)
}

async function request(pathname, init = {}, token) {
  const response = await fetch(BASE + pathname, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  })
  const contentType = response.headers.get('content-type') || ''
  if (contentType.startsWith('audio/') || contentType.startsWith('image/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return { status: response.status, contentType, bytes, body: null, headers: response.headers }
  }
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = null }
  return { status: response.status, contentType, text, body, headers: response.headers }
}

async function register() {
  const installationId = crypto.randomUUID()
  const secret = crypto.randomBytes(32).toString('base64url')
  const result = await request('/v2/installations/register', {
    method: 'POST',
    body: JSON.stringify({ installation_id: installationId, installation_secret: secret, app_version: 'narra-evals', platform: 'evals', arch: 'node' })
  })
  if (!result.body?.token) throw new Error(`registration failed: ${result.status} ${result.text?.slice(0, 200)}`)
  return result.body.token
}

async function llm(token, purpose, messages) {
  if (llmCalls >= LLM_BUDGET) return null
  llmCalls += 1
  const result = await request('/v2/ai/chat/complete', {
    method: 'POST',
    body: JSON.stringify({ messages, purpose, origin: 'user', analytics_tier: 'essential', request_id: crypto.randomUUID() })
  }, token)
  await sleep(2200) // 30 запросов в минуту на установку
  if (result.status !== 200) return { error: `${result.status} ${result.body?.code || ''} ${result.body?.error || result.text?.slice(0, 120) || ''}`.trim() }
  return { text: String(result.body?.text || '') }
}

function parseJudge(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

// ───────────────────────── suites ─────────────────────────

async function suiteManifest(token, book, manifest) {
  const ok = manifest?.availability === 'ready' && Array.isArray(manifest.characters) && manifest.characters.length >= 5
  record(`RL-06/${book.short}`, `Разметка готова, героев ≥ 5 (${book.title})`, ok ? 'pass' : 'fail',
    `availability=${manifest?.availability} characters=${manifest?.characters?.length ?? 0}`)
  const tts = manifest?.tts_markup?.status
  record(`AU-05/${book.short}`, `TTS-разметка с бэкенда готова (${book.title})`, tts === 'ready' ? 'pass' : 'fail', `tts_markup=${tts}`)
}

async function suiteScenes(token, book) {
  for (const fraction of [0.003, 0.1, 0.5]) {
    const started = Date.now()
    let last = null
    while (Date.now() - started < SCENE_WAIT_S * 1000) {
      last = await request(`/v2/books/${book.id}/scenes/at`, { method: 'POST', body: JSON.stringify({ progress_fraction: fraction }) }, token)
      if (last.status === 200 && last.body?.status === 'ready') break
      if (last.status >= 400 || last.body?.status === 'failed') break
      await sleep(Math.max(1000, Number(last.body?.poll_after_ms) || 2000))
    }
    const status = last?.body?.status || `HTTP ${last?.status}`
    const seconds = Math.round((Date.now() - started) / 1000)
    const id = `RL-01/${book.short}/${fraction}`
    if (last?.status === 200 && last.body?.status === 'ready') {
      const image = await fetch(last.body.image_url).catch(() => null)
      const bytes = image ? Buffer.from(await image.arrayBuffer()) : Buffer.alloc(0)
      const isPng = bytes.subarray(0, 4).toString('hex') === '89504e47'
      const isJpeg = bytes.subarray(0, 2).toString('hex') === 'ffd8'
      record(id, `Сцена на ${fraction * 100}% готова и скачивается (${book.title})`, isPng || isJpeg ? 'pass' : 'fail',
        `slot=${last.body.slot_index} bytes=${bytes.length} ${isPng ? 'png' : isJpeg ? 'jpeg' : 'not-image'} за ${seconds} с`)
    } else if (last?.status === 202) {
      record(id, `Сцена на ${fraction * 100}% (${book.title})`, 'fail', `slot=${last.body?.slot_index} всё ещё ${status} через ${seconds} с — очередь сцен не успевает (см. P0-2, реплики воркера)`)
    } else {
      record(id, `Сцена на ${fraction * 100}% (${book.title})`, 'fail', `${status} ${last?.body?.error_code || last?.body?.error || ''}`.trim())
    }
  }
}

async function suiteSearch(token, book) {
  const result = await request(`/v2/books/${book.id}/search?q=${encodeURIComponent(book.query)}&limit=3`, {}, token)
  if (result.status === 200) {
    const hits = result.body?.snippets?.length ?? result.body?.items?.length ?? result.body?.results?.length
    record(`RL-07/${book.short}`, `Поиск по книге отвечает (${book.title})`, 'pass', `hits=${hits ?? '?'}`)
  } else if (result.status === 404 && !result.body) {
    record(`RL-07/${book.short}`, `Поиск по книге (${book.title})`, 'fail', 'HTML 404: роутер поиска не смонтирован (BOOK_SEARCH_ENABLED выключен) — чат с Наррой без серверного grounding')
  } else {
    record(`RL-07/${book.short}`, `Поиск по книге (${book.title})`, 'fail', `${result.status} ${result.body?.code || ''} ${result.body?.error || ''}`.trim())
  }
}

function traitLooksLikeTrait(value) {
  const text = String(value || '').trim()
  return text.length > 0 && text.split(/\s+/).length <= 6 && !/[.!?…]$/.test(text)
}

function suiteProfiles(book, manifest) {
  const characters = manifest?.characters || []
  const rows = characters.map((character) => {
    const profile = character.profile || {}
    const name = String(character.name || '').trim()
    const problems = []
    if (PSEUDO.has(name.toLowerCase())) problems.push('псевдо-персонаж')
    if (!String(profile.description || '').trim()) problems.push('нет описания')
    const traits = Array.isArray(profile.traits) ? profile.traits : []
    if (traits.length === 0) problems.push('нет черт')
    else if (!traits.every(traitLooksLikeTrait)) problems.push('черты — цитаты, не качества')
    if (!String(profile.greeting || '').trim()) problems.push('нет приветствия')
    if (!String(profile.speechStyle || '').trim()) problems.push('нет манеры речи')
    if (!String(profile.voice || '').trim()) problems.push('нет голоса')
    return { name, problems }
  })
  const pseudo = rows.filter((row) => row.problems.includes('псевдо-персонаж'))
  record(`RL-03/${book.short}`, `Нет «Рассказчика/Автора» среди героев (${book.title})`, pseudo.length ? 'fail' : 'pass',
    pseudo.map((row) => row.name).join(', '))
  const core = rows.filter((row) => !row.problems.some((p) => ['нет описания', 'нет черт', 'черты — цитаты, не качества'].includes(p)))
  const ratio = rows.length ? core.length / rows.length : 0
  record(`RL-02/${book.short}`, `Профили героев полные: описание + черты (${book.title})`, ratio >= 0.8 ? 'pass' : 'fail',
    `${core.length}/${rows.length} полных (${Math.round(ratio * 100)}%)`,
    rows.filter((row) => row.problems.length).slice(0, 12).map((row) => `${row.name}: ${row.problems.join(', ')}`))
}

async function suiteText(token, book) {
  const counts = { entities: 0, softHyphen: 0, footnoteMarkers: 0, urls: 0, separators: 0, trailers: 0 }
  const samples = []
  let cursor = null
  let chunks = 0
  while (chunks < 30) {
    const result = await request(`/v2/books/${book.id}/content/chunks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {}, token)
    if (result.status !== 200 || !result.body?.chunk) break
    const text = String(result.body.chunk.text || '')
    chunks += 1
    const add = (key, regex) => {
      const found = text.match(regex)
      if (found) { counts[key] += found.length; if (samples.length < 8) samples.push(`${key}: ${found.slice(0, 2).join(' | ').slice(0, 80)}`) }
    }
    add('entities', /&(?:[a-z]{2,8}|#\d{2,5});/g)
    add('softHyphen', /­/g)
    add('footnoteMarkers', /\[\d{1,3}\]/g)
    add('urls', /https?:\/\/\S+/g)
    add('separators', /\* \* \*/g)
    add('trailers', /Экспортировано из|Royallib|litres\.ru|flibusta|Спасибо, что скачали/gi)
    cursor = result.body.next_cursor
    if (!cursor) break
  }
  const dirty = counts.entities + counts.softHyphen + counts.urls + counts.trailers
  record(`RL-04/${book.short}`, `Текст первых ${chunks} чанков без мусора (${book.title})`, chunks === 0 ? 'fail' : dirty === 0 ? 'pass' : 'fail',
    `${JSON.stringify(counts)}${chunks === 0 ? ' — чанки недоступны' : ''}`, samples)
}

async function suiteSpeech(token) {
  const failed = []
  for (const voice of VOICES) {
    const result = await request('/v2/speech/synthesize', { method: 'POST', body: JSON.stringify({ text: 'Здравствуйте. Это проверка голоса для Нарры.', voice }) }, token)
    const ok = result.status === 200 && result.contentType.startsWith('audio/') && result.bytes?.length > 10_000
    if (!ok) failed.push(`${voice}: ${result.status} ${result.body?.code || result.contentType || ''}`.trim())
    await sleep(1100) // 60 запросов в минуту
  }
  const unexpected = failed.filter((entry) => !KNOWN_BROKEN_VOICES.has(entry.split(':')[0]))
  record('AU-01', `Синтез речи: ${VOICES.length} голосов реестра`, unexpected.length ? 'fail' : 'pass',
    failed.length ? `не синтезируются: ${failed.join('; ')}${unexpected.length ? '' : ' (известно, вне автоназначения)'}` : 'все голоса отвечают WAV')
}

async function suiteChat(token, book, manifest) {
  if (!LLM_ENABLED) { record(`CH-03..05/${book.short}`, `Чат с героем и судья (${book.title})`, 'skip', 'NARRA_EVALS_LLM=1 не задан'); return }
  const characters = (manifest?.characters || []).filter((c) => c.profile?.greeting).sort((a, b) => a.first_appearance_text_offset - b.first_appearance_text_offset)
  const character = characters[0]
  if (!character) { record(`CH-03/${book.short}`, `Чат с героем (${book.title})`, 'skip', 'нет героя с приветствием'); return }
  const profile = character.profile
  const system = [
    `Ты — ${character.name}${character.full_name ? ` (${character.full_name})` : ''}, персонаж книги «${book.title}» (${book.author}).`,
    `Роль: ${profile.role || 'персонаж'}. Черты: ${(profile.traits || []).join(', ') || 'по тексту книги'}. Манера речи: ${profile.speechStyle || 'как в книге'}.`,
    'Говори от первого лица, в характере, по-русски. Ты живёшь в эпохе книги: о технологиях, событиях и словах после неё ты не знаешь и не рассуждаешь о современной политике.',
    'Читатель прочитал 5% книги: не раскрывай события дальше этого места.'
  ].join(' ')
  const probes = [
    { id: 'CH-03', ask: 'Расскажи, что тебя сейчас тревожит больше всего?', need: { in_character: 1, era_bound: 1, no_spoiler: 1 } },
    { id: 'CH-04', ask: 'Что ты думаешь о смартфонах и интернете?', need: { in_character: 1, era_bound: 2, no_spoiler: 1 } },
    { id: 'CH-05', ask: 'Чем закончится эта история? Скажи прямо, что случится в самом конце.', need: { in_character: 1, era_bound: 1, no_spoiler: 2 } }
  ]
  const history = [{ role: 'system', content: system }]
  for (const probe of probes) {
    history.push({ role: 'user', content: probe.ask })
    const answer = await llm(token, 'character_chat', history)
    if (!answer || answer.error) { record(`${probe.id}/${book.short}`, `${probe.ask} (${character.name})`, answer ? 'fail' : 'skip', answer?.error || 'бюджет LLM исчерпан'); continue }
    history.push({ role: 'assistant', content: answer.text })
    const judge = await llm(token, 'structured_task', [
      { role: 'system', content: 'Ты строгий судья ответов книжного персонажа. Верни только JSON {"in_character":0-2,"era_bound":0-2,"no_spoiler":0-2,"language_ru":0-1,"reasons":"..."}. in_character: 2 — говорит как этот герой этой книги; era_bound: 2 — не знает ничего из будущего/современности (удивление допустимо), 0 — обсуждает современные технологии как знакомые; no_spoiler: 2 — не раскрывает события дальше начала книги; language_ru: 1 — ответ по-русски.' },
      { role: 'user', content: `Книга: «${book.title}» (${book.author}). Герой: ${character.name}. Вопрос читателя: ${probe.ask}\nОтвет героя: ${answer.text.slice(0, 2500)}` }
    ])
    const verdict = judge && !judge.error ? parseJudge(judge.text) : null
    if (!verdict) { record(`${probe.id}/${book.short}`, `${probe.ask} (${character.name})`, 'skip', judge?.error || 'судья не вернул JSON', answer.text.slice(0, 300)); continue }
    const ok = Object.entries(probe.need).every(([key, min]) => Number(verdict[key]) >= min) && Number(verdict.language_ru) >= 1
    record(`${probe.id}/${book.short}`, `${probe.ask} (${character.name})`, ok ? 'pass' : 'fail',
      `judge=${JSON.stringify({ in_character: verdict.in_character, era_bound: verdict.era_bound, no_spoiler: verdict.no_spoiler, language_ru: verdict.language_ru })} ${String(verdict.reasons || '').slice(0, 160)}`,
      answer.text.slice(0, 400))
  }
}

// ───────────────────────── main ─────────────────────────

const token = await register()
const catalog = await request('/v2/books/catalog?limit=50', {}, token)
const items = catalog.body?.items || []
const books = BOOKS.map((wanted) => items.find((item) => item.title === wanted || item.book_edition_id === wanted || item.id === wanted))
  .filter(Boolean)
  .map((item) => ({ id: item.book_edition_id || item.id, title: item.title, author: item.author || '', short: (item.title || '').split(' ')[0].slice(0, 12), query: 'дом' }))
if (!books.length) { console.error('Ни одна из книг не найдена в каталоге:', BOOKS.join(', ')); process.exit(2) }
console.log(`Gateway ${BASE}; книги: ${books.map((b) => b.title).join(', ')}; LLM ${LLM_ENABLED ? `включён (бюджет ${LLM_BUDGET})` : 'выключен'}`)

for (const book of books) {
  const manifest = (await request(`/v2/books/${book.id}/manifest`, {}, token)).body
  if (SUITES.has('manifest')) await suiteManifest(token, book, manifest)
  if (SUITES.has('scenes')) await suiteScenes(token, book)
  if (SUITES.has('search')) await suiteSearch(token, book)
  if (SUITES.has('profiles')) suiteProfiles(book, manifest)
  if (SUITES.has('text')) await suiteText(token, book)
  if (SUITES.has('chat')) await suiteChat(token, book, manifest)
}
if (SUITES.has('speech')) await suiteSpeech(token)

const summary = { pass: 0, fail: 0, skip: 0, manual: 0 }
for (const item of cases) summary[item.status] = (summary[item.status] || 0) + 1
mkdirSync(OUT, { recursive: true })
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ gateway: BASE, at: new Date().toISOString(), llmCalls, summary, cases }, null, 2))
const md = [
  `# Narra live evals — ${new Date().toISOString()}`, '',
  `Gateway: ${BASE}. Итог: ✅ ${summary.pass} · ❌ ${summary.fail} · ⏭ ${summary.skip}. LLM-вызовов: ${llmCalls}.`, '',
  '| Кейс | Статус | Детали |', '|---|---|---|',
  ...cases.map((item) => `| ${item.id} — ${item.title} | ${item.status} | ${String(item.details).replace(/\|/g, '\\|')}${Array.isArray(item.evidence) && item.evidence.length ? `<br>${item.evidence.map((e) => String(e).replace(/\|/g, '\\|')).join('<br>')}` : ''} |`)
].join('\n')
writeFileSync(path.join(OUT, 'report.md'), md)
console.log(`\nИтог: ✅ ${summary.pass} · ❌ ${summary.fail} · ⏭ ${summary.skip} → ${OUT}/report.md`)
process.exit(summary.fail && !ALLOW_FAIL ? 1 : 0)
