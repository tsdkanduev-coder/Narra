import {
  CHARACTER_BUNDLE_VERSION,
  LOCAL_MARKUP_ANALYSIS_VERSION,
  LOCAL_MARKUP_PROGRESS_SCALE,
  ensureCharacterBundle,
  isCompleteCharacterBundle,
  readerCharacterState
} from './book-markup.mjs'
import {
  BOOK_ANALYSIS_CHARACTER_BUNDLE_VERSION,
  BOOK_ANALYSIS_MARKUP_VERSION,
  normalizeBookMarkupV3
} from './book-analysis-contracts.mjs'
import {
  BOOK_CONTENT_CHUNK_CHARS,
  BOOK_CONTENT_CONTRACT_VERSION,
  BOOK_CONTENT_TOC_CONTRACT_VERSION,
  decodeBookContentCursor,
  encodeBookContentCursor,
  utf8CharacterChunk
} from './book-content.mjs'
import { formatCharacterDisplayName, isPseudoCharacterName } from './character-display-name.mjs'
import { voiceForGender } from './voices.mjs'
import { createHash, randomUUID } from 'node:crypto'
import {
  applyBookCharacterCorrection,
  resolveCorrectedCharacterKey
} from './book-character-correction.mjs'

function serviceError(code, message, status) {
  return Object.assign(new Error(message), { code, status })
}

function requiredRepository(repository) {
  const methods = [
    'listCatalogBooks',
    'resolveBook',
    'getReaderBookManifest',
    'advanceReaderPosition'
  ]
  if (!repository || methods.some((method) => typeof repository[method] !== 'function')) {
    throw new TypeError('book catalog repository is incomplete')
  }
  return repository
}

function bookBinding(edition) {
  const binding = {
    resolution: edition.scope,
    bookEditionId: edition.id,
    catalogKey: edition.catalogKey ?? undefined,
    title: edition.title,
    author: edition.author,
    genres: Array.isArray(edition.genres) ? edition.genres : [],
    language: edition.language ?? null,
    format: edition.format,
    contentSha256: edition.contentSha256,
    generationStatus: edition.status,
    ready: ['base_ready', 'published'].includes(edition.status),
    sourceDownloadPath: edition.sourceStorage === 'stored'
      ? `/v2/books/${edition.id}/source/download`
      : undefined,
    expiresAt: edition.expiresAt ?? undefined
  }
  if (edition.cover) {
    binding.cover = {
      contentHash: edition.cover.contentHash,
      mimeType: edition.cover.mimeType,
      byteSize: edition.cover.byteSize,
      downloadPath: `/v2/books/${edition.id}/cover/download`
    }
  }
  return binding
}

function publicAsset(asset) {
  return {
    assetId: asset.assetId,
    type: asset.type,
    contentHash: asset.contentHash,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    downloadPath: asset.downloadPath
  }
}

function claimValue(claim) {
  return typeof claim?.value === 'string' ? claim.value : ''
}

function publicCharacterProfile(profile) {
  if (typeof profile?.description !== 'string') return profile
  return {
    ...profile,
    description: profile.description.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
  }
}

function publicCharacterFullName(character) {
  const name = formatCharacterDisplayName(character?.name).toLocaleLowerCase('ru-RU')
  const fullName = formatCharacterDisplayName(character?.fullName)
  const normalizedFullName = fullName.toLocaleLowerCase('ru-RU')
  const unknownMarker = /^(?:полное имя|фамили[яи]).*(?:не назван|не указан|неизвест)|^(?:full name|surname).*(?:not (?:given|mentioned)|unknown)/iu
  return fullName && normalizedFullName !== name && !unknownMarker.test(normalizedFullName)
    ? fullName
    : ''
}

function publicCharacterTraits(character) {
  const finalSnapshotTraits = character.personalitySnapshots.at(-1)?.traits
    ?.map(claimValue)
    .filter(Boolean)
    .slice(0, 5) ?? []
  return finalSnapshotTraits.length
    ? finalSnapshotTraits
    : character.traits.map(claimValue).filter(Boolean).slice(0, 5)
}

function analysisCharacterProfile(character, analysisSource) {
  const gender = claimValue(character.gender)
  const normalizedGender = gender === 'male' || gender === 'female' ? gender : undefined
  const appearancePrompt = character.creative?.appearancePrompt || character.appearance
    .map(claimValue)
    .filter(Boolean)
    .join(', ')
  return publicCharacterProfile({
    role: claimValue(character.role) || 'Персонаж истории',
    description: claimValue(character.description),
    gender: normalizedGender,
    // The evidence-backed timeline remains in canonical markup for audit and
    // regeneration. The public profile deliberately exposes only its final
    // state so every client version shows the complete character immediately.
    traits: publicCharacterTraits(character),
    speechStyle: claimValue(character.speechStyle),
    speechExamples: character.speechExamples.map(claimValue).filter(Boolean).slice(0, 3),
    appearancePrompt,
    greeting: character.creative?.greeting || '',
    voice: voiceForGender(character.creative?.voice, normalizedGender),
    analysisSource
  })
}

