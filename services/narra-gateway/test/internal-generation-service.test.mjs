import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import {
  createInternalGenerationRouter,
  createInternalGenerationService,
  fallbackProfileDescription,
  filterStableTraits,
  requireGenerationServiceToken
} from '../internal-generation-service.mjs'

function memoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, {
    bytes: Buffer.from(value.bytes), mimeType: value.mimeType
  }]))
  return {
    objects,
    async getBytes({ objectKey }) {
      const value = objects.get(objectKey)
      if (!value) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
      return { ...value, bytes: Buffer.from(value.bytes), metadata: {} }
    },
    async putBytes({ objectKey, bytes, mimeType }) {
      const stored = Buffer.from(bytes)
      objects.set(objectKey, { bytes: stored, mimeType })
      return {
        objectKey,
        contentHash: createHash('sha256').update(stored).digest('hex'),
        mimeType,
        byteSize: stored.byteLength
      }
    }
  }
}

test('internal generation service extracts markup once and returns an idempotent cached result', async () => {
  const source = Buffer.from(`Анна вошла в комнату. ${'текст '.repeat(9_000)}В конце книги снова появилась Анна.`)
  const contentSha256 = createHash('sha256').update(source).digest('hex')
  const storage = memoryStorage({ source: { bytes: source, mimeType: 'text/plain' } })
  let chatCalls = 0
  let chatRequest
  const lines = []
  const service = createInternalGenerationService({
    storage,
    logger: { info(line) { lines.push(line) }, error(line) { lines.push(line) } },
    async completeChat(input) {
      chatCalls += 1
      chatRequest = input
      return JSON.stringify({ characters: [{
        name: 'Анна', fullName: 'Анна', aliases: [], gender: 'female',
        description: 'Главная героиня', appearancePrompt: 'portrait of Anna', greeting: 'Здравствуйте'
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: '11111111-1111-4111-8111-111111111111:book-markup:book-markup-v2',
    bookEditionId: '11111111-1111-4111-8111-111111111111',
    analysisVersion: 'book-markup-v2', scope: 'private', title: 'Книга', author: '',
    format: 'txt', contentSha256, objectKey: 'source', mimeType: 'text/plain', byteSize: source.byteLength
  }
  const first = await service.generateBookMarkup(request)
  const second = await service.generateBookMarkup(request)
  assert.deepEqual(second, first)
  assert.equal(chatCalls, 1)
  assert.equal(Object.hasOwn(chatRequest, 'temperature'), false)
  assert.deepEqual(chatRequest.costContext, {
    bookEditionId: request.bookEditionId,
    operation: 'legacy_book_markup',
    stage: 'markup',
    metadata: { analysis_version: request.analysisVersion }
  })
  assert.equal(first.textLength, source.toString('utf8').length)
  assert.equal(first.characters[0].firstAppearanceTextOffset, 0)
  assert.equal(lines.filter((line) => line.includes('event="markup.chunk_selected"')).length, 3)
  assert.ok(lines.some((line) => line.includes('chunk="1/3"') && line.includes('section="начало"')))
  assert.ok(lines.some((line) => line.includes('event="markup.character_found"') && line.includes('character="Анна"')))
  assert.ok(lines.some((line) => line.includes('event="markup.cached"')))
  assert.ok(lines.some((line) => line.includes('event="markup.cache_hit"')))
})

test('internal generation service normalizes book display identity idempotently', async () => {
  const source = Buffer.from('Мертвое озеро. Роман Николая Некрасова и Авдотьи Панаевой.')
  const contentSha256 = createHash('sha256').update(source).digest('hex')
  const storage = memoryStorage({ source: { bytes: source, mimeType: 'text/plain' } })
  let chatCalls = 0
  let chatRequest
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat(input) {
      chatCalls += 1
      chatRequest = input
      return JSON.stringify({ title: 'Мертвое озеро', author: '' })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: '11111111-1111-4111-8111-111111111111:book-identity:book-identity-v1-aaaaaaaa',
    bookEditionId: '11111111-1111-4111-8111-111111111111',
    targetVersion: 'book-identity-v1-aaaaaaaa', scope: 'catalog',
    title: 'Мертвое озеро (Часть первая)', author: 'Николай Некрасов (1821—1877)',
    format: 'txt', contentSha256, objectKey: 'source',
    mimeType: 'text/plain', byteSize: source.byteLength
  }
  const first = await service.generateBookIdentity(request)
  const repeated = await service.generateBookIdentity(request)
  assert.deepEqual(first, {
    title: 'Мертвое озеро', author: 'Николай Некрасов', source: 'llm'
  })
  assert.deepEqual(repeated, first)
  assert.equal(chatCalls, 1)
  assert.match(chatRequest.messages[1].content, /Мертвое озеро \(Часть первая\)/)
  assert.match(chatRequest.messages[1].content, /BOOK_EXCERPT/)
  assert.deepEqual(chatRequest.costContext, {
    bookEditionId: request.bookEditionId,
    operation: 'normalize_book_identity',
    stage: 'identity',
    metadata: { target_version: request.targetVersion }
  })
})

test('internal generation service creates all three required bundle assets', async () => {
  const storage = memoryStorage()
  const lines = []
  let generatedPortraitPrompt = ''
  const service = createInternalGenerationService({
    storage,
    logger: { info(line) { lines.push(line) }, error(line) { lines.push(line) } },
    async completeChat() { throw new Error('unused') },
    async generatePortrait(prompt) {
      generatedPortraitPrompt = prompt
      return {
        bytes: Buffer.from('jpeg'),
        mimeType: 'image/jpeg',
        provider: 'openrouter:openai/gpt-image-2'
      }
    },
    async synthesizeSpeech() {
      return { bytes: Buffer.from('wav'), mimeType: 'audio/wav', provider: 'salute-speech' }
    },
    async generateIdleAnimation() {
      return { bytes: Buffer.from('mp4'), mimeType: 'video/mp4', provider: 'local-ffmpeg' }
    }
  })
  const result = await service.generateCharacterBundle({
    idempotencyKey: '11111111-1111-4111-8111-111111111111:character:anna:character-bundle-v3:primary_portrait+greeting_audio+idle_animation',
    bookEditionId: '11111111-1111-4111-8111-111111111111', characterKey: 'character:anna',
    name: 'Анна', fullName: 'Анна', scope: 'private', bookTitle: 'Книга', bookAuthor: '',
    bundleVersion: 'character-bundle-v3',
    requiredMedia: ['primary_portrait', 'greeting_audio', 'idle_animation'],
    character: {
      characterKey: 'character:anna', name: 'Анна', fullName: 'Анна', aliases: [], gender: 'female',
      age: '', role: '', description: '', appearancePrompt: 'portrait', greeting: 'Привет', voice: 'Che',
      firstAppearanceTextOffset: 0, warmupTextOffset: 0
    }
  })
  assert.deepEqual(result.assets.map((asset) => asset.type), [
    'primary_portrait', 'greeting_audio', 'idle_animation'
  ])
  assert.deepEqual(result.assets.map((asset) => asset.mimeType), ['image/jpeg', 'audio/wav', 'video/mp4'])
  assert.match(result.assets[0].objectKey, /primary-portrait\.jpg$/)
  assert.match(generatedPortraitPrompt, /^Ровно один человек в кадре — Анна, никого больше/)
  assert.match(generatedPortraitPrompt, /Персонаж книги «Книга»/)
  assert.match(generatedPortraitPrompt, /Внешность \(соблюдать точно\): portrait/)
  assert.match(generatedPortraitPrompt, /классический живописный портрет/)
  assert.ok(generatedPortraitPrompt.length <= 1_600)
  assert.ok(lines.some((line) => line.includes('event="bundle.portrait_ready"') && line.includes('provider="openrouter:openai/gpt-image-2"')))
  assert.ok(lines.some((line) => line.includes('event="bundle.audio_ready"') && line.includes('provider="salute-speech"')))
  assert.ok(lines.some((line) => line.includes('event="bundle.animation_ready"') && line.includes('provider="local-ffmpeg"')))
  assert.equal(lines.filter((line) => line.includes('event="bundle.asset_stored"')).length, 3)
  assert.ok(lines.some((line) => line.includes('event="bundle.cached"')))
})

test('internal generation service reads the canonical excerpt and stores a scene idempotently', async () => {
  const normalizedText = `Анна открыла дверь и вошла в зал. ${'Событие продолжалось. '.repeat(400)}`
  const bytes = Buffer.from(normalizedText)
  const normalizedTextHash = createHash('sha256').update(bytes).digest('hex')
  const storage = memoryStorage({
    normalized: { bytes, mimeType: 'text/plain; charset=utf-8' }
  })
  let sceneCalls = 0
  let scenePrompt = ''
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() { throw new Error('unused') },
    async generatePortrait() { throw new Error('portrait must not run') },
    async generateScene(prompt) {
      sceneCalls += 1
      scenePrompt = prompt
      return { bytes: Buffer.from('scene'), mimeType: 'image/png', provider: 'gigachat-image' }
    },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: '11111111-1111-4111-8111-111111111111:scene:text-interval-v1:0:text-interval-v1:aaaaaaaaaaaaaaaa',
    bookEditionId: '11111111-1111-4111-8111-111111111111',
    targetVersion: 'text-interval-v1:aaaaaaaaaaaaaaaa',
    scope: 'private',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    sceneKey: 'text-interval-v1:0',
    slotIndex: 0,
    anchorTextOffset: 100,
    excerptStartTextOffset: 0,
    excerptEndTextOffset: 6_000,
    textLength: normalizedText.length,
    normalizedTextObjectKey: 'normalized',
    normalizedTextHash,
    genreId: 'mystery-thriller',
    chapter: 'Часть первая',
    characters: [{
      characterKey: 'character:anna', name: 'Анна', fullName: 'Анна',
      profile: { role: { value: 'Героиня' }, creative: { appearancePrompt: 'тёмные волосы' } }
    }]
  }

  const first = await service.generateBookScene(request)
  const repeated = await service.generateBookScene(request)
  assert.deepEqual(repeated, first)
  assert.equal(sceneCalls, 1)
  assert.match(scenePrompt, /Анна открыла дверь/)
  assert.match(scenePrompt, /тёмные волосы/)
  // Edition context reaches the prompt: curated genre art direction and chapter.
  assert.match(scenePrompt, /ЖАНР И СТИЛЬ \(детектив, криминальная проза или триллер\)/)
  assert.match(scenePrompt, /глава «Часть первая»/)
  // The gpt-image route keeps a long excerpt instead of the 950-char Kandinsky cut.
  assert.ok(scenePrompt.length > 950, `prompt should use the gpt-image budget, got ${scenePrompt.length}`)
  assert.equal(first.asset.type, 'scene_image')
  assert.match(first.asset.objectKey, /\/scenes\/text-interval-v1-aaaaaaaaaaaaaaaa\/0\.png$/)
})

test('internal generation service publishes one requested character asset independently', async () => {
  const storage = memoryStorage()
  let portraitCalls = 0
  let generatedPortraitPrompt = ''
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() { throw new Error('unused') },
    async generatePortrait(prompt) {
      portraitCalls += 1
      generatedPortraitPrompt = prompt
      return { bytes: Buffer.from('png'), mimeType: 'image/png', provider: 'image' }
    },
    async synthesizeSpeech() { throw new Error('audio must not run') },
    async generateIdleAnimation() { throw new Error('animation must not run') }
  })
  const result = await service.generateCharacterBundle({
    idempotencyKey: '11111111-1111-4111-8111-111111111111:character:anna:character-bundle-v3:r2:primary_portrait',
    bookEditionId: '11111111-1111-4111-8111-111111111111', characterKey: 'character:anna',
    name: 'Анна', fullName: 'Анна', scope: 'private', bookTitle: 'Книга', bookAuthor: '',
    bundleVersion: 'character-bundle-v3:r2', requiredMedia: ['primary_portrait'],
    character: {
      characterKey: 'character:anna', name: 'Анна', fullName: 'Анна', aliases: [], gender: 'female',
      age: '', role: '', description: '', appearancePrompt: 'portrait', greeting: 'Привет', voice: 'Che',
      firstAppearanceTextOffset: 0, warmupTextOffset: 0
    }
  })
  assert.equal(portraitCalls, 1)
  assert.match(generatedPortraitPrompt, /Ровно один человек в кадре — Анна/)
  assert.match(generatedPortraitPrompt, /Персонаж книги «Книга»/)
  assert.doesNotMatch(generatedPortraitPrompt, /Single character|fictional adult woman/i)
  assert.deepEqual(result.assets.map(({ type }) => type), ['primary_portrait'])
})

test('internal generation service reuses a stored OpenRouter JPEG for an independent animation', async () => {
  const bookEditionId = '11111111-1111-4111-8111-111111111111'
  const bundleVersion = 'character-bundle-v3:r3'
  const prefix = `generated/private/${bookEditionId}/characters/character:anna/${bundleVersion}`
  const storage = memoryStorage({
    [`${prefix}/primary-portrait.jpg`]: {
      bytes: Buffer.from('stored-jpeg'),
      mimeType: 'image/jpeg'
    }
  })
  let animationSource = ''
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() { throw new Error('unused') },
    async generatePortrait() { throw new Error('portrait must not run') },
    async synthesizeSpeech() { throw new Error('audio must not run') },
    async generateIdleAnimation(bytes) {
      animationSource = bytes.toString('utf8')
      return { bytes: Buffer.from('mp4'), mimeType: 'video/mp4', provider: 'local-ffmpeg' }
    }
  })

  const result = await service.generateCharacterBundle({
    idempotencyKey: `${bookEditionId}:character:anna:${bundleVersion}:idle_animation`,
    bookEditionId,
    characterKey: 'character:anna',
    name: 'Анна',
    fullName: 'Анна',
    scope: 'private',
    bookTitle: 'Книга',
    bookAuthor: '',
    bundleVersion,
    requiredMedia: ['idle_animation'],
    character: {
      characterKey: 'character:anna', name: 'Анна', fullName: 'Анна', aliases: [], gender: 'female',
      age: '', role: '', description: '', appearancePrompt: 'portrait', greeting: 'Привет', voice: 'Che',
      firstAppearanceTextOffset: 0, warmupTextOffset: 0
    }
  })

  assert.equal(animationSource, 'stored-jpeg')
  assert.deepEqual(result.assets.map(({ type }) => type), ['idle_animation'])
})

test('internal generation service stores a permanent catalog cover idempotently', async () => {
  const source = Buffer.from('plain book without an embedded cover')
  const contentSha256 = createHash('sha256').update(source).digest('hex')
  const storage = memoryStorage({ source: { bytes: source, mimeType: 'text/plain' } })
  let coverCalls = 0
  let coverCostContext
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() { throw new Error('unused') },
    async generatePortrait() { throw new Error('catalog cover must not use portrait routing') },
    async generateCover(prompt, _signal, costContext) {
      coverCalls += 1
      coverCostContext = costContext
      assert.match(prompt, /Преступление и наказание/)
      return {
        bytes: Buffer.from('cover'),
        mimeType: 'image/jpeg',
        provider: 'litellm:gpt-image-2',
        model: 'gpt-image-2'
      }
    },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const input = {
    idempotencyKey: '11111111-1111-4111-8111-111111111111:catalog-cover:catalog-cover-v4-aaaaaaaaaaaaaaaa',
    bookEditionId: '11111111-1111-4111-8111-111111111111',
    targetVersion: 'catalog-cover-v4-aaaaaaaaaaaaaaaa',
    scope: 'catalog', title: 'Преступление и наказание', author: 'Фёдор Достоевский', context: '',
    format: 'txt', contentSha256, objectKey: 'source', mimeType: 'text/plain', byteSize: source.byteLength
  }
  const first = await service.generateCatalogCover(input)
  const repeated = await service.generateCatalogCover(input)
  assert.deepEqual(repeated, first)
  assert.equal(coverCalls, 1)
  assert.deepEqual(coverCostContext, {
    bookEditionId: input.bookEditionId,
    operation: 'generate_catalog_cover',
    stage: 'cover',
    metadata: { target_version: input.targetVersion }
  })
  assert.equal(first.asset.mimeType, 'image/jpeg')
  assert.equal(first.asset.source, 'generated')
  assert.match(first.asset.objectKey, /books\/catalog\/11111111-1111-4111-8111-111111111111\/cover\/generated/)
})

test('internal generation service publishes an embedded EPUB cover without calling the image model', async () => {
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const source = Buffer.from(zipSync({
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'
    ),
    'OPS/book.opf': strToU8(
      '<package><manifest><item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest></package>'
    ),
    'OPS/cover.jpg': cover
  }))
  const contentSha256 = createHash('sha256').update(source).digest('hex')
  const storage = memoryStorage({ source: { bytes: source, mimeType: 'application/epub+zip' } })
  let coverCalls = 0
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() { throw new Error('unused') },
    async generatePortrait() { throw new Error('unused') },
    async generateCover() { coverCalls += 1; throw new Error('image model must not run') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const result = await service.generateCatalogCover({
    idempotencyKey: '11111111-1111-4111-8111-111111111111:catalog-cover:catalog-cover-v4-bbbbbbbbbbbbbbbb',
    bookEditionId: '11111111-1111-4111-8111-111111111111',
    targetVersion: 'catalog-cover-v4-bbbbbbbbbbbbbbbb',
    scope: 'catalog', title: 'Book', author: 'Author', context: '',
    format: 'epub', contentSha256, objectKey: 'source',
    mimeType: 'application/epub+zip', byteSize: source.byteLength
  })
  assert.equal(coverCalls, 0)
  assert.equal(result.asset.source, 'embedded')
  assert.equal(result.asset.mimeType, 'image/jpeg')
  assert.deepEqual(storage.objects.get(result.asset.objectKey).bytes, cover)
  assert.match(result.asset.objectKey, /\/cover\/embedded\//)
})

test('internal generation service gives the provider one scan chunk and asks for quote-only evidence', async () => {
  const storage = memoryStorage()
  let chatRequest
  const contextText = ' Анна вошла в комнату. '
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat(input) {
      chatRequest = input
      const quote = 'Анна вошла в комнату.'
      return JSON.stringify({
        observations: [{
          type: 'character_action',
          entityKind: 'character',
          entityCandidate: 'Анна',
          relatedEntityCandidates: [],
          fact: 'Анна вошла в комнату',
          evidence: { quote },
          confidence: 0.95
        }]
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const result = await service.scanBookChunk({
    idempotencyKey: 'run-1:scan:chunk-1:book-scan-v1',
    runId: 'run-1',
    chunkId: 'chunk-1',
    extractorVersion: 'book-scan-v1',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    sectionTitles: ['PREFACE.'],
    contextText,
    coreLocalStartOffset: 1,
    coreLocalEndOffset: contextText.length - 1
  })
  assert.equal(result.observations.length, 1)
  assert.equal(Object.hasOwn(chatRequest, 'temperature'), false)
  assert.equal(chatRequest.messages.length, 2)
  assert.ok(chatRequest.messages[0].content.includes(
    'цитата начинается внутри CORE_LOCAL_RANGE'
  ))
  assert.equal(chatRequest.messages[0].content.includes('startOffset'), false)
  assert.equal(chatRequest.messages[0].content.includes('endOffset'), false)
  assert.ok(chatRequest.messages[0].content.includes(
    'текст за пределами диапазона используй только как контекст'
  ))
  assert.ok(chatRequest.messages[0].content.includes(
    'Последовательно просмотри весь CORE_LOCAL_RANGE от начала до конца'
  ))
  assert.ok(chatRequest.messages[1].content.includes(contextText))
  assert.ok(chatRequest.messages[1].content.includes(
    `CORE_LOCAL_RANGE: 1-${contextText.length - 1}`
  ))
  assert.ok(chatRequest.messages[1].content.includes('SECTION_TITLES: PREFACE.'))
  assert.match(chatRequest.messages[0].content, /title page, contents, preface, introduction/i)
  assert.match(chatRequest.messages[0].content, /said the Voice\. I am an invisible man/i)
  assert.match(chatRequest.messages[0].content, /\u043eдной непрерывной evidence\.quote/i)
  assert.match(chatRequest.messages[0].content, /\u043fодпись письма/i)
  assert.match(chatRequest.messages[0].content, /каждого самостоятельного участника/i)
  assert.match(
    chatRequest.messages[0].content,
    /животных.*персонифицированных существ/i
  )
  assert.match(
    chatRequest.messages[0].content,
    /фоновых животных.*без самостоятельного действия/i
  )
  assert.equal(chatRequest.messages[1].content.includes('objectKey'), false)
  assert.equal(chatRequest.messages[1].content.includes('normalized'), false)
  assert.deepEqual(result.observations[0].evidence, {
    quote: 'Анна вошла в комнату.',
    startOffset: contextText.indexOf('Анна'),
    endOffset: contextText.indexOf('Анна') + 'Анна вошла в комнату.'.length
  })
})

test('internal generation service resolves a repeated quote when only one occurrence belongs to the core', async () => {
  const storage = memoryStorage()
  const quote = 'Анна вошла.'
  const contextText = `${quote} Контекст слева. ${quote} Затем она села.`
  const coreStart = contextText.lastIndexOf(quote)
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна вошла',
        evidence: { quote },
        confidence: 0.95
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  const result = await service.scanBookChunk({
    idempotencyKey: 'run-core-quote:scan:chunk-core-quote:book-scan-v10',
    runId: 'run-core-quote',
    chunkId: 'chunk-core-quote',
    extractorVersion: 'book-scan-v10',
    bookTitle: 'Книга',
    bookAuthor: '',
    contextText,
    coreLocalStartOffset: coreStart,
    coreLocalEndOffset: contextText.length
  })

  assert.deepEqual(result.observations[0].evidence, {
    quote,
    startOffset: coreStart,
    endOffset: coreStart + quote.length
  })
})

test('internal generation service maps model-collapsed whitespace back to the exact source quote', async () => {
  const storage = memoryStorage()
  const contextText = '🙂 Анна\nвошла   в комнату. Потом села.'
  const providerQuote = 'Анна вошла в комнату.'
  const sourceQuote = 'Анна\nвошла   в комнату.'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна вошла в комнату',
        evidence: { quote: providerQuote },
        confidence: 0.95
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  const result = await service.scanBookChunk({
    idempotencyKey: 'run-whitespace:scan:chunk-whitespace:book-scan-v10',
    runId: 'run-whitespace',
    chunkId: 'chunk-whitespace',
    extractorVersion: 'book-scan-v10',
    bookTitle: 'Книга',
    bookAuthor: '',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  })

  assert.deepEqual(result.observations[0].evidence, {
    quote: sourceQuote,
    startOffset: contextText.indexOf(sourceQuote),
    endOffset: contextText.indexOf(sourceQuote) + sourceQuote.length
  })
})

test('internal generation service repairs wrong offsets for one exact quote match', async () => {
  const storage = memoryStorage()
  const contextText = ' Анна вошла в комнату. '
  const quote = 'Анна вошла в комнату.'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна вошла в комнату',
        evidence: { quote, startOffset: 0, endOffset: quote.length },
        confidence: 0.95
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const result = await service.scanBookChunk({
    idempotencyKey: 'run-repair:scan:chunk-repair:book-scan-v1',
    runId: 'run-repair',
    chunkId: 'chunk-repair',
    extractorVersion: 'book-scan-v1',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    contextText,
    coreLocalStartOffset: 1,
    coreLocalEndOffset: contextText.length - 1
  })
  assert.deepEqual(result.observations[0].evidence, {
    quote,
    startOffset: contextText.indexOf(quote),
    endOffset: contextText.indexOf(quote) + quote.length
  })
})

test('internal generation service drops an author copied only from front matter', async () => {
  const storage = memoryStorage()
  const contextText = 'Медный всадник\nАлександр Пушкин'
  const quote = 'Александр Пушкин'
  const startOffset = contextText.indexOf(quote)
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'character_mention',
        entityKind: 'character',
        entityCandidate: 'Александр Пушкин',
        relatedEntityCandidates: [],
        fact: 'На титульной странице указан Александр Пушкин',
        evidence: { quote, startOffset, endOffset: startOffset + quote.length },
        confidence: 1
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  await assert.rejects(() => service.scanBookChunk({
    idempotencyKey: 'run-author:scan:chunk-author:book-scan-v5',
    runId: 'run-author',
    chunkId: 'chunk-author',
    extractorVersion: 'book-scan-v5',
    bookTitle: 'Медный всадник',
    bookAuthor: 'Александр Пушкин',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  }), (error) => error.code === 'EVIDENCE_MISMATCH')
})

test('internal generation service derives character observations for grounded relationship participants', async () => {
  const storage = memoryStorage()
  const contextText = 'Евгений думает: И в нём Парашу успокою'
  const quote = 'И в нём Парашу успокою'
  const startOffset = contextText.indexOf(quote)
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'relationship',
        entityKind: 'relationship',
        entityCandidate: 'Евгений и Параша',
        relatedEntityCandidates: ['Евгений', 'Параша'],
        fact: 'Евгений хочет успокоить Парашу',
        evidence: { quote, startOffset, endOffset: startOffset + quote.length },
        confidence: 0.98
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  const result = await service.scanBookChunk({
    idempotencyKey: 'run-relation:scan:chunk-relation:book-scan-v5',
    runId: 'run-relation',
    chunkId: 'chunk-relation',
    extractorVersion: 'book-scan-v5',
    bookTitle: 'Медный всадник',
    bookAuthor: 'Александр Пушкин',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  })
  assert.deepEqual(result.observations.map(({ type, entityCandidate }) => ({
    type,
    entityCandidate
  })), [{
    type: 'relationship',
    entityCandidate: 'Евгений и Параша'
  }, {
    type: 'character_mention',
    entityCandidate: 'Евгений'
  }, {
    type: 'character_mention',
    entityCandidate: 'Параша'
  }])
  assert.ok(result.observations.every((observation) => observation.evidence.quote === quote))
})

test('internal generation service adaptively splits only a semantically rejected scan range', async () => {
  const storage = memoryStorage()
  const firstQuote = 'Анна вошла в комнату.'
  const secondQuote = 'Борис вышел во двор.'
  const contextText = `${'Начало. '.repeat(160)}${firstQuote}${' Середина.'.repeat(220)}${secondQuote}${' Конец.'.repeat(120)}`
  let chatCalls = 0
  const requestedTexts = []
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat(input) {
      chatCalls += 1
      const content = input.messages[1].content
      const requestedText = content
        .slice(content.indexOf('CONTEXT_TEXT_BEGIN') + 'CONTEXT_TEXT_BEGIN\n'.length)
        .split('\nCONTEXT_TEXT_END')[0]
      requestedTexts.push(requestedText)
      if (chatCalls === 1) {
        return JSON.stringify({ observations: [{
          type: 'character_action',
          entityKind: 'character',
          entityCandidate: 'Анна',
          relatedEntityCandidates: [],
          fact: 'Неподтверждённое действие',
          evidence: { quote: 'Такой цитаты в книге нет.' },
          confidence: 0.9
        }] })
      }
      const quote = requestedText.includes(firstQuote) ? firstQuote : secondQuote
      const entityCandidate = quote === firstQuote ? 'Анна' : 'Борис'
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate,
        relatedEntityCandidates: [],
        fact: `${entityCandidate} совершает действие`,
        evidence: { quote },
        confidence: 0.95
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  const result = await service.scanBookChunk({
    idempotencyKey: 'run-adaptive:scan:chunk-adaptive:book-scan-v10',
    runId: 'run-adaptive',
    chunkId: 'chunk-adaptive',
    extractorVersion: 'book-scan-v10',
    bookTitle: 'Книга',
    bookAuthor: '',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  })

  assert.equal(chatCalls, 3)
  assert.equal(requestedTexts[0], contextText)
  assert.ok(requestedTexts[1].length < contextText.length)
  assert.ok(requestedTexts[2].length < contextText.length)
  assert.deepEqual(result.observations.map(({ entityCandidate }) => entityCandidate).sort(), [
    'Анна', 'Борис'
  ])
  for (const observation of result.observations) {
    assert.equal(
      contextText.slice(observation.evidence.startOffset, observation.evidence.endOffset),
      observation.evidence.quote
    )
  }
})

test('internal generation service retries a scan when evidence filtering drops most provider observations', async () => {
  const storage = memoryStorage()
  const contextText = 'Анна вошла в комнату.'
  const validQuote = 'Анна вошла в комнату.'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [
        {
          type: 'character_action',
          entityKind: 'character',
          entityCandidate: 'Анна',
          relatedEntityCandidates: [],
          fact: 'Анна вошла в комнату',
          evidence: { quote: validQuote, startOffset: 0, endOffset: validQuote.length },
          confidence: 0.95
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          type: 'character_trait',
          entityKind: 'character',
          entityCandidate: 'Анна',
          relatedEntityCandidates: [],
          fact: `Неподтверждённый факт ${index}`,
          evidence: { quote: `выдуманная цитата ${index}`, startOffset: 0, endOffset: 5 },
          confidence: 0.9
        }))
      ] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  await assert.rejects(() => service.scanBookChunk({
    idempotencyKey: 'run-lossy:scan:chunk-lossy:book-scan-v10',
    runId: 'run-lossy',
    chunkId: 'chunk-lossy',
    extractorVersion: 'book-scan-v10',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  }), (error) => error.code === 'EVIDENCE_MISMATCH')
  assert.equal(storage.objects.size, 0)
})

test('internal generation service keeps grounded observations and drops invented evidence', async () => {
  const storage = memoryStorage()
  const lines = []
  let chatCalls = 0
  const contextText = 'ПРЕФИКС Анна вошла в комнату. ХВОСТ'
  const quote = 'Анна вошла в комнату.'
  const service = createInternalGenerationService({
    storage,
    logger: {
      info(line) { lines.push(line) },
      warn(line) { lines.push(line) },
      error(line) { lines.push(line) }
    },
    async completeChat() {
      chatCalls += 1
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна вошла в комнату',
        evidence: { quote, startOffset: 0, endOffset: quote.length },
        confidence: 0.95
      }, {
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна убежала',
        evidence: { quote: 'Анна убежала.', startOffset: 0, endOffset: 14 },
        confidence: 0.8
      }, {
        type: 'unknown_fact',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Неподдерживаемый тип',
        evidence: { quote, startOffset: 7, endOffset: 7 + quote.length },
        confidence: 0.7
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: 'run-mixed:scan:chunk-mixed:book-scan-v4',
    runId: 'run-mixed',
    chunkId: 'chunk-mixed',
    extractorVersion: 'book-scan-v4',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    contextText,
    coreLocalStartOffset: 7,
    coreLocalEndOffset: contextText.length
  }
  const first = await service.scanBookChunk(request)
  const second = await service.scanBookChunk(request)
  assert.deepEqual(second, first)
  assert.equal(chatCalls, 1)
  assert.equal(first.observations.length, 1)
  assert.deepEqual(first.observations[0].evidence, {
    quote,
    startOffset: contextText.indexOf(quote),
    endOffset: contextText.indexOf(quote) + quote.length
  })
  assert.ok(lines.some((line) =>
    line.includes('event="scan.llm_completed"') &&
    line.includes('provider_observation_count=3') &&
    line.includes('accepted_observation_count=1') &&
    line.includes('repaired_observation_count=1') &&
    line.includes('dropped_observation_count=2')
  ))
  assert.equal(lines.some((line) => line.includes('Анна убежала')), false)
})

test('internal generation service rejects offset repair for an ambiguous exact quote', async () => {
  const storage = memoryStorage()
  const contextText = 'Анна вошла. Потом Анна вошла.'
  const quote = 'Анна вошла.'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна вошла',
        evidence: { quote, startOffset: 1, endOffset: quote.length + 1 },
        confidence: 0.9
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  await assert.rejects(() => service.scanBookChunk({
    idempotencyKey: 'run-ambiguous:scan:chunk-ambiguous:book-scan-v1',
    runId: 'run-ambiguous',
    chunkId: 'chunk-ambiguous',
    extractorVersion: 'book-scan-v1',
    bookTitle: 'Книга',
    bookAuthor: '',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  }), (error) => error.code === 'EVIDENCE_MISMATCH')
  assert.equal(storage.objects.size, 0)
})

test('internal generation service treats overlapping quote occurrences as ambiguous', async () => {
  const storage = memoryStorage()
  const contextText = 'ааа'
  const quote = 'аа'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ observations: [{
        type: 'character_dialogue',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна произносит звук',
        evidence: { quote },
        confidence: 0.8
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })

  await assert.rejects(() => service.scanBookChunk({
    idempotencyKey: 'run-overlap-quote:scan:chunk-overlap-quote:book-scan-v10',
    runId: 'run-overlap-quote',
    chunkId: 'chunk-overlap-quote',
    extractorVersion: 'book-scan-v10',
    bookTitle: 'Книга',
    bookAuthor: '',
    contextText,
    coreLocalStartOffset: 0,
    coreLocalEndOffset: contextText.length
  }), (error) => error.code === 'EVIDENCE_MISMATCH')
})

test('internal generation service does not cache an ungrounded scan result', async () => {
  const storage = memoryStorage()
  let chatCalls = 0
  const lines = []
  const contextText = ' Анна вошла. '
  const service = createInternalGenerationService({
    storage,
    logger: {
      info(line) { lines.push(line) },
      warn(line) { lines.push(line) },
      error(line) { lines.push(line) }
    },
    async completeChat() {
      chatCalls += 1
      return JSON.stringify({ observations: [{
        type: 'character_action',
        entityKind: 'character',
        entityCandidate: 'Анна',
        relatedEntityCandidates: [],
        fact: 'Анна убежала',
        evidence: { quote: 'Анна убежала.', startOffset: 1, endOffset: 5 },
        confidence: 0.9
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: 'run-2:scan:chunk-2:book-scan-v1',
    runId: 'run-2',
    chunkId: 'chunk-2',
    extractorVersion: 'book-scan-v1',
    bookTitle: 'Книга',
    bookAuthor: '',
    contextText,
    coreLocalStartOffset: 1,
    coreLocalEndOffset: contextText.length - 1
  }
  await assert.rejects(() => service.scanBookChunk(request), (error) =>
    error.code === 'EVIDENCE_MISMATCH'
  )
  await assert.rejects(() => service.scanBookChunk(request), (error) =>
    error.code === 'EVIDENCE_MISMATCH'
  )
  assert.equal(chatCalls, 2)
  assert.equal(storage.objects.size, 0)
  assert.equal(lines.filter((line) => line.includes('event="scan.llm_rejected"')).length, 2)
  assert.ok(lines.every((line) => !line.includes('Анна убежала')))
})

test('internal generation service attributes only known TTS atoms to known characters', async () => {
  const storage = memoryStorage()
  let chatRequest
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat(input) {
      chatRequest = input
      return JSON.stringify({ assignments: [{
        atomId: 'tts:0:1', characterKey: 'character:ivan', confidence: 0.94
      }] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const result = await service.generateBookTtsMarkup({
    idempotencyKey: 'publication-1:tts:publication-1:0:0:book-tts-script-v1',
    bookEditionId: 'book-1', sourcePublicationId: 'publication-1',
    normalizedTextHash: 'a'.repeat(64), markupVersion: 'book-tts-script-v1',
    requestId: 'publication-1:0:0', bookTitle: 'Книга', bookAuthor: 'Автор',
    section: { key: 'chapter-1', index: 0 },
    characters: [{
      characterKey: 'character:ivan', name: 'Иван', fullName: 'Иван', aliases: []
    }],
    coreAtoms: [{
      atomId: 'tts:0:1', kind: 'speech', text: '— Привет.', startOffset: 0, endOffset: 9
    }],
    contextAtoms: [{ atomId: 'tts:0:1', kind: 'speech', text: '— Привет.' }]
  })
  assert.deepEqual(result, { assignments: [{
    atomId: 'tts:0:1', characterKey: 'character:ivan', confidence: 0.94
  }] })
  assert.match(chatRequest.messages[0].content, /только characterKey из CHARACTERS/)
})

test('internal generation service turns invalid provider TTS identities into abstentions', async () => {
  const service = createInternalGenerationService({
    storage: memoryStorage(),
    logger: { info() {}, error() {} },
    async completeChat() {
      return JSON.stringify({ assignments: [
        { atomId: 'invented', characterKey: 'character:ivan', confidence: 1 },
        { atomId: 'tts:0:1', characterKey: 'character:ghost', confidence: 0.9 }
      ] })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const result = await service.generateBookTtsMarkup({
    idempotencyKey: 'publication-1:tts:provider-abstention:book-tts-script-v1',
    bookEditionId: 'book-1', sourcePublicationId: 'publication-1',
    normalizedTextHash: 'a'.repeat(64), markupVersion: 'book-tts-script-v1',
    requestId: 'provider-abstention', bookTitle: 'Книга', bookAuthor: 'Автор',
    section: { key: 'chapter-1', index: 0 },
    characters: [{
      characterKey: 'character:ivan', name: 'Иван', fullName: 'Иван', aliases: []
    }],
    coreAtoms: [
      { atomId: 'tts:0:1', kind: 'speech', text: '— Привет.', startOffset: 0, endOffset: 9 },
      { atomId: 'tts:0:2', kind: 'speech', text: '— Кто ты?', startOffset: 10, endOffset: 18 }
    ],
    contextAtoms: [{ atomId: 'tts:0:1', kind: 'speech', text: '— Привет.' }]
  })
  assert.deepEqual(result, { assignments: [
    { atomId: 'tts:0:1', characterKey: null, confidence: 0 },
    { atomId: 'tts:0:2', characterKey: null, confidence: 0 }
  ] })
})

test('internal generation service reconciles only existing identity keys idempotently', async () => {
  const storage = memoryStorage()
  let chatCalls = 0
  let chatRequest
  const leftEvidence = '11111111-1111-4111-8111-111111111111'
  const rightEvidence = '22222222-2222-4222-8222-222222222222'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat(input) {
      chatCalls += 1
      chatRequest = input
      return JSON.stringify({
        merges: [{
          leftEntityKey: 'character:elizabeth',
          rightEntityKey: 'character:lizzy',
          basis: 'nickname',
          evidenceIds: [leftEvidence, rightEvidence]
        }, {
          leftEntityKey: 'character:invented',
          rightEntityKey: 'character:lizzy',
          basis: 'nickname',
          evidenceIds: [rightEvidence]
        }]
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const observationSetHash = 'a'.repeat(64)
  const request = {
    idempotencyKey: `run-1:identity:book-analysis-v25:character-identity-v6:${observationSetHash}`,
    runId: 'run-1',
    bookEditionId: 'book-1',
    pipelineVersion: 'book-analysis-v25',
    reconciliationVersion: 'character-identity-v6',
    observationSetHash,
    bookTitle: 'Pride and Prejudice',
    bookAuthor: 'Jane Austen',
    roster: [{
      entityKey: 'character:elizabeth',
      names: ['Elizabeth'],
      resolutionStatus: 'confirmed',
      observationCount: 1,
      evidence: [{
        id: leftEvidence,
        type: 'character_mention',
        fact: 'Elizabeth appears',
        quote: 'Elizabeth entered the room.',
        startOffset: 100
      }]
    }, {
      entityKey: 'character:lizzy',
      names: ['Lizzy'],
      resolutionStatus: 'confirmed',
      observationCount: 1,
      evidence: [{
        id: rightEvidence,
        type: 'character_mention',
        fact: 'Lizzy answers',
        quote: 'Lizzy answered her father.',
        startOffset: 1_000
      }]
    }],
    candidatePairs: [{
      leftEntityKey: 'character:elizabeth',
      rightEntityKey: 'character:lizzy',
      signals: ['scan_alias_claim']
    }],
    forbiddenPairs: []
  }
  const first = await service.reconcileBookCharacterIdentities(request)
  const second = await service.reconcileBookCharacterIdentities(request)
  assert.deepEqual(second, first)
  assert.equal(chatCalls, 1)
  assert.equal(first.providerMergeCount, 2)
  assert.equal(first.merges.length, 1)
  assert.equal(first.droppedMergeCount, 1)
  assert.match(chatRequest.messages[0].content, /Не создавай имена, aliases или entityKey/)
  assert.match(chatRequest.messages[0].content, /совместимы ровно с одной полной формой/)
  assert.match(chatRequest.messages[0].content, /Для married_name активно ищи/)
  assert.match(chatRequest.messages[0].content, /При сомнении не добавляй merge/)
})

test('internal generation service builds a grounded profile for one resolved character', async () => {
  const storage = memoryStorage()
  let chatCalls = 0
  let chatRequest
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, error() {} },
    async completeChat(input) {
      chatCalls += 1
      chatRequest = input
      return JSON.stringify({
        role: {
          value: 'Врач',
          evidenceIds: ['22222222-2222-4222-8222-222222222222'],
          confidence: 0.96
        },
        creative: { greeting: 'Hello. I am Anna.', appearancePrompt: 'Портрет Анны', voice: 'Che' }
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: 'run-1:synthesize:snapshot-1:character:anna:character-profile-v3',
    runId: 'run-1',
    snapshotId: 'snapshot-1',
    synthesisVersion: 'character-profile-v3',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    textLength: 1_000,
    entity: {
      entityKey: 'character:anna',
      entityKind: 'character',
      canonicalName: 'Анна',
      aliases: ['Аня'],
      resolutionStatus: 'confirmed',
      confidence: 0.95,
      evidenceIds: ['22222222-2222-4222-8222-222222222222'],
      data: { firstEvidenceStartOffset: 100 }
    },
    evidence: [{
      id: '22222222-2222-4222-8222-222222222222',
      type: 'character_role',
      fact: 'Анна работает врачом',
      quote: 'Анна — врач',
      startOffset: 100,
      endOffset: 111,
      confidence: 0.96
    }]
  }
  const first = await service.synthesizeCharacterProfile(request)
  const second = await service.synthesizeCharacterProfile(request)
  assert.deepEqual(second, first)
  assert.equal(chatCalls, 1)
  assert.equal(Object.hasOwn(chatRequest, 'temperature'), false)
  assert.match(chatRequest.messages[0].content, /приветствие.*1.?2 предложения/i)
  assert.match(chatRequest.messages[0].content, /без спойлеров/i)
  assert.match(chatRequest.messages[0].content, /description — обязательное краткое описание/i)
  assert.match(chatRequest.messages[0].content, /при двух и более содержательных EVIDENCE/i)
  assert.match(chatRequest.messages[0].content, /traits — от 0 до 8 кандидатов/i)
  assert.match(chatRequest.messages[0].content, /\[\] — обязательный результат/i)
  assert.match(chatRequest.messages[0].content, /проверь общие независимые оси/i)
  assert.match(chatRequest.messages[0].content, /шестью и более поведенческими наблюдениями/i)
  assert.match(chatRequest.messages[0].content, /Не включай состояние или эмоцию.*внешность, возраст, одежду/i)
  assert.match(chatRequest.messages[1].content, /BOOK_LANGUAGE: ru/)
  assert.equal(first.profile.characterKey, 'character:anna')
  assert.equal(first.profile.name, 'Анна')
  assert.equal(first.profile.role.value, 'Врач')
  assert.equal(first.profile.creative.greeting, 'Здравствуйте. Я Анна.')
  assert.deepEqual(first.profile.role.evidenceIds, request.entity.evidenceIds)
})

test('internal generation service keeps compatible profile claims and drops only incompatible ones', async () => {
  const storage = memoryStorage()
  const lines = []
  let chatCalls = 0
  const roleEvidenceId = '22222222-2222-4222-8222-222222222223'
  const actionEvidenceId = '33333333-3333-4333-8333-333333333334'
  const service = createInternalGenerationService({
    storage,
    logger: {
      info(line) { lines.push(line) },
      warn(line) { lines.push(line) },
      error(line) { lines.push(line) }
    },
    async completeChat() {
      chatCalls += 1
      return JSON.stringify({
        role: {
          value: 'Врач',
          evidenceIds: [roleEvidenceId],
          confidence: 0.96
        },
        traits: [{
          value: 'Смелая',
          evidenceIds: [actionEvidenceId],
          confidence: 0.8
        }, {
          value: 'Несуществующее доказательство',
          evidenceIds: ['44444444-4444-4444-8444-444444444445'],
          confidence: 0.7
        }],
        appearance: [{ value: '', evidenceIds: [roleEvidenceId], confidence: 0.4 }],
        creative: { greeting: 'Здравствуйте.', appearancePrompt: 'Портрет Анны', voice: 'Che' }
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const request = {
    idempotencyKey: 'run-2:synthesize:snapshot-2:character:anna:character-profile-v3',
    runId: 'run-2',
    snapshotId: 'snapshot-2',
    synthesisVersion: 'character-profile-v3',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    textLength: 1_000,
    entity: {
      entityKey: 'character:anna',
      entityKind: 'character',
      canonicalName: 'Анна',
      aliases: [],
      resolutionStatus: 'confirmed',
      confidence: 0.95,
      evidenceIds: [roleEvidenceId, actionEvidenceId],
      data: { firstEvidenceStartOffset: 100 }
    },
    evidence: [{
      id: roleEvidenceId,
      type: 'character_role',
      fact: 'Анна работает врачом',
      quote: 'Анна — врач',
      startOffset: 100,
      endOffset: 111,
      confidence: 0.96
    }, {
      id: actionEvidenceId,
      type: 'character_action',
      fact: 'Анна вошла',
      quote: 'Анна вошла',
      startOffset: 200,
      endOffset: 211,
      confidence: 0.9
    }]
  }
  const first = await service.synthesizeCharacterProfile(request)
  const second = await service.synthesizeCharacterProfile(request)
  assert.deepEqual(second, first)
  assert.equal(chatCalls, 1)
  assert.equal(first.profile.role.value, 'Врач')
  assert.equal(first.profile.description.value, 'Анна работает врачом. Анна вошла.')
  assert.deepEqual(first.profile.description.evidenceIds, [roleEvidenceId, actionEvidenceId])
  assert.deepEqual(first.profile.traits, [])
  assert.deepEqual(first.profile.appearance, [])
  assert.equal(first.profile.creative.voice, 'Erm')
  assert.ok(lines.some((line) =>
    line.includes('event="synthesis.character_completed"') &&
    line.includes('provider_claim_count=4') &&
    line.includes('accepted_claim_count=1') &&
    line.includes('dropped_claim_count=3')
  ))
  assert.equal(lines.some((line) => line.includes('Смелая')), false)
})

test('current profile synthesis audits traits and rewrites description from cited evidence only', async () => {
  const storage = memoryStorage()
  const firstActionId = '31313131-3131-4131-8131-313131313131'
  const secondActionId = '32323232-3232-4232-8232-323232323232'
  const episodicTraitId = '33333333-3333-4333-8333-333333333333'
  const appearanceId = '34343434-3434-4434-8434-343434343434'
  const calls = []
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat(input) {
      calls.push(input)
      if (calls.length === 1) {
        return JSON.stringify({
          description: {
            value: 'Anna repeatedly helps people and is a famous heiress.',
            evidenceIds: [firstActionId, secondActionId],
            confidence: 0.91
          },
          traits: [{
            value: 'generous',
            evidenceIds: [firstActionId, secondActionId, appearanceId],
            confidence: 0.92
          }, {
            value: 'fastidious',
            evidenceIds: [episodicTraitId],
            confidence: 0.9
          }],
          personalitySnapshots: [{
            cutoffTextOffset: 140,
            traits: [{
              value: 'generous', evidenceIds: [firstActionId], confidence: 0.7
            }]
          }, {
            cutoffTextOffset: 7_060,
            traits: [{
              value: 'generous',
              evidenceIds: [firstActionId, secondActionId],
              confidence: 0.86
            }]
          }],
          creative: { greeting: 'Hello.', appearancePrompt: '', voice: 'Erm' }
        })
      }
      if (calls.length === 2) {
        return JSON.stringify({
          traits: [{
            value: 'generous',
            evidenceIds: [firstActionId],
            confidence: 0.96
          }]
        })
      }
      return JSON.stringify({
        traits: [{ index: 0, evidenceIds: [firstActionId, secondActionId, appearanceId] }],
        description: {
          value: 'Anna repeatedly helps people in need.',
          evidenceIds: [firstActionId, secondActionId]
        }
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const evidence = [{
    id: firstActionId,
    type: 'character_action',
    fact: 'Anna gives food to a hungry child',
    quote: 'Anna gave the hungry child her supper.',
    startOffset: 100,
    endOffset: 140,
    confidence: 0.94
  }, {
    id: secondActionId,
    type: 'character_action',
    fact: 'Anna pays a stranger’s fare home',
    quote: 'Anna quietly paid the stranger’s fare home.',
    startOffset: 4_000,
    endOffset: 4_050,
    confidence: 0.93
  }, {
    id: episodicTraitId,
    type: 'character_trait',
    fact: 'Anna arranges one place setting fastidiously',
    quote: 'Anna arranged the spoons fastidiously and sat down.',
    startOffset: 7_000,
    endOffset: 7_060,
    confidence: 0.91
  }, {
    id: appearanceId,
    type: 'character_appearance',
    fact: 'Anna has dark hair',
    quote: 'Anna had dark hair.',
    startOffset: 8_000,
    endOffset: 8_020,
    confidence: 0.96
  }]
  const result = await service.synthesizeCharacterProfile({
    idempotencyKey: 'run-audit:synthesize:snapshot-audit:character:anna:character-profile-v14',
    runId: 'run-audit',
    snapshotId: 'snapshot-audit',
    synthesisVersion: 'character-profile-v14',
    bookTitle: 'The Book',
    bookAuthor: 'An Author',
    textLength: 10_000,
    entity: {
      entityKey: 'character:anna',
      entityKind: 'character',
      canonicalName: 'Anna',
      aliases: [],
      resolutionStatus: 'confirmed',
      confidence: 0.96,
      evidenceIds: evidence.map(({ id }) => id),
      data: { firstEvidenceStartOffset: 100 }
    },
    evidence
  })
  assert.equal(calls.length, 3)
  assert.match(calls[1].messages[0].content, /recall-экстрактор/i)
  assert.match(calls[2].messages[0].content, /строгий независимый аудитор/i)
  assert.match(calls[2].messages[0].content, /good-natured grumble/i)
  assert.match(calls[2].messages[0].content, /слух, лесть, оскорбление, метафора/i)
  assert.deepEqual(result.profile.traits.map(({ value }) => value), ['generous'])
  assert.deepEqual(result.profile.traits[0].evidenceIds, [firstActionId, secondActionId])
  assert.equal(result.profile.description.value, 'Anna repeatedly helps people in need.')
  assert.deepEqual(result.profile.description.evidenceIds, [firstActionId, secondActionId])
  assert.deepEqual(result.profile.personalitySnapshots.map(({ cutoffTextOffset, status }) => ({
    cutoffTextOffset,
    status
  })), [{
    cutoffTextOffset: 140,
    status: 'preliminary'
  }, {
    cutoffTextOffset: 7_060,
    status: 'supported'
  }])
  assert.equal(result.profile.personalityTimelineVersion, 'progressive-personality-v1')
})

test('invalid primary personality timeline falls back to sequential checkpoint synthesis', async () => {
  const storage = memoryStorage()
  const ids = [
    '61616161-6161-4161-8161-616161616161',
    '62626262-6262-4262-8262-626262626262',
    '63636363-6363-4363-8363-636363636363'
  ]
  const calls = []
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat(input) {
      calls.push(input)
      if (calls.length === 1) {
        return JSON.stringify({
          traits: [],
          personalitySnapshots: [{
            cutoffTextOffset: 120,
            traits: [{ value: 'смелый', evidenceIds: [ids[2]], confidence: 0.9 }]
          }, { cutoffTextOffset: 320, traits: [] }],
          creative: { greeting: 'Здравствуйте.', appearancePrompt: '', voice: 'Erm' }
        })
      }
      if (calls.length === 2) return JSON.stringify({ traits: [] })
      if (calls.length === 3) return JSON.stringify({ traits: [], description: null })
      if (calls.length === 4) {
        return JSON.stringify({
          traits: [{ value: 'решительный', evidenceIds: [ids[0]], confidence: 0.8 }]
        })
      }
      return JSON.stringify({
        traits: [{
          value: 'решительный', evidenceIds: [ids[0], ids[2]], confidence: 0.9
        }]
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const evidence = ids.map((id, index) => ({
    id,
    type: 'character_action',
    fact: `Поступок ${index + 1}`,
    quote: `Герой совершил поступок ${index + 1}.`,
    startOffset: index * 100 + 80,
    endOffset: index * 100 + 120,
    confidence: 0.9
  }))

  const result = await service.synthesizeCharacterProfile({
    idempotencyKey: 'run-fallback:synthesize:snapshot-fallback:character:hero:character-profile-v14',
    runId: 'run-fallback',
    snapshotId: 'snapshot-fallback',
    synthesisVersion: 'character-profile-v14',
    bookTitle: 'Книга',
    bookAuthor: 'Автор',
    textLength: 1_000,
    entity: {
      entityKey: 'character:hero',
      entityKind: 'character',
      canonicalName: 'Герой',
      aliases: [],
      resolutionStatus: 'confirmed',
      confidence: 0.9,
      evidenceIds: ids,
      data: { firstEvidenceStartOffset: 80 }
    },
    evidence
  })

  assert.equal(calls.length, 5)
  assert.match(calls[3].messages[0].content, /fallback.*контрольной точки/i)
  assert.match(calls[3].messages[1].content, /PREVIOUS_SNAPSHOT: \{\}/)
  assert.match(calls[4].messages[1].content, /PREVIOUS_SNAPSHOT:.*решительный/)
  assert.deepEqual(result.profile.personalitySnapshots, [{
    cutoffTextOffset: 120,
    status: 'preliminary',
    traits: [{
      value: 'решительный', evidenceIds: [ids[0]], confidence: 0.65,
      evidenceLevel: 'single_scene'
    }]
  }, {
    cutoffTextOffset: 320,
    status: 'preliminary',
    traits: [{
      value: 'решительный', evidenceIds: [ids[0], ids[2]], confidence: 0.82,
      evidenceLevel: 'repeated'
    }]
  }])
})

test('extractive profile description fallback is deterministic and accepts one grounded fact', () => {
  const evidence = [{
    id: 'e-2', type: 'character_action', fact: 'Анна помогла соседке', startOffset: 200,
    confidence: 0.91
  }, {
    id: 'e-1', type: 'character_trait', fact: 'Анна терпелива.', startOffset: 100,
    confidence: 0.96
  }, {
    id: 'e-3', type: 'character_gender', fact: 'female', startOffset: 50,
    confidence: 0.99
  }]
  assert.deepEqual(fallbackProfileDescription(evidence), {
    value: 'Анна терпелива. Анна помогла соседке.',
    evidenceIds: ['e-1', 'e-2'],
    confidence: 0.91
  })
  assert.deepEqual(fallbackProfileDescription(evidence.slice(0, 1)), {
    value: 'Анна помогла соседке.',
    evidenceIds: ['e-2'],
    confidence: 0.91
  })
  assert.deepEqual(fallbackProfileDescription(evidence.slice(2)), {
    value: 'Персонаж женского пола.',
    evidenceIds: ['e-3'],
    confidence: 0.99
  })
})

test('profile synthesis derives normalized gender and stable traits from grounded behavior evidence', async () => {
  const storage = memoryStorage()
  let chatRequest
  const dialogueEvidenceId = '55555555-5555-4555-8555-555555555551'
  const actionEvidenceId = '55555555-5555-4555-8555-555555555552'
  const secondActionEvidenceId = '55555555-5555-4555-8555-555555555553'
  const service = createInternalGenerationService({
    storage,
    logger: { info() {}, warn() {}, error() {} },
    async completeChat(input) {
      chatRequest = input
      return JSON.stringify({
        gender: {
          value: 'женщина',
          evidenceIds: [dialogueEvidenceId],
          confidence: 0.96
        },
        traits: [{
          value: 'Заботливая',
          evidenceIds: [actionEvidenceId, secondActionEvidenceId],
          confidence: 0.84
        }],
        creative: { greeting: 'Здравствуйте.', appearancePrompt: '', voice: 'She' }
      })
    },
    async generatePortrait() { throw new Error('unused') },
    async synthesizeSpeech() { throw new Error('unused') },
    async generateIdleAnimation() { throw new Error('unused') }
  })
  const entity = {
    entityKey: 'character:babushka',
    entityKind: 'character',
    canonicalName: 'Бабушка',
    aliases: [],
    resolutionStatus: 'confirmed',
    confidence: 0.97,
    evidenceIds: [dialogueEvidenceId, actionEvidenceId, secondActionEvidenceId],
    data: { firstEvidenceStartOffset: 100 }
  }
  const evidence = [{
    id: dialogueEvidenceId,
    type: 'character_dialogue',
    fact: 'Бабушка сказала, что она придёт',
    quote: 'Бабушка сказала, что она придёт.',
    startOffset: 100,
    endOffset: 135,
    confidence: 0.96
  }, {
    id: actionEvidenceId,
    type: 'character_action',
    fact: 'Бабушка успокоила ребёнка',
    quote: 'Бабушка успокоила ребёнка.',
    startOffset: 200,
    endOffset: 230,
    confidence: 0.91
  }, {
    id: secondActionEvidenceId,
    type: 'character_action',
    fact: 'Бабушка заботилась о больном',
    quote: 'Бабушка заботилась о больном.',
    startOffset: 2_500,
    endOffset: 2_533,
    confidence: 0.9
  }]

  const result = await service.synthesizeCharacterProfile({
    idempotencyKey: 'run-derived:synthesize:snapshot-derived:character:babushka:character-profile-v3',
    runId: 'run-derived',
    snapshotId: 'snapshot-derived',
    synthesisVersion: 'character-profile-v3',
    bookTitle: 'Детство',
    bookAuthor: 'Максим Горький',
    textLength: 10_000,
    entity,
    evidence
  })

  assert.equal(result.profile.gender.value, 'female')
  assert.deepEqual(result.profile.gender.evidenceIds, [dialogueEvidenceId])
  assert.equal(result.profile.traits[0].value, 'Заботливая')
  assert.deepEqual(result.profile.traits[0].evidenceIds, [actionEvidenceId, secondActionEvidenceId])
  assert.equal(result.profile.creative.voice, 'Che')
  assert.match(chatRequest.messages[0].content, /gender.*male.*female/i)
  assert.match(chatRequest.messages[0].content, /минимум две независимо достаточные сцены/i)
  assert.match(chatRequest.messages[0].content, /грамматически законченных предложениях/i)
  assert.match(chatRequest.messages[0].content, /anxious.*прямом утверждении устойчивого свойства/i)
})

test('personality filter requires independent scenes and preserves abstention', () => {
  const firstId = '66666666-6666-4666-8666-666666666661'
  const nearbyId = '66666666-6666-4666-8666-666666666662'
  const distantId = '66666666-6666-4666-8666-666666666663'
  const evidenceById = new Map([
    [firstId, {
      id: firstId,
      type: 'character_action',
      fact: 'Анна помогла ребёнку',
      quote: 'Анна помогла ребёнку.',
      startOffset: 100,
      confidence: 0.9
    }],
    [nearbyId, {
      id: nearbyId,
      type: 'character_dialogue',
      fact: 'Анна успокоила ребёнка',
      quote: 'Анна успокоила ребёнка.',
      startOffset: 250,
      confidence: 0.9
    }],
    [distantId, {
      id: distantId,
      type: 'character_action',
      fact: 'Анна ухаживала за больным',
      quote: 'Анна ухаживала за больным.',
      startOffset: 3_000,
      confidence: 0.9
    }]
  ])
  const nearby = [{ value: 'заботливая', evidenceIds: [firstId, nearbyId], confidence: 0.9 }]
  const distant = [{ value: 'заботливая', evidenceIds: [firstId, distantId], confidence: 0.9 }]
  assert.deepEqual(filterStableTraits(nearby, evidenceById, 10_000), [])
  assert.deepEqual(filterStableTraits(distant, evidenceById, 10_000), distant)
})

test('personality filter rejects polarity inversion, temporary states and skills', () => {
  const fixtures = [
    ['principled', 'Wickham had a want of principle.', 'Wickham had a want of principle.'],
    ['humble', 'Amy looked humble in her little effort.', 'Amy looked humble in her little effort.'],
    ['artistic', 'Amy practised drawing.', 'Amy practised drawing.'],
    ['accomplished', 'Georgiana was accomplished at music.', 'She played and sang all day.'],
    ['musical', 'Laurie played music.', 'Laurie played music.'],
    ['storytelling', 'Jo wrote a story.', 'Jo wrote a story.'],
    ['housewifely', 'Beth kept the house.', 'Beth kept the house.'],
    ['good-humoured', 'Lydia had a good-humoured countenance.', 'Her good-humoured countenance.'],
    ['proud', 'Miss Darcy was reported as proud, but was only shy.', 'She was said to be proud, but she was only exceedingly shy.'],
    ['admiring', 'Georgiana admired Elizabeth.', 'Her opinion of Elizabeth was very high.']
  ]
  const evidenceById = new Map()
  const claims = fixtures.map(([value, fact, quote], index) => {
    const id = `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`
    evidenceById.set(id, {
      id,
      type: 'character_trait',
      fact,
      quote,
      startOffset: index * 3_000,
      confidence: 0.95
    })
    return { value, evidenceIds: [id], confidence: 0.95 }
  })
  assert.deepEqual(filterStableTraits(claims, evidenceById, 100_000), [])
})

test('personality filter rejects low-confidence invention and inferred emotional state', () => {
  const firstId = '79797979-7979-4797-8797-797979797971'
  const secondId = '79797979-7979-4797-8797-797979797972'
  const directId = '79797979-7979-4797-8797-797979797973'
  const evidenceById = new Map([
    [firstId, {
      id: firstId,
      type: 'character_action',
      fact: 'Mrs. Bennet became distressed by the absence.',
      quote: 'She was distressed by his continued absence.',
      startOffset: 100,
      confidence: 0.95
    }],
    [secondId, {
      id: secondId,
      type: 'character_action',
      fact: 'Mrs. Bennet was in an agony of ill-humour.',
      quote: 'The mention threw her into an agony of ill-humour.',
      startOffset: 3_000,
      confidence: 0.95
    }],
    [directId, {
      id: directId,
      type: 'character_trait',
      fact: 'The narrator calls her habitually anxious.',
      quote: 'Her habitually anxious disposition returned.',
      startOffset: 6_000,
      confidence: 0.95
    }]
  ])
  const invented = [{
    value: 'conceited',
    evidenceIds: [firstId, secondId],
    confidence: 0.76
  }]
  const inferredState = [{
    value: 'anxious',
    evidenceIds: [firstId, secondId],
    confidence: 0.95
  }]
  const directStable = [{ value: 'anxious', evidenceIds: [directId], confidence: 0.95 }]

  assert.deepEqual(filterStableTraits(invented, evidenceById, 100_000), [])
  assert.deepEqual(filterStableTraits(inferredState, evidenceById, 100_000), [])
  assert.deepEqual(filterStableTraits(directStable, evidenceById, 100_000), directStable)
})

test('personality filter does not trust a direct label absent from its quote', () => {
  const unsupportedId = '78787878-7878-4787-8787-787878787871'
  const temporaryId = '78787878-7878-4787-8787-787878787872'
  const evidenceById = new Map([
    [unsupportedId, {
      id: unsupportedId,
      type: 'character_trait',
      fact: 'Beth is gentle.',
      quote: 'Beth exercised more influence than anyone in the family.',
      startOffset: 100,
      confidence: 0.95
    }],
    [temporaryId, {
      id: temporaryId,
      type: 'character_trait',
      fact: 'Laurie is bashful.',
      quote: 'Laurie’s bashfulness soon wore off.',
      startOffset: 3_000,
      confidence: 0.95
    }]
  ])
  const claims = [{
    value: 'gentle', evidenceIds: [unsupportedId], confidence: 0.95
  }, {
    value: 'bashful', evidenceIds: [temporaryId], confidence: 0.95
  }]
  assert.deepEqual(filterStableTraits(claims, evidenceById, 100_000), [])
})

test('personality filter follows durable quote attribution despite noisy evidence typing', () => {
  const fixtures = [{
    value: 'observant',
    type: 'character_action',
    fact: 'Kemp notices a spot.',
    quote: 'His scientific pursuits have made him a very observant man.',
    startOffset: 100
  }, {
    value: 'stern',
    type: 'character_trait',
    fact: 'James is stern.',
    quote: 'She had felt ill at ease when alone with this rough stern son of hers.',
    startOffset: 3_000
  }, {
    value: 'shy',
    type: 'character_trait',
    fact: 'Sibyl is shy.',
    quote: 'Sibyl was so shy and so gentle.',
    startOffset: 6_000
  }, {
    value: 'humble',
    type: 'character_trait',
    fact: 'Amy is humble.',
    quote: 'Amy looked humble in her little effort.',
    startOffset: 9_000
  }, {
    value: 'dissipated',
    type: 'character_trait',
    fact: 'Willoughby is dissipated.',
    quote: 'His character is now before you; expensive, dissipated, and worse than both.',
    startOffset: 12_000
  }, {
    value: 'cool and methodical',
    type: 'character_trait',
    fact: 'Kemp is cool and methodical.',
    quote: 'Kemp was cool and methodical.',
    startOffset: 15_000
  }]
  const evidenceById = new Map()
  const claims = fixtures.map((fixture, index) => {
    const id = `89898989-8989-4898-8898-${String(index + 1).padStart(12, '0')}`
    evidenceById.set(id, { id, ...fixture, confidence: 0.96 })
    return { value: fixture.value, evidenceIds: [id], confidence: 0.96 }
  })
  assert.deepEqual(
    filterStableTraits(claims, evidenceById, 100_000).map(({ value }) => value).sort(),
    ['dissipated', 'observant', 'shy', 'stern']
  )
})

test('personality filter removes tied antonyms and caps a deterministic profile at four traits', () => {
  const values = ['good-tempered', 'quick-tempered', 'kind', 'honest', 'patient', 'brave', 'loyal']
  const evidenceById = new Map()
  const claims = values.map((value, index) => {
    const id = `88888888-8888-4888-8888-${String(index + 1).padStart(12, '0')}`
    evidenceById.set(id, {
      id,
      type: 'character_trait',
      fact: `The narrator calls the character ${value}.`,
      quote: `The character was ${value}.`,
      startOffset: index * 3_000,
      confidence: 0.95
    })
    return { value, evidenceIds: [id], confidence: 0.95 }
  })
  const result = filterStableTraits(claims, evidenceById, 100_000)
  assert.equal(result.length, 4)
  assert.equal(result.some(({ value }) => value === 'good-tempered'), false)
  assert.equal(result.some(({ value }) => value === 'quick-tempered'), false)
  assert.deepEqual(result.map(({ value }) => value), ['brave', 'honest', 'kind', 'loyal'])
})

test('internal service auth rejects public bearer tokens and accepts only its own token', () => {
  const token = 's'.repeat(48)
  const auth = requireGenerationServiceToken(token)
  let status
  let nextCalls = 0
  const response = {
    setHeader() {},
    status(value) { status = value; return this },
    json() { return this }
  }
  auth({ headers: { authorization: 'Bearer installation-token' } }, response, () => { nextCalls += 1 })
  assert.equal(status, 401)
  assert.equal(nextCalls, 0)
  auth({ headers: { authorization: `Bearer ${token}` } }, response, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)
})

test('internal router exposes all worker endpoints', () => {
  const router = createInternalGenerationRouter({
    token: 's'.repeat(48),
    service: {
      async generateBookMarkup() { return { ok: true } },
      async generateBookIdentity() { return { title: 'Книга' } },
      async generateCatalogCover() { return { ok: true } },
      async generateBookScene() { return { ok: true } },
      async generateCharacterBundle() { return { ok: true } },
      async scanBookChunk() { return { observations: [] } },
      async reconcileBookCharacterIdentities() { return { merges: [] } },
      async synthesizeCharacterProfile() { return { profile: {} } }
    }
  })
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean)
  assert.deepEqual(paths, [
    '/v1/book-markup',
    '/v1/book-identities',
    '/v1/catalog-covers',
      '/v1/book-scenes',
      '/v1/character-bundles',
      '/v1/book-tts-markup/attribute',
      '/v1/book-analysis/scan-chunk',
    '/v1/book-analysis/reconcile-character-identities',
    '/v1/book-analysis/synthesize-character'
  ])
})

test('grounded profile claims keep the valid evidence subset instead of dropping the claim', async () => {
  const { normalizeGroundedProfileClaim } = await import('../internal-generation-service.mjs')
  const evidenceById = new Map([
    ['ev-1', { type: 'character_trait' }],
    ['ev-2', { type: 'character_action' }]
  ])
  const allowed = new Set(['character_trait', 'character_action'])

  const partiallyGrounded = normalizeGroundedProfileClaim(
    { value: 'замкнутый', evidenceIds: ['ev-1', 'ev-hallucinated'], confidence: 0.9 },
    'traits[0]',
    evidenceById,
    allowed
  )
  assert.equal(partiallyGrounded.value, 'замкнутый')
  assert.deepEqual(partiallyGrounded.evidenceIds, ['ev-1'])

  const wrongType = normalizeGroundedProfileClaim(
    { value: 'бледный', evidenceIds: ['ev-2'], confidence: 0.9 },
    'traits[1]',
    evidenceById,
    new Set(['character_trait'])
  )
  assert.equal(wrongType, null)

  const ungrounded = normalizeGroundedProfileClaim(
    { value: 'выдумано', evidenceIds: ['ev-hallucinated'], confidence: 0.9 },
    'traits[2]',
    evidenceById,
    allowed
  )
  assert.equal(ungrounded, null)
})

test('profile audit keeps the candidate description when the auditor omits it and drops it only on explicit null', async () => {
  const { normalizeProfileAuditResult } = await import('../internal-generation-service.mjs')
  const evidenceById = new Map([
    ['ev-1', { type: 'character_trait' }],
    ['ev-2', { type: 'character_action' }]
  ])
  const source = {
    traits: [{ value: 'замкнутый', evidenceIds: ['ev-1'], confidence: 0.9 }],
    description: {
      value: 'Бывший студент, задавленный бедностью и собственной теорией.',
      evidenceIds: ['ev-1', 'ev-2'],
      confidence: 0.8
    }
  }

  const omitted = normalizeProfileAuditResult(
    { traits: [{ index: 0, evidenceIds: ['ev-1'] }] },
    source,
    evidenceById
  )
  assert.equal(omitted.descriptionAccepted, true)
  assert.equal(omitted.source.description.value, source.description.value)
  assert.equal(omitted.acceptedTraitCount, 1)

  const rejected = normalizeProfileAuditResult(
    { traits: [{ index: 0, evidenceIds: ['ev-1'] }], description: null },
    source,
    evidenceById
  )
  assert.equal(rejected.descriptionAccepted, false)
  assert.equal(rejected.source.description, null)

  const rewritten = normalizeProfileAuditResult(
    {
      traits: [{ index: 0, evidenceIds: ['ev-1'] }],
      description: { value: 'Бывший студент.', evidenceIds: ['ev-2', 'ev-unknown'] }
    },
    source,
    evidenceById
  )
  assert.equal(rewritten.descriptionAccepted, true)
  assert.equal(rewritten.source.description.value, 'Бывший студент.')
  assert.deepEqual(rewritten.source.description.evidenceIds, ['ev-2'])
})
