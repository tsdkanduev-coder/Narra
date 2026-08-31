import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseAvatarBody,
  parseChatBody,
  parseCoverBody,
  parseCoverJobBody,
  parseImageBody,
  parsePortraitBody,
  parseSynthesisBody
} from '../contracts.mjs'
import { parseEventBatch } from '../events.mjs'

test('chat contract accepts optional book_edition_id for search grounding', () => {
  const parsed = parseChatBody({
    messages: [{ role: 'user', content: 'hello' }],
    book_edition_id: '123e4567-e89b-42d3-a456-426614174000'
  })
  assert.equal(parsed.bookEditionId, '123e4567-e89b-42d3-a456-426614174000')
  assert.throws(
    () => parseChatBody({
      messages: [{ role: 'user', content: 'hello' }],
      book_edition_id: 'not-a-uuid'
    }),
    /book_edition_id/
  )
})

test('chat contract accepts purpose, ignores client temperature and rejects client-selected provider', () => {
  const parsed = parseChatBody({
    messages: [{ role: 'user', content: 'hello' }],
    purpose: 'summary',
    temperature: 'not-a-server-setting'
  })
  assert.equal(parsed.purpose, 'summary')
  assert.equal(Object.hasOwn(parsed, 'temperature'), false)
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'user', content: 'hello' }], provider: 'openrouter' }),
    /неизвестное поле/
  )
})

test('background chat analytics is explicit and can be actorless after opt-out', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  assert.deepEqual(
    parseChatBody({
      messages,
      purpose: 'structured_task',
      origin: 'background',
      analytics_tier: 'none'
    }),
    {
      messages,
      purpose: 'structured_task',
      requestId: undefined,
      origin: 'background',
      analyticsTier: 'none',
      bookEditionId: undefined
    }
  )
  assert.throws(
    () => parseChatBody({ messages, origin: 'background', analytics_tier: 'essential' }),
    /background-запрос/
  )
  assert.throws(
    () => parseChatBody({ messages, origin: 'user', analytics_tier: 'none' }),
    /user-запрос/
  )
})

test('chat contract bounds payload and roles', () => {
  assert.throws(() => parseChatBody({ messages: [] }), /1–64/)
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'developer', content: 'hello' }] }),
    /недопустимая роль/
  )
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'tool', content: 'hello' }] }),
    /tool_call_id/
  )
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'user', content: 'x'.repeat(60_001) }] }),
    /длиной/
  )
  assert.throws(
    () => parseChatBody({ messages: [{ role: 'user', content: 'hello' }], request_id: 'private-text' }),
    /UUID v4/
  )
  assert.equal(
    parseChatBody({ messages: [{ role: 'user', content: 'hello' }], request_id: '123e4567-e89b-42d3-a456-426614174001' }).requestId,
    '123e4567-e89b-42d3-a456-426614174001'
  )
})

test('assistant chat contract preserves bounded OpenAI tool calls without provider fields', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'list_books',
      description: 'List local books',
      parameters: { type: 'object', properties: {} }
    }
  }]
  const parsed = parseChatBody({
    purpose: 'assistant',
    messages: [
      { role: 'user', content: 'Что я читаю?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'list_books', arguments: '{}' }
        }]
      },
      { role: 'tool', content: '["Детство"]', name: 'list_books', tool_call_id: 'call-1' }
    ],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false
  })

  assert.equal(parsed.purpose, 'assistant')
  assert.equal(parsed.messages[1].content, '')
  assert.equal(parsed.messages[1].tool_calls[0].function.name, 'list_books')
  assert.equal(parsed.messages[2].name, 'list_books')
  assert.deepEqual(parsed.tools, tools)
  assert.equal(parsed.toolChoice, 'auto')
  assert.equal(parsed.parallelToolCalls, false)
})

