import { resolveCoverGenreProfile } from './cover-genre.mjs'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Both providers in the existing scene pipeline accept at least this many characters. */
export const SCENE_PROVIDER_PROMPT_LIMIT = 950

/** Scene-specific art direction ported from the main mobile prompt. */
export const SCENE_ART_DIRECTIONS = {
  classic:
    'Атмосферная живописная книжная иллюстрация: масляно-акварельная манера, глубокий естественный свет, воздух и фактура среды, живой уверенный мазок.',
  manga:
    'Аниме-кадр: кинематографичный кадр рисованного аниме-фильма 1990-х, решительные контуры, выразительная мимика, плоские тени, линии и смаз движения в кадре; без подражания конкретной студии.',
  fanfiction:
    'Живая полуреалистичная аниме-иллюстрация момента (semi-realistic anime): чистые линии, мягкая светотень, выразительные эмоции и жесты героев, кинематографичный ракурс; без копирования франшизного канона.',
  children:
    'Добрая детская книжная иллюстрация: яркие чистые цвета, простые тёплые формы, мягкий свет, юмор и движение, понятные силуэты.',
  poetry:
    'Лирическая импрессионистская иллюстрация: настроение и ритм важнее деталей, свободный мазок, недосказанность, тонкая палитра.',
  drama:
    'Театральный экспрессивный кадр: резкий боковой свет, крупные жесты, столкновение фигур в мизансцене, глубокие тени сцены.',
  'mystery-thriller':
    'Нуар-кадр: жёсткий контровой свет, глубокие тени, дождь или дым, напряжённая асимметричная композиция, ощущение слежки и тревоги.',
  'science-fiction':
    'Кинематографичный научно-фантастический кадр: ретрофутуристическая техника, объёмный свет, масштаб машин и пространств, точная детализация.',
  adventure:
    'Динамичная приключенческая иллюстрация: экстремальная диагональная композиция, ветер, пыль и брызги, физика движения, яркий природный свет.',
  fantasy:
    'Эпичная фэнтези-иллюстрация момента: живописный магический свет, осязаемая фактура мира, мифическая атмосфера без франшизных клише.',
  horror:
    'Тревожный готический кадр: сумрак, зыбкий источник света, длинные тени, гнетущая атмосфера и предчувствие — без крови и шок-образов.',
  romance:
    'Чувственная живописная иллюстрация: тёплый мягкий свет, движение ткани и воздуха, близость и напряжение между героями без глянца.',
  'historical-fiction':
    'Историческая жанровая живопись: достоверная фактура эпохи, естественный свет, живая многофигурная мизансцена в движении.',
  'biography-memoir':
    'Документальная реалистичная иллюстрация: сдержанная палитра, достоверная среда и одежда, подсмотренный живой момент.',
  philosophy:
    'Метафоричная гравюрная иллюстрация: строгая композиция, символическое действие фигур, точная линия и штриховка.',
  'psychology-self-help':
    'Современная редакционная иллюстрация: ясная визуальная метафора действия, тёплая ограниченная палитра, чистые формы.',
  'business-economics':
    'Современная редакционная иллюстрация: динамичная сцена в рабочей среде, чистая графика, точный жест и взаимодействие людей.',
  'science-technology':
    'Научно-популярная иллюстрация: точная детализация приборов и процессов, наглядное действие, холодный ясный свет.',
  'history-politics':
    'Историческая репортажная иллюстрация: документальная достоверность, движение толпы, сильный жест, фактура газетной эпохи.',
  'literary-fiction':
    'Атмосферная живописная иллюстрация с психологическим напряжением: выразительные позы и взгляды между героями, плотный свет, фактура среды.'
}

