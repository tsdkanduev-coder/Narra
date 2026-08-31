import { voiceConfig } from './voices.mjs'

const PURPOSES = new Set(['assistant', 'character_chat', 'structured_task', 'summary', 'scenario', 'memory'])
const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'VALIDATION'
  throw error
}

function object(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name}: нужен объект`)
  return value
}

function onlyKeys(value, allowed, name = 'body') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${name}.${key}: неизвестное поле`)
  }
}

function string(value, name, { min = 1, max }) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${name}: строка длиной ${min}–${max}`)
  }
  return value
}

function optionalString(value, name, { min = 1, max }) {
  return value === undefined ? undefined : string(value, name, { min, max })
}

function chatToolCall(value, name) {
  const call = object(value, name)
  onlyKeys(call, new Set(['id', 'type', 'function']), name)
  if (call.type !== 'function') fail(`${name}.type: поддерживается только function`)
  const fn = object(call.function, `${name}.function`)
  onlyKeys(fn, new Set(['name', 'arguments']), `${name}.function`)
  return {
    id: string(call.id, `${name}.id`, { max: 200 }),
    type: 'function',
    function: {
      name: string(fn.name, `${name}.function.name`, { max: 128 }),
      arguments: string(fn.arguments, `${name}.function.arguments`, { min: 0, max: 60_000 })
    }
  }
}

function chatTool(value, name) {
  const tool = object(value, name)
  onlyKeys(tool, new Set(['type', 'function']), name)
  if (tool.type !== 'function') fail(`${name}.type: поддерживается только function`)
  const fn = object(tool.function, `${name}.function`)
  onlyKeys(fn, new Set(['name', 'description', 'parameters', 'strict']), `${name}.function`)
  const parameters = object(fn.parameters, `${name}.function.parameters`)
  const serializedParameters = JSON.stringify(parameters)
  if (serializedParameters.length > 40_000) fail(`${name}.function.parameters: схема слишком большая`)
  if (fn.strict !== undefined && typeof fn.strict !== 'boolean') {
    fail(`${name}.function.strict: нужен boolean`)
  }
  return {
    type: 'function',
    function: {
      name: string(fn.name, `${name}.function.name`, { max: 128 }),
      ...(fn.description === undefined
        ? {}
        : { description: string(fn.description, `${name}.function.description`, { min: 0, max: 4_000 }) }),
      parameters,
      ...(fn.strict === undefined ? {} : { strict: fn.strict })
    }
  }
}

function chatToolChoice(value) {
  if (typeof value === 'string') {
    if (!['auto', 'none', 'required'].includes(value)) fail('tool_choice: неизвестный режим')
    return value
  }
  const choice = object(value, 'tool_choice')
  onlyKeys(choice, new Set(['type', 'function']), 'tool_choice')
  if (choice.type !== 'function') fail('tool_choice.type: поддерживается только function')
  const fn = object(choice.function, 'tool_choice.function')
  onlyKeys(fn, new Set(['name']), 'tool_choice.function')
  return {
    type: 'function',
    function: { name: string(fn.name, 'tool_choice.function.name', { max: 128 }) }
  }
}

export function parseChatBody(input, { stream = false } = {}) {
  const body = object(input)
  onlyKeys(body, new Set([
    'messages', 'temperature', 'purpose', 'request_id', 'origin', 'analytics_tier',
    'tools', 'tool_choice', 'parallel_tool_calls', 'book_edition_id'
  ]))
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 64) {
    fail('messages: нужен массив из 1–64 сообщений')
  }
  const defaultPurpose = stream ? 'character_chat' : 'structured_task'
  const purpose = body.purpose === undefined ? defaultPurpose : String(body.purpose)
  if (!PURPOSES.has(purpose)) fail('purpose: неизвестное назначение запроса')
  let total = 0
  const messages = body.messages.map((candidate, index) => {
    const message = object(candidate, `messages[${index}]`)
    onlyKeys(message, new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']), `messages[${index}]`)
    if (!ROLES.has(message.role)) fail(`messages[${index}].role: недопустимая роль`)
    const calls = message.tool_calls === undefined
      ? undefined
      : (() => {
          if (message.role !== 'assistant') fail(`messages[${index}].tool_calls: допустимо только для assistant`)
          if (!Array.isArray(message.tool_calls) || message.tool_calls.length < 1 || message.tool_calls.length > 32) {
            fail(`messages[${index}].tool_calls: нужен массив из 1–32 вызовов`)
          }
          return message.tool_calls.map((call, callIndex) => (
            chatToolCall(call, `messages[${index}].tool_calls[${callIndex}]`)
          ))
        })()
    const toolCallId = optionalString(
      message.tool_call_id,
      `messages[${index}].tool_call_id`,
      { max: 200 }
    )
    if (message.role === 'tool' && !toolCallId) {
      fail(`messages[${index}].tool_call_id: обязателен для tool`)
    }
    if (message.role !== 'tool' && toolCallId) {
      fail(`messages[${index}].tool_call_id: допустим только для tool`)
    }
    const messageName = optionalString(message.name, `messages[${index}].name`, { max: 128 })
    const allowEmpty = message.role === 'assistant' && (calls || purpose === 'assistant')
    const content = (message.content === null || message.content === undefined) && allowEmpty
      ? ''
      : string(message.content, `messages[${index}].content`, {
          min: allowEmpty ? 0 : 1,
          max: 60_000
        })
    total += content.length
    return {
      role: message.role,
      content,
      ...(messageName ? { name: messageName } : {}),
      ...(calls ? { tool_calls: calls } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {})
    }
  }).filter((message) => !(
    purpose === 'assistant'
    && message.role === 'assistant'
    && message.content.length === 0
    && !message.tool_calls
  ))
  if (messages.length < 1) fail('messages: после очистки не осталось сообщений')
  if (total > 180_000) fail('messages: суммарный текст больше 180000 символов')
  let tools
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length < 1 || body.tools.length > 48) {
      fail('tools: нужен массив из 1–48 инструментов')
    }
    tools = body.tools.map((tool, index) => chatTool(tool, `tools[${index}]`))
    if (JSON.stringify(tools).length > 160_000) fail('tools: суммарная схема слишком большая')
  }
  const toolChoice = body.tool_choice === undefined ? undefined : chatToolChoice(body.tool_choice)
  if (toolChoice !== undefined && !tools) fail('tool_choice: нельзя передавать без tools')
  const parallelToolCalls = body.parallel_tool_calls === undefined
    ? undefined
    : (() => {
        if (typeof body.parallel_tool_calls !== 'boolean') {
          fail('parallel_tool_calls: нужен boolean')
        }
        return body.parallel_tool_calls
      })()
  if (parallelToolCalls !== undefined && !tools) {
    fail('parallel_tool_calls: нельзя передавать без tools')
  }
  const requestId = body.request_id === undefined
    ? undefined
    : string(body.request_id, 'request_id', { max: 80 })
  if (requestId !== undefined && !UUID_V4.test(requestId)) fail('request_id: нужен UUID v4')
  const origin = body.origin === undefined ? 'user' : String(body.origin)
  if (!['user', 'background'].includes(origin)) fail('origin: допустимы user или background')
  const defaultTier = origin === 'background' ? 'none' : 'essential'
  const analyticsTier = body.analytics_tier === undefined
    ? defaultTier
    : String(body.analytics_tier)
  if (!['none', 'extended', 'essential'].includes(analyticsTier)) {
    fail('analytics_tier: неизвестный уровень')
  }
  if (origin === 'user' && analyticsTier !== 'essential') {
    fail('analytics_tier: user-запрос должен быть essential')
  }
  if (origin === 'background' && analyticsTier === 'essential') {
    fail('analytics_tier: background-запрос не может быть essential')
  }
  const bookEditionId = body.book_edition_id === undefined
    ? undefined
    : string(body.book_edition_id, 'book_edition_id', { max: 36 })
  if (bookEditionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookEditionId)) {
    fail('book_edition_id: нужен UUID')
  }
  return {
    messages,
    purpose,
    requestId,
    origin,
    analyticsTier,
    bookEditionId,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {})
  }
}

export function parseImageBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['prompt', 'width', 'height', 'engine']))
  const prompt = string(body.prompt, 'prompt', { max: 4_000 })
  const width = body.width === undefined ? 768 : Number(body.width)
  const height = body.height === undefined ? 1024 : Number(body.height)
  if (!Number.isInteger(width) || width < 256 || width > 2048) fail('width: целое число 256–2048')
  if (!Number.isInteger(height) || height < 256 || height > 2048) fail('height: целое число 256–2048')
  if (body.engine !== undefined && !['kandinsky', 'openrouter'].includes(body.engine)) fail('engine: неизвестный движок')
  return { prompt, width, height, engine: body.engine }
}

// Compatibility route for already released clients. New durable jobs send
// structured book context and let the gateway own prompt construction.
export function parseCoverBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['prompt']))
  return { prompt: string(body.prompt, 'prompt', { max: 8_000 }) }
}

export function parseCoverJobBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['prompt', 'book', 'request_id']))
  const requestId = string(body.request_id, 'request_id', { max: 36 })
  if (!UUID_V4.test(requestId)) fail('request_id: нужен UUID v4')
  if ((body.prompt === undefined) === (body.book === undefined)) {
    fail('нужно ровно одно поле: prompt или book')
  }
  if (body.prompt !== undefined) {
    return {
      prompt: string(body.prompt, 'prompt', { max: 8_000 }),
      requestId
    }
  }

  const book = object(body.book, 'book')
  onlyKeys(book, new Set(['title', 'author', 'description', 'excerpt', 'subjects']), 'book')
  const optionalText = (key, max) => book[key] === undefined
    ? undefined
    : string(book[key], `book.${key}`, { min: 0, max })
  if (book.subjects !== undefined && (
    !Array.isArray(book.subjects) || book.subjects.length > 32
  )) {
    fail('book.subjects: нужен массив до 32 элементов')
  }
  const subjects = book.subjects?.map((value, index) => (
    string(value, `book.subjects[${index}]`, { max: 120 })
  ))
  return {
    book: {
      title: string(book.title, 'book.title', { min: 0, max: 500 }),
      author: optionalText('author', 500),
      description: optionalText('description', 2_000),
      excerpt: optionalText('excerpt', 2_000),
      subjects
    },
    requestId
  }
}

export function parseSynthesisBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['text', 'ssml', 'voice']))
  if ((body.text === undefined) === (body.ssml === undefined)) fail('нужно ровно одно поле: text или ssml')
  const text = body.text === undefined ? undefined : string(body.text, 'text', { max: 12_000 })
  const ssml = body.ssml === undefined ? undefined : string(body.ssml, 'ssml', { max: 24_000 })
  const voice = body.voice === undefined ? 'Che' : string(body.voice, 'voice', { max: 24 })
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(voice)) fail('voice: недопустимое значение')
  const config = voiceConfig(voice)
  if (!config) fail('voice: голос не поддерживается')
  return {
    text,
    ssml,
    voice,
    providerVoice: config.providerVoice,
    sampleRate: config.sampleRate
  }
}

export function parseAvatarBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['image', 'audio', 'query']))
  return {
    image: string(body.image, 'image', { max: 18_000_000 }),
    audio: string(body.audio, 'audio', { max: 18_000_000 }),
    query: body.query === undefined ? undefined : string(body.query, 'query', { max: 2_000 })
  }
}

export function parsePortraitBody(input) {
  const body = object(input)
  onlyKeys(body, new Set(['image', 'query', 'quality']))
  const quality = body.quality === undefined ? 'lite' : String(body.quality)
  if (!['lite', 'hd'].includes(quality)) fail('quality: допустимы lite или hd')
  return {
    image: string(body.image, 'image', { max: 18_000_000 }),
    query: body.query === undefined ? undefined : string(body.query, 'query', { max: 2_000 }),
    quality
  }
}

export function validationErrors(error, _req, res, next) {
  if (error?.status === 400 || error?.type === 'entity.too.large') {
    const status = error.type === 'entity.too.large' ? 413 : 400
    return res.status(status).json({ error: error.message, code: 'VALIDATION' })
  }
  next(error)
}