test('assistant chat contract drops empty incomplete assistant history entries', () => {
  const parsed = parseChatBody({
    purpose: 'assistant',
    messages: [
      { role: 'user', content: 'Первый вопрос' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Повтори' }
    ]
  }, { stream: true })

  assert.deepEqual(parsed.messages, [
    { role: 'user', content: 'Первый вопрос' },
    { role: 'user', content: 'Повтори' }
  ])
})

test('media and speech contracts reject unknown or oversized inputs', () => {
  assert.deepEqual(parseImageBody({ prompt: 'scene' }), {
    prompt: 'scene', width: 768, height: 1024, engine: undefined
  })
  assert.equal(parseImageBody({ prompt: 'portrait', engine: 'openrouter' }).engine, 'openrouter')
  assert.throws(() => parseImageBody({ prompt: 'scene', provider: 'x' }), /неизвестное поле/)
  assert.throws(() => parseImageBody({ prompt: 'scene', engine: 'unknown' }), /неизвестный движок/)
  assert.throws(() => parseSynthesisBody({ text: 'a', ssml: '<speak>a</speak>' }), /ровно одно/)
  assert.deepEqual(parseSynthesisBody({ text: 'hello', voice: 'Che' }), {
    text: 'hello',
    ssml: undefined,
    voice: 'Che',
    providerVoice: 'Che_48000',
    sampleRate: 48000
  })
  assert.deepEqual(parseSynthesisBody({ text: 'hello', voice: 'Ana' }), {
    text: 'hello',
    ssml: undefined,
    voice: 'Ana',
    providerVoice: 'Ana_24000',
    sampleRate: 24000
  })
  assert.throws(() => parseSynthesisBody({ text: 'hello', voice: 'Nec' }), /не поддерживается/)
  assert.throws(() => parseSynthesisBody({ text: 'hello', voice: 'Che_24000' }), /не поддерживается/)
  assert.equal(parseAvatarBody({ image: 'a', audio: 'b' }).image, 'a')
  assert.throws(() => parsePortraitBody({ image: 'a', quality: '4k' }), /lite или hd/)
})

test('cover contract accepts only a bounded prompt and no provider hints', () => {
  assert.deepEqual(parseCoverBody({ prompt: 'front cover artwork' }), {
    prompt: 'front cover artwork'
  })
  assert.throws(() => parseCoverBody({ prompt: 'cover', model: 'gpt-image-2' }), /неизвестное поле/)
  assert.throws(() => parseCoverBody({ prompt: 'cover', width: 768 }), /неизвестное поле/)
  assert.throws(() => parseCoverBody({}), /строка длиной/)
  assert.throws(() => parseCoverBody({ prompt: 'x'.repeat(8_001) }), /строка длиной/)
})

test('durable cover job contract requires a UUID idempotency key and no provider hints', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174001'
  assert.deepEqual(parseCoverJobBody({ prompt: 'front cover artwork', request_id: requestId }), {
    prompt: 'front cover artwork',
    requestId
  })
  assert.throws(() => parseCoverJobBody({ prompt: 'cover' }), /request_id/)
  assert.throws(
    () => parseCoverJobBody({ prompt: 'cover', request_id: 'book-title' }),
    /UUID v4/
  )
  assert.throws(
    () => parseCoverJobBody({ prompt: 'cover', request_id: requestId, model: 'gpt-image-2' }),
    /неизвестное поле/
  )
  assert.throws(
    () => parseCoverJobBody({ prompt: 'x'.repeat(8_001), request_id: requestId }),
    /строка длиной/
  )
})

test('durable cover job contract accepts bounded book context for server-owned prompts', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174001'
  assert.deepEqual(parseCoverJobBody({
    request_id: requestId,
    book: {
      title: 'Анна Каренина',
      author: 'Лев Толстой',
      description: 'Роман о семье и давлении общества.',
      subjects: ['literary fiction']
    }
  }), {
    requestId,
    book: {
      title: 'Анна Каренина',
      author: 'Лев Толстой',
      description: 'Роман о семье и давлении общества.',
      excerpt: undefined,
      subjects: ['literary fiction']
    }
  })
  assert.throws(
    () => parseCoverJobBody({ request_id: requestId }),
    /ровно одно поле/
  )
  assert.throws(
    () => parseCoverJobBody({ request_id: requestId, prompt: 'old', book: { title: 'new' } }),
    /ровно одно поле/
  )
  assert.throws(
    () => parseCoverJobBody({ request_id: requestId, book: { title: 'x', model: 'private' } }),
    /неизвестное поле/
  )
})