function analysisReaderTextOffset(snapshot, textLength) {
  if (typeof snapshot.readingFraction === 'number' && Number.isFinite(snapshot.readingFraction)) {
    return Math.round(Math.min(1, Math.max(0, snapshot.readingFraction)) * textLength)
  }
  const publicTextLength = Number(snapshot.markup?.textLength)
  if (Number.isSafeInteger(publicTextLength) && publicTextLength > 0) {
    return Math.round(Math.min(1, snapshot.readerTextOffset / publicTextLength) * textLength)
  }
  return Math.min(textLength, Math.max(0, Number(snapshot.readerTextOffset) || 0))
}

function preparedNavigation(content, byteSize) {
  const rawSegments = content.navigation?.version === 'book-navigation-v1' &&
    Array.isArray(content.navigation.segments)
    ? content.navigation.segments
    : []
  const segments = []
  let expectedStart = 0
  for (const [index, raw] of rawSegments.entries()) {
    if (
      !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.key !== 'string' || !raw.key ||
      !Number.isSafeInteger(raw.startByte) || raw.startByte !== expectedStart ||
      !Number.isSafeInteger(raw.endByte) || raw.endByte <= raw.startByte ||
      raw.endByte > byteSize
    ) return null
    segments.push({
      key: raw.key.slice(0, 500),
      title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
      index,
      startByte: raw.startByte,
      endByte: raw.endByte
    })
    expectedStart = raw.endByte
  }
  if (!segments.length || expectedStart !== byteSize) return null
  const byKey = new Map(segments.map(segment => [segment.key, segment]))
  const items = Array.isArray(content.navigation.items)
    ? content.navigation.items.flatMap((raw, index) => {
      const section = byKey.get(raw?.sectionKey)
      if (!section || typeof raw?.key !== 'string' || !raw.key) return []
      return [{
        key: raw.key.slice(0, 500),
        title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : section.title,
        level: Number.isSafeInteger(raw.level) && raw.level >= 0 ? raw.level : 0,
        parentKey: typeof raw.parentKey === 'string' ? raw.parentKey.slice(0, 500) : null,
        sectionKey: section.key,
        href: typeof raw.href === 'string' ? raw.href.slice(0, 2_000) : null,
        anchorResolved: raw.anchorResolved !== false,
        order: index,
        startByte: section.startByte,
        endByte: section.endByte
      }]
    })
    : []
  return {
    source: typeof content.navigation.source === 'string' ? content.navigation.source : 'unknown',
    items: items.length ? items : segments.map(segment => ({
      key: segment.key,
      title: segment.title,
      level: 0,
      parentKey: null,
      sectionKey: segment.key,
      href: null,
      anchorResolved: true,
      order: segment.index,
      startByte: segment.startByte,
      endByte: segment.endByte
    })),
    segments
  }
}

function fallbackNavigation(byteSize) {
  const segment = {
    key: 'fixed:document', title: '', index: 0, startByte: 0, endByte: byteSize
  }
  return {
    source: 'fixed',
    items: [{
      key: segment.key, title: '', level: 0, parentKey: null,
      sectionKey: segment.key, href: null, anchorResolved: true, order: 0,
      startByte: 0, endByte: byteSize
    }],
    segments: [segment]
  }
}

