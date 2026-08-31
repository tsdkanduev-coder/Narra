import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SCENE_ART_DIRECTIONS,
  SCENE_FANART_STYLE,
  SCENE_PROVIDER_PROMPT_LIMIT,
  parseSceneJobBody,
  sceneGenerationPrompt
} from '../scene-generation.mjs'

const requestId = '11111111-1111-4111-8111-111111111111'

test('scene jobs accept structured facts and build the provider prompt on the server', () => {
  const input = parseSceneJobBody({
    request_id: requestId,
    book_title: 'Преступление и наказание',
    book_author: 'Фёдор Достоевский',
    book_description: 'Психологический роман о преступлении и нравственном выборе.',
    book_subjects: ['классическая проза'],
    genre_id: 'literary-fiction',
    chapter: 'Часть первая',
    excerpt: 'Раскольников медленно спускался по лестнице.',
    characters: [{
      name: 'Раскольников',
      full_name: 'Родион Раскольников',
      role: 'студент',
      gender: 'male',
      appearance: 'худой молодой человек в старом пальто'
    }],
    previous_excerpts: []
  })
  assert.equal(input.requestId, requestId)
  const prompt = sceneGenerationPrompt(input)
  assert.match(prompt, /ЖАНР И СТИЛЬ \(литературная проза\)/)
  assert.match(prompt, /психологическим напряжением/)
  assert.match(prompt, /ЭПОХА И МИР/)
  assert.match(prompt, /ДЕЙСТВИЕ — ГЛАВНОЕ/)
  assert.match(prompt, /Родион Раскольников/)
  assert.match(prompt, /Раскольников медленно спускался/)
  assert.match(prompt, /без текста/)
  assert.ok(prompt.includes(SCENE_FANART_STYLE))
  assert.ok(prompt.endsWith(`Стиль: ${SCENE_FANART_STYLE}.`))
  assert.ok(prompt.length <= SCENE_PROVIDER_PROMPT_LIMIT)
})

test('scene prompt keeps the main genre, character and series policy inside provider budget', () => {
  const input = parseSceneJobBody({
    request_id: requestId,
    book_title: 'Гарри Поттер и Тень Хогвартса',
    book_author: 'anonymous_author',
    book_description: 'Фанфик о новой дуэли в школе магии.',
    book_subjects: ['фанфик'],
    genre_id: 'fanfiction',
    chapter: 'Глава 7. Дуэль',
    excerpt: 'Гарри выхватил палочку и бросился вперёд, отбивая заклятие. '.repeat(50),
    characters: [{
      name: 'Гарри',
      full_name: 'Гарри Поттер',
      role: 'герой',
      gender: 'male',
      appearance: 'худой юноша в круглых очках, 15 лет, худощавое телосложение, чёрные растрёпанные волосы, ярко-зелёные глаза, шрам-молния на лбу, школьная мантия'
    }, {
      name: 'Базаров',
      full_name: 'Евгений Базаров',
      role: 'посторонний герой',
      gender: 'male',
      appearance: 'высокий молодой человек с длинными волосами'
    }],
    previous_excerpts: [
      'Гарри крался по тёмному коридору восьмого этажа.',
      'Сова принесла письмо без подписи, и класс замер.'
    ]
  })

  const prompt = sceneGenerationPrompt(input)
  assert.match(prompt, /полуреалистичная аниме-иллюстрация момента/)
  assert.match(prompt, /Гарри Поттер/)
  assert.doesNotMatch(prompt, /Базаров/)
  assert.match(prompt, /без статичных поз/)
  assert.match(prompt, /КОНТЕКСТ СЕРИИ/)
  assert.match(prompt, /Тот же художник, палитра и манера/)
  assert.match(prompt, /без текста/)
  assert.ok(prompt.includes(SCENE_FANART_STYLE))
  assert.ok(prompt.length <= SCENE_PROVIDER_PROMPT_LIMIT)
})

test('scene prompt covers every genre id used by the main prompt', () => {
  assert.deepEqual(Object.keys(SCENE_ART_DIRECTIONS).sort(), [
    'adventure', 'biography-memoir', 'business-economics', 'children', 'classic',
    'drama', 'fanfiction', 'fantasy', 'historical-fiction', 'history-politics',
    'horror', 'literary-fiction', 'manga', 'mystery-thriller', 'philosophy',
    'poetry', 'psychology-self-help', 'romance', 'science-fiction',
    'science-technology'
  ])
})

test('scene prompt keeps mandatory blocks for maximum valid input', () => {
  const names = Array.from({ length: 16 }, (_, index) => `Герой${index}`)
  const input = parseSceneJobBody({
    request_id: requestId,
    book_title: 'К'.repeat(500),
    book_author: 'А'.repeat(500),
    book_description: 'Описание '.repeat(400),
    book_subjects: Array.from({ length: 32 }, () => 'литературная проза'),
    genre_id: '__proto__',
    chapter: 'Г'.repeat(500),
    excerpt: `${names.join(' ')} ${'действуют в старинном городе '.repeat(120)}`.slice(0, 4_000),
    characters: names.map((name) => ({
      name,
      full_name: `${name} Фамилия`,
      role: 'герой',
      gender: 'male',
      appearance: 'подробная каноническая внешность '.repeat(40).slice(0, 1_500)
    })),
    previous_excerpts: ['Первая сцена '.repeat(90), 'Вторая сцена '.repeat(90)]
  })

  const prompt = sceneGenerationPrompt(input)
  assert.ok(prompt.length <= SCENE_PROVIDER_PROMPT_LIMIT)
  assert.match(prompt, /ЖАНР И СТИЛЬ/)
  assert.match(prompt, /ЭПОХА И МИР/)
  assert.match(prompt, /ДЕЙСТВИЕ — ГЛАВНОЕ/)
  assert.match(prompt, /ПЕРСОНАЖИ/)
  assert.match(prompt, /КОНТЕКСТ СЕРИИ/)
  assert.match(prompt, /без текста/)
  assert.ok(prompt.includes(SCENE_FANART_STYLE))
})

test('scene jobs reject raw provider controls and malformed ids', () => {
  assert.throws(() => parseSceneJobBody({
    request_id: requestId,
    book_title: 'Книга',
    excerpt: 'Сцена',
    characters: [],
    previous_excerpts: [],
    model: 'provider/model'
  }), /неизвестное поле/)
  assert.throws(() => parseSceneJobBody({
    request_id: 'request-1',
    book_title: 'Книга',
    excerpt: 'Сцена',
    characters: [],
    previous_excerpts: []
  }), /UUID v4/)
})