test('analytics accepts only allowlisted events and properties', () => {
  const event = {
    eventId: '123e4567-e89b-42d3-a456-426614174000',
    name: 'app_opened',
    occurredAt: new Date().toISOString(),
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
    schemaVersion: 1,
    properties: { app_version: '0.7.7', arch: 'arm64' }
  }
  assert.equal(parseEventBatch({ events: [event] })[0].event_name, 'app_opened')
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, properties: { prompt: 'private text' } }] }),
    /properties.prompt/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, name: 'button_clicked' }] }),
    /name/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, name: 'ai_request_completed', properties: {} }] }),
    /name/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, sessionId: { private: 'text' } }] }),
    /sessionId/
  )
  assert.throws(
    () => parseEventBatch({ events: [{ ...event, properties: { route: 'covert content' } }] }),
    /не разрешено/
  )
  const offline = { ...event, eventId: '223e4567-e89b-42d3-a456-426614174000', occurredAt: new Date(Date.now() - 30 * 86400_000).toISOString() }
  assert.equal(parseEventBatch({ events: [offline] })[0].event_id, offline.eventId)
})

test('analytics error codes are closed enums and cannot carry content', () => {
  const event = {
    eventId: '123e4567-e89b-42d3-a456-426614174099',
    name: 'book_import_failed',
    occurredAt: new Date().toISOString(),
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
    schemaVersion: 1,
    properties: { format: 'epub', source_class: 'file', error_code: 'private-text-fragment' }
  }
  assert.throws(() => parseEventBatch({ events: [event] }), /error_code/)
  event.properties.error_code = 'PARSE'
  assert.equal(parseEventBatch({ events: [event] })[0].properties.error_code, 'PARSE')
})

test('extended import and media telemetry accepts buckets but rejects book content', () => {
  const base = {
    eventId: '123e4567-e89b-42d3-a456-426614174088',
    occurredAt: new Date().toISOString(),
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
    schemaVersion: 1
  }
  const completed = parseEventBatch({
    events: [{
      ...base,
      name: 'media_job_completed',
      properties: {
        job_type: 'tts',
        job_latency_bucket: '1-4s',
        cache_hit: true,
        result_size_bucket: '256kb-1mb',
        origin: 'user'
      }
    }]
  })[0]
  assert.equal(completed.properties.cache_hit, true)
  const coverEnqueued = parseEventBatch({
    events: [{
      ...base,
      name: 'media_job_enqueued',
      properties: {
        job_type: 'cover',
        provider: 'openrouter',
        model: 'gpt-image-2',
        quality: 'unknown',
        queue_depth_bucket: '0',
        origin: 'background'
      }
    }]
  })[0]
  assert.equal(coverEnqueued.properties.job_type, 'cover')
  assert.throws(
    () => parseEventBatch({
      events: [{
        ...base,
        name: 'book_analysis_completed',
        properties: {
          analysis_version: 'v1',
          character_count_bucket: '4-8',
          duration_bucket: '15-59s',
          origin: 'background',
          title: 'private book title'
        }
      }]
    }),
    /properties.title/
  )
  assert.throws(
    () => parseEventBatch({
      events: [{
        ...base,
        name: 'media_job_failed',
        properties: {
          job_type: 'image',
          stage: 'provider',
          safe_error_code: 'upstream said private prompt',
          retry_count_bucket: '0',
          origin: 'user'
        }
      }]
    }),
    /safe_error_code/
  )
})