export function createBookCatalogService({
  repository,
  analysisRepository = null,
  correctionRepository = null,
  ttsMarkupRepository = null,
  storage = null,
  bundleVersion = CHARACTER_BUNDLE_VERSION,
  idFactory = randomUUID,
  contentChunkChars = BOOK_CONTENT_CHUNK_CHARS
}) {
  const store = requiredRepository(repository)
  if (!Number.isSafeInteger(contentChunkChars) || contentChunkChars < 1 || contentChunkChars > 250_000) {
    throw new RangeError('contentChunkChars must be between 1 and 250000 characters')
  }

  async function preparedCatalogContent(subjectId, bookEditionId) {
    if (typeof store.getReaderBookContent !== 'function') {
      throw new TypeError('repository.getReaderBookContent is required')
    }
    if (!storage) throw serviceError('DOWNLOAD_UNAVAILABLE', 'Скачивание временно недоступно', 503)
    const content = await store.getReaderBookContent({ subjectId, bookEditionId })
    if (!content) throw serviceError('NOT_FOUND', 'Содержимое книги не найдено', 404)
    return content
  }

  async function ensureCanonicalAnalysis(edition) {
    if (!analysisRepository || typeof analysisRepository.ensureAnalysisRun !== 'function') {
      throw serviceError('ANALYSIS_UNAVAILABLE', 'Разметка v3 временно недоступна', 503)
    }
    const analysis = await analysisRepository.ensureAnalysisRun({
      bookEditionId: edition.id,
      inputHash: edition.contentSha256,
      priority: 50
    })
    return {
      analysisRunId: analysis.run.id,
      analysisStage: analysis.run.stage,
      analysisStatus: analysis.run.status,
      analysisCreated: analysis.created,
      jobId: analysis.prepareJob.id,
      jobStatus: analysis.prepareJob.status
    }
  }

  async function enabledCorrection({ bookEditionId, markup, publicationId = null }) {
    if (
      !correctionRepository?.getEnabledCorrection ||
      !markup?.id || !markup?.inputHash
    ) return null
    try {
      return await correctionRepository.getEnabledCorrection({
        bookEditionId,
        markupVersionId: markup.id,
        publicationId,
        contentHash: markup.inputHash
      })
    } catch (error) {
      console.error('[book-character-correction] lookup failed; serving base markup', {
        book_edition_id: bookEditionId,
        code: error?.code || 'LOOKUP_FAILED'
      })
      return null
    }
  }

  async function v3Manifest(snapshot, bookEditionId, source = 'v3') {
    if (!analysisRepository || typeof analysisRepository.getLatestShadowAnalysisPublication !== 'function') {
      throw serviceError('ANALYSIS_UNAVAILABLE', 'Разметка v3 временно недоступна', 503)
    }
    const publication = await analysisRepository.getLatestShadowAnalysisPublication(bookEditionId)
    if (!publication?.data?.markup) {
      const preview = typeof analysisRepository.getLatestAnalysisPreview === 'function'
        ? await analysisRepository.getLatestAnalysisPreview(bookEditionId)
        : null
      const textLength = Number(preview?.run?.textLength)
      const readerTextOffset = Number.isSafeInteger(textLength) && textLength > 0
        ? analysisReaderTextOffset(snapshot, textLength)
        : Math.max(0, Number(snapshot.readerTextOffset) || 0)
      const terminalStatus = ['failed', 'cancelled'].includes(preview?.run?.status)
        ? preview.run.status
        : null
      const availability = terminalStatus ?? (preview ? 'processing' : 'unavailable')
      return {
        source,
        book: bookBinding(snapshot.edition),
        availability,
        runId: preview?.run?.id,
        readerTextOffset,
        readingFraction: snapshot.readingFraction,
        readerSectionIndex: snapshot.readerSectionIndex,
        readerSectionFraction: snapshot.readerSectionFraction,
        markup: null,
        analysis: preview
          ? {
              runId: preview.run.id,
              stage: preview.run.stage,
              status: preview.run.status,
              retryable: Boolean(terminalStatus && snapshot.edition?.scope === 'private'),
              errorCode: preview.run.lastErrorCode,
              updatedAt: preview.run.updatedAt,
              textLength: preview.run.textLength,
              completedScanChunks: preview.scan.completedChunks,
              totalScanChunks: preview.scan.totalChunks
            }
          : null,
        characters: (preview?.characters ?? [])
          .filter((character) => character.firstAppearanceTextOffset <= readerTextOffset)
          .filter((character) => !isPseudoCharacterName(character.name, character.fullName))
          .map((character) => ({
            characterKey: character.characterKey,
            name: formatCharacterDisplayName(character.name),
            fullName: publicCharacterFullName(character),
            firstAppearanceTextOffset: character.firstAppearanceTextOffset,
            provisional: true,
            state: 'preparing',
            profile: {
              role: 'Профиль формируется',
              traits: [],
              speechStyle: '',
              speechExamples: [],
              appearancePrompt: '',
              greeting: '',
              analysisSource: source,
              provisional: true
            },
            bundle: null
          }))
      }
    }
    const baseMarkup = normalizeBookMarkupV3(publication.data.markup)
    let markup = baseMarkup
    let correction = null
    let redirects = new Map()
    const enabled = await enabledCorrection({
      bookEditionId,
      markup: snapshot.markup,
      publicationId: publication.id
    })
    if (enabled) {
      try {
        const projected = applyBookCharacterCorrection(enabled.document, {
          markup: baseMarkup,
          base: {
            markupVersionId: snapshot.markup.id,
            publicationId: publication.id,
            contentHash: snapshot.markup.inputHash
          }
        })
        markup = projected.markup
        redirects = projected.redirects
        correction = {
          contractVersion: enabled.contractVersion,
          version: enabled.correctionVersion,
          documentHash: enabled.documentHash
        }
      } catch (error) {
        console.error('[book-character-correction] enabled correction rejected at read time', {
          book_edition_id: bookEditionId,
          correction_version: enabled.correctionVersion,
          code: error?.code || 'INVALID'
        })
      }
    }
    let ttsMarkup = { status: 'unavailable', version: 'book-tts-script-v1', revision: null,
      retryAfterMs: null }
    if (ttsMarkupRepository?.ensureBookTtsMarkup) {
      try {
        ttsMarkup = await ttsMarkupRepository.ensureBookTtsMarkup({
          bookEditionId,
          sourcePublicationId: publication.id
        }) ?? ttsMarkup
      } catch {
        // TTS markup is an additive sidecar and must never make the book unavailable.
      }
    }
    const readerTextOffset = analysisReaderTextOffset(snapshot, markup.textLength)
    const profileByCharacterKey = new Map(
      markup.characters.map((character) => [character.characterKey, character])
    )
    return {
      source,
      book: bookBinding(snapshot.edition),
      availability: 'ready',
      publicationId: publication.id,
      runId: publication.runId,
      contentHash: publication.contentHash,
      publishedAt: publication.publishedAt,
      correction,
      readerTextOffset,
      readingFraction: snapshot.readingFraction,
      readerSectionIndex: snapshot.readerSectionIndex,
      readerSectionFraction: snapshot.readerSectionFraction,
      markup: {
        schemaVersion: markup.schemaVersion,
        analysisVersion: markup.analysisVersion,
        textLength: markup.textLength,
        scenePolicy: markup.scenePolicy,
        publishedAt: publication.publishedAt
      },
      ttsMarkup,
      characters: (() => {
        const mediaByProjectedKey = new Map()
        const projectedOrder = []
        const seen = new Set()
        for (const media of snapshot.characters || []) {
          const projectedKey = redirects.get(media.characterKey) ?? media.characterKey
          if (!profileByCharacterKey.has(projectedKey)) continue
          if (!seen.has(projectedKey)) {
            projectedOrder.push(projectedKey)
            seen.add(projectedKey)
          }
          const current = mediaByProjectedKey.get(projectedKey)
          const currentReady = isCompleteCharacterBundle(current?.bundle)
          const candidateReady = isCompleteCharacterBundle(media?.bundle)
          if (
            !current ||
            (!currentReady && candidateReady) ||
            (currentReady === candidateReady && media.characterKey === projectedKey)
          ) {
            mediaByProjectedKey.set(projectedKey, media)
          }
        }
        // «Рассказчик»/«Автор» из скана — не герой книги (C4/P0-5).
        const cast = projectedOrder.filter((characterKey) => {
          const character = profileByCharacterKey.get(characterKey)
          return !isPseudoCharacterName(character?.name, character?.fullName)
        })
        return cast.map((characterKey) => {
          const character = profileByCharacterKey.get(characterKey)
          const media = mediaByProjectedKey.get(characterKey)
          const state = isCompleteCharacterBundle(media?.bundle) ? 'ready' : 'preparing'
          return {
            characterKey: character.characterKey,
            name: formatCharacterDisplayName(character.name),
            fullName: publicCharacterFullName(character),
            firstAppearanceTextOffset: character.firstAppearanceTextOffset,
            provisional: false,
            state,
            profile: analysisCharacterProfile(character, source),
            bundle: media?.bundle?.assets?.length
              ? {
                  version: media.bundle.version,
                  assets: media.bundle.assets.map((asset) => publicAsset({
                    ...asset,
                    downloadPath: `/v2/books/${bookEditionId}/media/${asset.assetId}/download`
                  }))
                }
              : null
          }
        })
      })()
    }
  }

  function legacyManifest(snapshot, bookEditionId) {
    if (!snapshot.markup) {
      return {
        book: bookBinding(snapshot.edition),
        availability: 'processing',
        readerTextOffset: snapshot.readerTextOffset,
        readingFraction: snapshot.readingFraction,
        readerSectionIndex: snapshot.readerSectionIndex,
        readerSectionFraction: snapshot.readerSectionFraction,
        markup: null,
        characters: []
      }
    }
    const characters = []
    for (const character of snapshot.characters) {
      const state = readerCharacterState(character, character.bundle, {
        textOffset: snapshot.readerTextOffset,
        sectionIndex: snapshot.readerSectionIndex,
        sectionFraction: snapshot.readerSectionFraction
      })
      if (state === 'hidden') continue
      characters.push({
        characterKey: character.characterKey,
        name: formatCharacterDisplayName(character.name),
        fullName: publicCharacterFullName(character),
        firstAppearanceTextOffset: character.firstAppearanceTextOffset,
        state,
        profile: publicCharacterProfile(character.data),
        bundle: character.bundle?.assets?.length
          ? {
              version: character.bundle.version,
              assets: character.bundle.assets.map((asset) => publicAsset({
                ...asset,
                downloadPath: `/v2/books/${bookEditionId}/media/${asset.assetId}/download`
              }))
            }
          : null
      })
    }
    return {
      book: bookBinding(snapshot.edition),
      availability: 'ready',
      readerTextOffset: snapshot.readerTextOffset,
      readingFraction: snapshot.readingFraction,
      readerSectionIndex: snapshot.readerSectionIndex,
      readerSectionFraction: snapshot.readerSectionFraction,
      markup: {
        schemaVersion: snapshot.markup.schemaVersion,
        analysisVersion: snapshot.markup.analysisVersion,
        revision: snapshot.markup.revision,
        textLength: snapshot.markup.textLength,
        publishedAt: snapshot.markup.publishedAt
      },
      characters
    }
  }

  return {
    async listCatalog({ limit, cursor }) {
      const result = await store.listCatalogBooks({ limit, cursor })
      return {
        items: result.items.map((edition) => bookBinding(edition)),
        nextCursor: result.nextCursor
      }
    },

    async listCatalogByLanguage({ language, limit, cursor }) {
      const result = await store.listCatalogBooks({ language, limit, cursor })
      return {
        items: result.items.map((edition) => bookBinding(edition)),
        nextCursor: result.nextCursor
      }
    },

    async resolve(subjectId, input) {
      const edition = await store.resolveBook({ subjectId, ...input })
      if (!edition && input.source === 'catalog') {
        throw serviceError('NOT_FOUND', 'Книга каталога не найдена', 404)
      }
      if (!edition) {
        return {
          resolution: 'local_registration_required',
          contentSha256: input.contentSha256,
          ready: false
        }
      }
      return bookBinding(edition)
    },

    async registerLocalBook(subjectId, input) {
      if (typeof store.registerLocalBook !== 'function') {
        throw new TypeError('repository.registerLocalBook is required')
      }
      const proposedBookEditionId = idFactory()
      const edition = await store.registerLocalBook({
        subjectId,
        proposedBookEditionId,
        ...input
      })
      return bookBinding(edition)
    },

    async uploadLocalSource(subjectId, bookEditionId, bytes, contentType) {
      if (typeof store.beginPrivateBookUpload !== 'function' ||
          typeof store.completePrivateBookUpload !== 'function') {
        throw new TypeError('private book upload repository is incomplete')
      }
      if (!storage) throw serviceError('UPLOAD_UNAVAILABLE', 'Загрузка книги временно недоступна', 503)
      const sourceBytes = Buffer.from(bytes)
      if (!sourceBytes.byteLength) {
        throw serviceError('VALIDATION', 'Файл книги пуст', 400)
      }
      const contentSha256 = createHash('sha256').update(sourceBytes).digest('hex')
      const objectKey = `books/private/${subjectId}/${contentSha256}/source`
      const prepared = await store.beginPrivateBookUpload({
        subjectId,
        bookEditionId,
        contentSha256,
        objectKey,
        mimeType: contentType,
        byteSize: sourceBytes.byteLength
      })
      if (!prepared) throw serviceError('NOT_FOUND', 'Локальная книга не найдена', 404)
      if (prepared.uploadRequired) {
        const stored = await storage.putBytes({
          objectKey: prepared.file.objectKey,
          bytes: sourceBytes,
          mimeType: prepared.file.mimeType
        })
        if (stored.contentHash !== prepared.file.contentSha256 ||
            stored.byteSize !== prepared.file.byteSize) {
          throw serviceError('UPLOAD_INTEGRITY', 'Хранилище вернуло другой checksum', 409)
        }
      }
      const edition = prepared.uploadRequired
        ? await store.completePrivateBookUpload({ subjectId, bookEditionId })
        : prepared.edition
      if (!edition) throw serviceError('NOT_FOUND', 'Локальная книга не найдена', 404)
      await store.enqueueBookIdentity?.({ bookEditionId })
      const analysis = await ensureCanonicalAnalysis(edition)
      return {
        ...bookBinding(edition),
        sourceUploaded: true,
        ...analysis
      }
    },

    async publishLocalMarkup(subjectId, bookEditionId, input) {
      if (typeof store.publishLocalBookMarkup !== 'function') {
        throw new TypeError('repository.publishLocalBookMarkup is required')
      }
      const canonical = JSON.stringify({
        analysisVersion: LOCAL_MARKUP_ANALYSIS_VERSION,
        characters: input.characters
      })
      const published = await store.publishLocalBookMarkup({
        subjectId,
        bookEditionId,
        analysisVersion: LOCAL_MARKUP_ANALYSIS_VERSION,
        inputHash: createHash('sha256').update(canonical).digest('hex'),
        textLength: LOCAL_MARKUP_PROGRESS_SCALE,
        characters: input.characters.map((character) => ({
          ...character,
          firstAppearanceTextOffset: Math.round(
            LOCAL_MARKUP_PROGRESS_SCALE * character.firstAppearanceFraction
          ),
          warmupTextOffset: Math.round(
            LOCAL_MARKUP_PROGRESS_SCALE * character.warmupFraction
          )
        }))
      })
      if (!published) throw serviceError('NOT_FOUND', 'Локальная книга не найдена', 404)
      return {
        ...bookBinding(published.edition),
        markupRevision: published.revision,
        created: published.created
      }
    },

    async sourceDownload(subjectId, bookEditionId) {
      if (typeof store.getReaderBookSource !== 'function') {
        throw new TypeError('repository.getReaderBookSource is required')
      }
      if (!storage) throw serviceError('DOWNLOAD_UNAVAILABLE', 'Скачивание временно недоступно', 503)
      const source = await store.getReaderBookSource({ subjectId, bookEditionId })
      if (!source) throw serviceError('NOT_FOUND', 'Файл книги не найден', 404)
      return storage.createDownload(source)
    },

    async identity(subjectId, bookEditionId) {
      if (typeof store.getReaderBookIdentity !== 'function') {
        throw new TypeError('repository.getReaderBookIdentity is required')
      }
      const identity = await store.getReaderBookIdentity({ subjectId, bookEditionId })
      if (!identity) throw serviceError('NOT_FOUND', 'Книга не найдена', 404)
      return {
        ...identity,
        pollAfterMs: identity.status === 'processing' ? 2_000 : undefined
      }
    },

    async fullContent(subjectId, bookEditionId) {
      const content = await preparedCatalogContent(subjectId, bookEditionId)
      if (typeof storage.getObjectInfo !== 'function') {
        throw new TypeError('storage.getObjectInfo is required')
      }
      const info = await storage.getObjectInfo({ objectKey: content.objectKey })
      const download = await storage.createDownload({
        objectKey: content.objectKey,
        mimeType: 'text/plain; charset=utf-8',
        filename: `${bookEditionId}.txt`
      })
      return {
        contractVersion: BOOK_CONTENT_CONTRACT_VERSION,
        representation: content.normalizationVersion,
        bookEditionId,
        contentHash: content.contentHash,
        textLength: content.textLength,
        byteSize: info.byteSize,
        ...download
      }
    },

    async contentToc(subjectId, bookEditionId) {
      const content = await preparedCatalogContent(subjectId, bookEditionId)
      if (typeof storage.getObjectInfo !== 'function') {
        throw new TypeError('storage.getObjectInfo is required')
      }
      const info = await storage.getObjectInfo({ objectKey: content.objectKey })
      if (info.byteSize < 1) throw serviceError('CONTENT_INVALID', 'Содержимое книги пусто', 500)
      const navigation = preparedNavigation(content, info.byteSize) || fallbackNavigation(info.byteSize)
      return {
        contractVersion: BOOK_CONTENT_TOC_CONTRACT_VERSION,
        representation: content.normalizationVersion,
        bookEditionId,
        contentHash: content.contentHash,
        source: navigation.source,
        items: navigation.items
      }
    },

    async ttsSection(subjectId, bookEditionId, sectionIndex) {
      if (!Number.isSafeInteger(sectionIndex) || sectionIndex < 0) {
        throw serviceError('VALIDATION', 'section index: invalid value', 400)
      }
      const snapshot = await store.getReaderBookManifest({ subjectId, bookEditionId })
      if (!snapshot) throw serviceError('NOT_FOUND', 'Книга не найдена', 404)
      if (!ttsMarkupRepository?.getBookTtsMarkupSection) {
        return { status: 'unavailable', version: 'book-tts-script-v1', revision: null,
          retryAfterMs: null }
      }
      const section = await ttsMarkupRepository.getBookTtsMarkupSection({
        bookEditionId,
        sectionIndex
      })
      if (section) {
        const correction = await enabledCorrection({ bookEditionId, markup: snapshot.markup })
        if (!correction || !section.section?.segments) return section
        return {
          ...section,
          section: {
            ...section.section,
            segments: section.section.segments.map((segment) => ({
              ...segment,
              characterKey: segment.characterKey
                ? resolveCorrectedCharacterKey(segment.characterKey, correction)
                : null
            }))
          }
        }
      }
      return { status: 'processing', version: 'book-tts-script-v1', revision: null,
        retryAfterMs: 10_000 }
    },

    async contentChunk(subjectId, bookEditionId, rawCursor) {
      const content = await preparedCatalogContent(subjectId, bookEditionId)
      if (typeof storage.getObjectInfo !== 'function' || typeof storage.getBytesRange !== 'function') {
        throw new TypeError('storage range reads are required')
      }
      const info = await storage.getObjectInfo({ objectKey: content.objectKey })
      if (info.byteSize < 1) throw serviceError('CONTENT_INVALID', 'Содержимое книги пусто', 500)
      const cursor = rawCursor ? decodeBookContentCursor(rawCursor) : null
      if (cursor && cursor.contentHash !== content.contentHash) {
        throw serviceError('CONTENT_VERSION_CHANGED', 'Версия содержимого книги изменилась', 409)
      }
      const startByte = cursor?.byteOffset ?? 0
      if (startByte < 0 || startByte >= info.byteSize) {
        throw serviceError('VALIDATION', 'content cursor: offset is outside the book', 400)
      }
      const navigation = preparedNavigation(content, info.byteSize) || fallbackNavigation(info.byteSize)
      const section = navigation.segments.find(candidate =>
        candidate.startByte <= startByte && candidate.endByte > startByte)
      if (!section) throw serviceError('CONTENT_INVALID', 'Не найдена глава для позиции чтения', 500)
      const requestedEnd = Math.min(
        section.endByte,
        startByte + contentChunkChars * 4 + 3
      )
      const stored = await storage.getBytesRange({
        objectKey: content.objectKey,
        startByte,
        endByteExclusive: requestedEnd,
        maxBytes: contentChunkChars * 4 + 3
      })
      const characterChunk = utf8CharacterChunk(stored.bytes, contentChunkChars)
      const chunkBytes = characterChunk.bytes
      if (chunkBytes.byteLength < 1) {
        throw serviceError('CONTENT_INVALID', 'Не удалось прочитать фрагмент книги', 500)
      }
      const endByteExclusive = startByte + chunkBytes.byteLength
      return {
        contractVersion: BOOK_CONTENT_CONTRACT_VERSION,
        representation: content.normalizationVersion,
        bookEditionId,
        contentHash: content.contentHash,
        textLength: content.textLength,
        byteSize: info.byteSize,
        chunk: {
          startByte,
          endByteExclusive,
          contentHash: createHash('sha256').update(chunkBytes).digest('hex'),
          text: characterChunk.text
        },
        section: {
          key: section.key,
          title: section.title,
          index: section.index,
          startByte: section.startByte,
          endByteExclusive: section.endByte
        },
        sectionComplete: endByteExclusive === section.endByte,
        nextCursor: endByteExclusive < info.byteSize
          ? encodeBookContentCursor({
              contentHash: content.contentHash,
              byteOffset: endByteExclusive
            })
          : null
      }
    },

    async coverDownload(subjectId, bookEditionId) {
      if (typeof store.getCatalogBookCover !== 'function') {
        throw new TypeError('repository.getCatalogBookCover is required')
      }
      if (!storage) throw serviceError('DOWNLOAD_UNAVAILABLE', 'Скачивание временно недоступно', 503)
      const cover = await store.getCatalogBookCover({ subjectId, bookEditionId })
      if (!cover) throw serviceError('NOT_FOUND', 'Обложка книги не найдена', 404)
      return storage.createDownload(cover)
    },

    async mediaDownload(subjectId, bookEditionId, assetId) {
      if (typeof store.getReaderMediaAsset !== 'function') {
        throw new TypeError('repository.getReaderMediaAsset is required')
      }
      if (!storage) throw serviceError('DOWNLOAD_UNAVAILABLE', 'Скачивание временно недоступно', 503)
      const asset = await store.getReaderMediaAsset({
        subjectId,
        bookEditionId,
        assetId,
        bundleVersion: analysisRepository
          ? BOOK_ANALYSIS_CHARACTER_BUNDLE_VERSION
          : bundleVersion
      })
      if (!asset) throw serviceError('NOT_FOUND', 'Материал не найден', 404)
      return storage.createDownload(asset)
    },

    async sceneAt(subjectId, bookEditionId, { readerTextOffset, progressFraction }) {
      if (typeof store.ensureReaderBookScene !== 'function') {
        throw new TypeError('repository.ensureReaderBookScene is required')
      }
      if (typeof analysisRepository?.ensureLatestMediaProjection === 'function') {
        await analysisRepository.ensureLatestMediaProjection(bookEditionId)
      }
      const scene = await store.ensureReaderBookScene({
        subjectId,
        bookEditionId,
        readerTextOffset,
        progressFraction
      })
      if (!scene) throw serviceError('NOT_FOUND', 'Книга или сцена не найдена', 404)
      if (scene.errorCode) {
        return {
          status: scene.status,
          errorCode: scene.errorCode,
          retryable: scene.retryable,
          analysis: scene.analysis,
          pollAfterMs: scene.errorCode === 'MARKUP_PROCESSING' ? 5_000 : undefined
        }
      }
      const result = {
        status: scene.status,
        sceneKey: scene.sceneKey,
        slotIndex: scene.slotIndex,
        anchorTextOffset: scene.anchorTextOffset,
        pollAfterMs: scene.status === 'ready' ? undefined : 2_000
      }
      if (scene.status !== 'ready' || !scene.asset) return result
      if (!storage) throw serviceError('DOWNLOAD_UNAVAILABLE', 'Скачивание временно недоступно', 503)
      if (scene.jobId && typeof store.recordSceneDownloadReady === 'function') {
        await store.recordSceneDownloadReady(scene.jobId).catch(() => {})
      }
      const download = await storage.createDownload(scene.asset)
      return {
        ...result,
        imageUrl: download.url,
        expiresAt: download.expiresAt,
        mimeType: scene.asset.mimeType
      }
    },

    async retryAnalysis(subjectId, bookEditionId, { requestId }) {
      if (!analysisRepository || typeof analysisRepository.retryPrivateAnalysisRun !== 'function') {
        throw serviceError('ANALYSIS_UNAVAILABLE', 'Повтор разметки временно недоступен', 503)
      }
      return analysisRepository.retryPrivateAnalysisRun({
        subjectId,
        bookEditionId,
        requestId,
        priority: 100
      })
    },

    async manifest(subjectId, bookEditionId) {
      const snapshot = await store.getReaderBookManifest({
        subjectId,
        bookEditionId,
        bundleVersion: analysisRepository
          ? BOOK_ANALYSIS_CHARACTER_BUNDLE_VERSION
          : bundleVersion
      })
      if (!snapshot) throw serviceError('NOT_FOUND', 'Книга не найдена', 404)
      return analysisRepository?.getLatestShadowAnalysisPublication
        ? v3Manifest(snapshot, bookEditionId)
        : legacyManifest(snapshot, bookEditionId)
    },

    async shadowManifest(subjectId, bookEditionId) {
      if (!analysisRepository || typeof analysisRepository.getLatestShadowAnalysisPublication !== 'function') {
        throw serviceError('PREVIEW_UNAVAILABLE', 'Теневая разметка недоступна', 503)
      }
      const snapshot = await store.getReaderBookManifest({
        subjectId,
        bookEditionId,
        bundleVersion: BOOK_ANALYSIS_CHARACTER_BUNDLE_VERSION
      })
      if (!snapshot || snapshot.edition?.scope !== 'catalog') {
        throw serviceError('NOT_FOUND', 'Книга каталога не найдена', 404)
      }
      const manifest = await v3Manifest(snapshot, bookEditionId, 'shadow-v3')
      if (manifest.availability !== 'ready') {
        throw serviceError('SHADOW_NOT_READY', 'Для книги ещё нет готовой v3-разметки', 404)
      }
      return manifest
    },

    async advanceProgress(
      subjectId,
      bookEditionId,
      { progressFraction, textOffset, chapterKey, sectionIndex, sectionFraction }
    ) {
      if (typeof analysisRepository?.ensureLatestMediaProjection === 'function') {
        await analysisRepository.ensureLatestMediaProjection(bookEditionId)
      }
      const progress = await store.advanceReaderPosition({
        subjectId,
        bookEditionId,
        progressFraction,
        textOffset,
        chapterKey,
        sectionIndex,
        sectionFraction
      })
      if (!progress) throw serviceError('NOT_FOUND', 'Книга не найдена', 404)

      const correction = await enabledCorrection({
        bookEditionId,
        markup: progress.markupVersionId && progress.markupInputHash
          ? { id: progress.markupVersionId, inputHash: progress.markupInputHash }
          : null
      })

      const charactersDue = analysisRepository
        ? progress.analysisVersion === BOOK_ANALYSIS_MARKUP_VERSION
          ? progress.charactersDue
          : []
        : progress.scope === 'catalog' ? [] : progress.charactersDue
      const correctedDue = [...new Map(charactersDue
        .map((character) => {
          const characterKey = resolveCorrectedCharacterKey(character.characterKey, correction)
          return characterKey ? [characterKey, { ...character, characterKey }] : null
        })
        .filter(Boolean)).values()]
      const requests = await Promise.allSettled(correctedDue.map((character) =>
        ensureCharacterBundle(store, {
          bookEditionId,
          characterKey: character.characterKey,
          bundleVersion: analysisRepository
            ? BOOK_ANALYSIS_CHARACTER_BUNDLE_VERSION
            : bundleVersion
        })
      ))
      const warmed = { ready: 0, pending: 0, failed: 0 }
      for (const request of requests) {
        if (request.status === 'rejected') warmed.failed += 1
        else if (request.value.status === 'ready') warmed.ready += 1
        else warmed.pending += 1
      }
      return {
        bookEditionId,
        readerTextOffset: progress.readerTextOffset,
        readingFraction: progress.readingFraction,
        chapterKey: progress.chapterKey,
        readerSectionIndex: progress.readerSectionIndex,
        readerSectionFraction: progress.readerSectionFraction,
        warmup: {
          requested: requests.length,
          ...warmed
        },
        sceneWarmup: { requested: 0, ready: 0, pending: 0, failed: 0 }
      }
    }
  }
}