const GENRE_LABELS = {
  classic: 'классическая литература',
  manga: 'манга или аниме-графическая проза',
  fanfiction: 'фанфик или трансформативная проза',
  children: 'детская литература',
  poetry: 'поэзия',
  drama: 'драма или пьеса',
  'mystery-thriller': 'детектив, криминальная проза или триллер',
  'science-fiction': 'научная фантастика',
  adventure: 'приключения',
  fantasy: 'фэнтези',
  horror: 'хоррор',
  romance: 'романтическая проза',
  'historical-fiction': 'историческая проза',
  'biography-memoir': 'биография или мемуары',
  philosophy: 'философия',
  'psychology-self-help': 'психология или саморазвитие',
  'business-economics': 'бизнес или экономика',
  'science-technology': 'наука или технологии',
  'history-politics': 'история, общество или политика',
  'literary-fiction': 'литературная проза'
}

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'VALIDATION', status: 400 })
}

function text(value, name, max, { required = false } = {}) {
  if (value == null && !required) return ''
  if (typeof value !== 'string') invalid(`${name}: нужна строка`)
  const result = value.replace(/\s+/gu, ' ').trim()
  if ((required && !result) || result.length > max) invalid(`${name}: недопустимая длина`)
  return result
}

function textList(value, name, { maxItems, maxLength }) {
  if (!Array.isArray(value) || value.length > maxItems) {
    invalid(`${name}: нужен массив до ${maxItems} элементов`)
  }
  return value.map((item, index) => text(item, `${name}[${index}]`, maxLength, { required: true }))
}

function character(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`characters[${index}]: нужен объект`)
  }
  const allowed = new Set(['name', 'full_name', 'role', 'gender', 'appearance'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalid(`characters[${index}]: неизвестное поле`)
  }
  return {
    name: text(value.name, `characters[${index}].name`, 160, { required: true }),
    fullName: text(value.full_name, `characters[${index}].full_name`, 240),
    role: text(value.role, `characters[${index}].role`, 400),
    gender: text(value.gender, `characters[${index}].gender`, 32),
    appearance: text(value.appearance, `characters[${index}].appearance`, 1_500)
  }
}

export function parseSceneJobBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('body: нужен объект')
  const allowed = new Set([
    'request_id', 'book_title', 'book_author', 'book_description', 'book_subjects',
    'genre_id', 'chapter', 'excerpt', 'characters', 'previous_excerpts'
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid('body: неизвестное поле')
  const requestId = text(input.request_id, 'request_id', 36, { required: true })
  if (!UUID_V4.test(requestId)) invalid('request_id: нужен UUID v4')
  if (!Array.isArray(input.characters) || input.characters.length > 16) {
    invalid('characters: нужен массив до 16 элементов')
  }
  return {
    requestId,
    bookTitle: text(input.book_title, 'book_title', 500, { required: true }),
    bookAuthor: text(input.book_author, 'book_author', 500),
    bookDescription: text(input.book_description, 'book_description', 4_000),
    bookSubjects: textList(input.book_subjects ?? [], 'book_subjects', {
      maxItems: 32,
      maxLength: 200
    }),
    genreId: text(input.genre_id, 'genre_id', 80),
    chapter: text(input.chapter, 'chapter', 500),
    excerpt: text(input.excerpt, 'excerpt', 4_000, { required: true }),
    characters: input.characters.map(character),
    previousExcerpts: textList(input.previous_excerpts, 'previous_excerpts', {
      maxItems: 2,
      maxLength: 1_200
    })
  }
}

function clipped(value, max) {
  if (!value || max <= 0) return ''
  if (value.length <= max) return value
  if (max < 2) return ''
  const slice = value.slice(0, max - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= max * 0.6 ? slice.slice(0, lastSpace) : slice
  return `${cut.replace(/[\s,.;:!?…—-]+$/u, '')}…`
}

function mentionedCharacters(excerpt, characters) {
  const normalizedExcerpt = excerpt.toLocaleLowerCase('ru')
  return characters.filter((value) =>
    [value.name, value.fullName]
      .filter((name) => name.trim().length > 1)
      .some((name) => normalizedExcerpt.includes(name.toLocaleLowerCase('ru')))
  )
}

function genreProfile(input) {
  if (Object.hasOwn(SCENE_ART_DIRECTIONS, input.genreId)) {
    return { id: input.genreId, label: GENRE_LABELS[input.genreId] }
  }
  return resolveCoverGenreProfile({
    subjects: input.bookSubjects,
    title: input.bookTitle,
    description: input.bookDescription,
    excerpt: input.excerpt
  })
}

function promptValues(input) {
  const genre = genreProfile(input)
  const book = `«${input.bookTitle}»${input.bookAuthor ? ` (${input.bookAuthor})` : ''}${
    input.chapter ? `, глава «${input.chapter}»` : ''
  }`
  const canon = mentionedCharacters(input.excerpt, input.characters)
    .map((value) => {
      const appearance = value.appearance || [value.role, value.gender].filter(Boolean).join(', ')
      return `${value.fullName || value.name}${appearance ? `: ${appearance}` : ''}`
    })
    .join('; ')
  const previous = input.previousExcerpts
    .slice(0, 2)
    .map((value) => `«${clipped(value, 180)}»`)
    .join(' ')
  return {
    genreLabel: genre.label,
    artDirection: SCENE_ART_DIRECTIONS[genre.id] ?? SCENE_ART_DIRECTIONS.classic,
    book,
    excerpt: clipped(input.excerpt, 1_200),
    canon,
    previous
  }
}

function assemblePrompt(values, limits) {
  const genreLabel = clipped(values.genreLabel, limits.genreLabel)
  const artDirection = clipped(values.artDirection, limits.artDirection)
  const book = clipped(values.book, limits.book)
  const excerpt = clipped(values.excerpt, limits.excerpt)
  const canon = clipped(values.canon, limits.canon)
  const previous = clipped(values.previous, limits.previous)
  return [
    `ЖАНР И СТИЛЬ (${genreLabel}): ${artDirection}`,
    `ЭПОХА И МИР: ${book}. Одежда, причёски, предметы, архитектура и антураж строго из мира книги; без анахронизмов.`,
    `ДЕЙСТВИЕ — ГЛАВНОЕ: центральное событие в движении, в разгаре жеста; без статичных поз, взглядов в камеру и группового позирования. Отрывок: ${excerpt}`,
    canon
      ? `ПЕРСОНАЖИ: только упомянутые; внешность дословно: ${canon}. Одежда из сцены важнее паспортной; без лишних людей.`
      : 'ПЕРСОНАЖИ: только те, кто действует в отрывке; без лишних людей.',
    previous
      ? `КОНТЕКСТ СЕРИИ: ${previous} Тот же художник, палитра и манера.`
      : '',
    'Один момент и пространство, не коллаж. Строго без текста, букв, цифр, надписей, логотипов и водяных знаков.'
  ].filter(Boolean).join('\n\n')
}

/**
 * Keeps the main five-block scene policy while fitting the strictest provider
 * in the existing GigaChat -> Kandinsky pipeline. Important trailing rules are
 * preserved instead of being silently removed by a provider-level slice.
 */
/**
 * gpt-image-2 (the reader scene route) reads long prompts well. The 950-char
 * Kandinsky budget cut the excerpt to ~100 chars and dropped most in-frame
 * characters, so the picture could not match the scene the reader saw.
 */
export const SCENE_GPT_IMAGE_PROMPT_LIMIT = 2_500

export function sceneGenerationPrompt(input, { promptLimit = SCENE_PROVIDER_PROMPT_LIMIT } = {}) {
  const values = promptValues(input)
  const limits = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value.length])
  )
  const generous = promptLimit >= 2_000
  const minimums = {
    previous: values.previous ? 40 : 0,
    excerpt: generous ? 600 : 80,
    canon: values.canon ? (generous ? 300 : 60) : 0,
    book: 40,
    artDirection: 60,
    genreLabel: 18
  }
  let prompt = assemblePrompt(values, limits)
  for (const key of ['previous', 'excerpt', 'canon', 'book', 'artDirection', 'genreLabel']) {
    if (prompt.length <= promptLimit) break
    const available = Math.max(0, limits[key] - minimums[key])
    const reduction = Math.min(available, prompt.length - promptLimit + 1)
    limits[key] -= reduction
    prompt = assemblePrompt(values, limits)
  }
  if (prompt.length > promptLimit) {
    throw new Error('scene prompt policy exceeds the provider-safe budget')
  }
  return prompt
}
