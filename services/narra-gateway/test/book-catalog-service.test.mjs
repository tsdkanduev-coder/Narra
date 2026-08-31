import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { REQUIRED_CHARACTER_MEDIA } from '../book-markup.mjs'
import { decodeBookContentCursor } from '../book-content.mjs'
import { createBookCatalogService } from '../book-catalog-service.mjs'

const HASH = 'a'.repeat(64)
const EDITION = {
  id: 'book-1',
  scope: 'private',
  contentSha256: HASH,
  title: 'Book',
  author: 'Author',
  format: 'epub',
  status: 'base_ready',
  createdAt: '2026-08-10T00:00:00.000Z'
}

function repository(overrides = {}) {
  return {
    async listCatalogBooks() { return { items: [], nextCursor: null } },
    async resolveBook() { return null },
    async getReaderBookManifest() { return null },
    async advanceReaderPosition() { return null },
    async ensureCharacterBundle() { return { status: 'queued' } },
    ...overrides
  }
}

function readyBundle(characterKey) {
  return {
    version: 'character-bundle-v1',
    status: 'ready',
    assets: REQUIRED_CHARACTER_MEDIA.map((type) => ({
      assetId: `${characterKey}-${type}`,
      type,
      contentHash: HASH,
      mimeType: 'application/octet-stream',
      byteSize: 10,
      status: 'ready'
    }))
  }
}

test('manifest never leaks a future character even when its global bundle is ready', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookManifest() {
        return {
          edition: EDITION,
          readerTextOffset: 50,
          readingFraction: 0.05,
          markup: {
            schemaVersion: 2,
            analysisVersion: 'book-markup-v2',
            revision: 1,
            textLength: 1_000,
            publishedAt: '2026-08-10T00:00:00.000Z'
          },
          characters: [
            {
              characterKey: 'visible', name: 'Visible', fullName: 'Visible Hero',
              warmupTextOffset: 0, firstAppearanceTextOffset: 20, data: { role: 'hero' },
              bundle: readyBundle('visible')
            },
            {
              characterKey: 'future', name: 'Future', fullName: 'Future Hero',
              warmupTextOffset: 30, firstAppearanceTextOffset: 100, data: { spoiler: true },
              bundle: readyBundle('future')
            }
          ]
        }
      }
    })
  })
  const manifest = await service.manifest('reader-1', 'book-1')
  assert.deepEqual(manifest.characters.map(({ characterKey }) => characterKey), ['visible'])
  assert.equal(manifest.characters[0].state, 'ready')
  assert.equal(manifest.characters[0].bundle.assets.length, REQUIRED_CHARACTER_MEDIA.length)
})

test('manifest exposes ready assets while the remaining character media is still preparing', async () => {
  const partial = readyBundle('hero')
  partial.assets.pop()
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookManifest() {
        return {
          edition: EDITION,
          readerTextOffset: 100,
          readingFraction: 0.1,
          markup: {
            schemaVersion: 2, analysisVersion: 'book-markup-v2', revision: 1,
            textLength: 1_000, publishedAt: ''
          },
          characters: [{
            characterKey: 'hero', name: 'Hero', fullName: 'The Hero',
            warmupTextOffset: 0, firstAppearanceTextOffset: 10, data: {}, bundle: partial
          }]
        }
      }
    })
  })
  const manifest = await service.manifest('reader-1', 'book-1')
  assert.equal(manifest.characters[0].state, 'preparing')
  assert.equal(manifest.characters[0].bundle.assets.length, REQUIRED_CHARACTER_MEDIA.length - 1)
})

test('catalog manifest exposes validated v3 as the canonical markup', async () => {
  const calls = []
  const publicSnapshot = {
    edition: { ...EDITION, scope: 'catalog', catalogKey: 'book' },
    readerTextOffset: 100,
    readingFraction: 0.5,
    markup: {
      schemaVersion: 2,
      analysisVersion: 'book-markup-v2',
      revision: 7,
      textLength: 1_000,
      publishedAt: '2026-08-10T00:00:00.000Z'
    },
    characters: [{
      characterKey: 'visible', name: 'Visible', fullName: 'Visible Hero',
      warmupTextOffset: 850, firstAppearanceTextOffset: 900,
      data: { analysisSource: 'v3' }, bundle: readyBundle('visible')
    }]
  }
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookManifest(input) {
        calls.push(['manifest', input.bundleVersion])
        return publicSnapshot
      }
    }),
    analysisRepository: {
      async ensureLatestMediaProjection(bookEditionId) {
        calls.push(['projection', bookEditionId])
        return { projected: true }
      },
      async getLatestShadowAnalysisPublication(bookEditionId) {
        assert.equal(bookEditionId, EDITION.id)
        return {
          id: 'publication-v3',
          runId: 'run-v3',
          bookEditionId,
          channel: 'shadow',
          analysisVersion: 'book-markup-v3',
          contentHash: HASH,
          publishedAt: '2026-08-13T12:00:00.000Z',
          data: {
            markup: {
              schemaVersion: 3,
              analysisVersion: 'book-markup-v3',
              snapshotId: 'snapshot-v3',
              textLength: 2_000,
              characters: [
                {
                  characterKey: 'visible',
                  name: 'Visible',
                  fullName: 'Visible',
                  aliases: [],
                  identityEvidenceIds: ['identity-visible'],
                  firstAppearanceTextOffset: 900,
                  warmupTextOffset: 850,
                  role: { value: 'Главный герой', evidenceIds: ['role-1'], confidence: 0.9 },
                  age: null,
                  gender: null,
                  description: {
                    value: 'Подробное описание главного героя.',
                    evidenceIds: ['description-1'],
                    confidence: 0.9
                  },
                  traits: [{ value: 'смелый', evidenceIds: ['trait-1'], confidence: 0.8 }],
                  personalityTimelineVersion: 'progressive-personality-v1',
                  personalitySnapshots: [{
                    cutoffTextOffset: 200,
                    status: 'preliminary',
                    traits: [{
                      value: 'наблюдательный', evidenceIds: ['trait-0'], confidence: 0.65,
                      evidenceLevel: 'single_scene'
                    }]
                  }, {
                    cutoffTextOffset: 1_000,
                    status: 'supported',
                    traits: [{
                      value: 'смелый', evidenceIds: ['trait-1'], confidence: 0.8,
                      evidenceLevel: 'repeated'
                    }]
                  }],
                  speechStyle: null,
                  speechExamples: [],
                  appearance: [],
                  creative: { greeting: 'Здравствуйте', appearancePrompt: '', voice: 'Che' }
                },
                {
                  characterKey: 'future',
                  name: 'Future',
                  fullName: 'Future',
                  aliases: [],
                  identityEvidenceIds: ['identity-future'],
                  firstAppearanceTextOffset: 1_500,
                  warmupTextOffset: 1_400,
                  role: null,
                  age: null,
                  gender: null,
                  description: null,
                  traits: [],
                  speechStyle: null,
                  speechExamples: [],
                  appearance: [],
                  creative: {}
                }
              ],
              locations: [],
              events: [],
              relationships: [],
              storyArcs: []
            }
          }
        }
      }
    }
  })

  const preview = await service.manifest('reader-1', EDITION.id)

  assert.equal(preview.source, 'v3')
  assert.equal(preview.availability, 'ready')
  assert.equal(preview.publicationId, 'publication-v3')
  assert.equal(preview.readerTextOffset, 1_000)
  assert.deepEqual(
    preview.characters.map(({ characterKey, profile }) => ({
      characterKey,
      traits: profile.traits
    })),
    [{ characterKey: 'visible', traits: ['смелый'] }]
  )
  assert.equal(preview.characters[0].state, 'ready')
  assert.equal(
    preview.characters[0].profile.description,
    'Подробное описание главного героя.'
  )
  assert.equal(preview.characters[0].fullName, '')
  assert.equal(
    preview.characters[0].profile.personalityTimelineVersion,
    'progressive-personality-v1'
  )
  assert.deepEqual(preview.characters[0].profile.personalitySnapshots, [{
    cutoffTextOffset: 200,
    status: 'preliminary',
    traits: [{
      value: 'наблюдательный', confidence: 0.65, evidenceLevel: 'single_scene'
    }]
  }, {
    cutoffTextOffset: 1_000,
    status: 'supported',
    traits: [{ value: 'смелый', confidence: 0.8, evidenceLevel: 'repeated' }]
  }])
  assert.equal(preview.characters[0].bundle.assets.length, REQUIRED_CHARACTER_MEDIA.length)
  assert.equal(preview.markup.analysisVersion, 'book-markup-v3')
  assert.deepEqual(calls.slice(0, 2), [
    ['projection', EDITION.id],
    ['manifest', 'character-bundle-v3']
  ])
})

test('catalog manifest does not fall back to legacy v2 while v3 is processing', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookManifest() {
        return {
          edition: { ...EDITION, scope: 'catalog', catalogKey: 'book' },
          readerTextOffset: 100,
          readingFraction: 0.1,
          markup: {
            schemaVersion: 2,
            analysisVersion: 'book-markup-v2',
            revision: 7,
            textLength: 1_000,
            publishedAt: '2026-08-10T00:00:00.000Z'
          },
          characters: [{ characterKey: 'legacy-character' }]
        }
      }
    }),
    analysisRepository: {
      async getLatestShadowAnalysisPublication() { return null }
    }
  })

  const manifest = await service.manifest('reader-1', EDITION.id)

  assert.equal(manifest.source, 'v3')
  assert.equal(manifest.availability, 'processing')
  assert.equal(manifest.markup, null)
  assert.deepEqual(manifest.characters, [])
})

test('processing v3 manifest exposes only reader-visible provisional characters', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookManifest() {
        return {
          edition: { ...EDITION, sourceStorage: 'temporary' },
          readerTextOffset: 500,
          readingFraction: 0.25,
          markup: null,
          characters: []
        }
      }
    }),
    analysisRepository: {
      async getLatestShadowAnalysisPublication() { return null },
      async getLatestAnalysisPreview() {
        return {
          run: {
            id: 'run-v3', stage: 'scan', status: 'running', textLength: 2_000
          },
          scan: { completedChunks: 12, totalChunks: 50 },
          characters: [
            {
              characterKey: 'provisional:visible',
              name: 'Джейн', fullName: 'Джейн',
              firstAppearanceTextOffset: 100
            },
            {
              characterKey: 'provisional:future',
              name: 'Рочестер', fullName: 'Рочестер',
              firstAppearanceTextOffset: 900
            }
          ]
        }
      }
    }
  })

  const manifest = await service.manifest('reader-1', EDITION.id)

  assert.equal(manifest.availability, 'processing')
  assert.equal(manifest.runId, 'run-v3')
  assert.equal(manifest.readerTextOffset, 500)
  assert.deepEqual(manifest.analysis, {
    stage: 'scan', status: 'running', textLength: 2_000,
    completedScanChunks: 12, totalScanChunks: 50
  })
  assert.deepEqual(manifest.characters, [{
    characterKey: 'provisional:visible',
    name: 'Джейн',
    fullName: '',
    firstAppearanceTextOffset: 100,
    provisional: true,
    state: 'preparing',
    profile: {
      role: 'Профиль формируется',
      traits: [], speechStyle: '', speechExamples: [], appearancePrompt: '', greeting: '',
      analysisSource: 'v3', provisional: true
    },
    bundle: null
  }])
})

test('private manifest uses canonical v3 and never falls back to client-derived v2', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookManifest() {
        return {
          edition: { ...EDITION, sourceStorage: 'temporary' },
          readerTextOffset: 154_110,
          readingFraction: 0.15411,
          markup: {
            schemaVersion: 2,
            analysisVersion: 'book-markup-v2',
            revision: 1,
            textLength: 1_000_000,
            publishedAt: '2026-08-10T00:00:00.000Z'
          },
          characters: []
        }
      }
    }),
    analysisRepository: {
      async getLatestShadowAnalysisPublication() { return null }
    }
  })

  const manifest = await service.manifest('reader-1', EDITION.id)

  assert.equal(manifest.source, 'v3')
  assert.equal(manifest.availability, 'processing')
  assert.equal(manifest.markup, null)
  assert.deepEqual(manifest.characters, [])
})

test('private source upload verifies bytes, persists a temporary source and starts v3', async () => {
  const bytes = Buffer.from('private epub fixture')
  const contentSha256 = createHash('sha256').update(bytes).digest('hex')
  const calls = []
  const edition = {
    ...EDITION,
    contentSha256,
    status: 'marking_up',
    sourceStorage: 'temporary',
    expiresAt: '2026-08-17T00:00:00.000Z'
  }
  const service = createBookCatalogService({
    repository: repository({
      async beginPrivateBookUpload(input) {
        calls.push(['begin', input])
        return {
          edition: { ...edition, sourceStorage: 'local_only' },
          uploadRequired: true,
          file: {
            objectKey: `books/private/reader-1/${contentSha256}/source`,
            contentSha256,
            mimeType: 'application/epub+zip',
            byteSize: bytes.byteLength
          }
        }
      },
      async completePrivateBookUpload(input) {
        calls.push(['complete', input])
        return edition
      }
    }),
    analysisRepository: {
      async ensureAnalysisRun(input) {
        calls.push(['analysis', input])
        return {
          run: { id: 'run-v3', stage: 'prepare', status: 'queued' },
          prepareJob: { id: 'job-v3', status: 'queued' },
          created: true
        }
      }
    },
    storage: {
      async putBytes(input) {
        calls.push(['store', input])
        return {
          objectKey: input.objectKey,
          contentHash: contentSha256,
          mimeType: input.mimeType,
          byteSize: input.bytes.byteLength
        }
      }
    }
  })

  const result = await service.uploadLocalSource(
    'reader-1',
    EDITION.id,
    bytes,
    'application/epub+zip'
  )

  assert.equal(result.sourceUploaded, true)
  assert.equal(result.analysisRunId, 'run-v3')
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'store', 'complete', 'analysis'])
})

test('progress requests every character behind the markup warmup frontier', async () => {
  const ensured = []
  const service = createBookCatalogService({
    repository: repository({
      async advanceReaderPosition() {
        return {
          readerTextOffset: 90,
          readingFraction: 0.09,
          chapterKey: 'chapter-2',
          charactersDue: [
            { characterKey: 'hero', warmupTextOffset: 0, firstAppearanceTextOffset: 10 },
            { characterKey: 'future', warmupTextOffset: 80, firstAppearanceTextOffset: 120 }
          ]
        }
      },
      async ensureCharacterBundle(input) {
        ensured.push(input)
        return { status: input.characterKey === 'hero' ? 'ready' : 'running' }
      }
    })
  })
  const result = await service.advanceProgress('reader-1', 'book-1', {
    progressFraction: 0.09,
    textOffset: null,
    chapterKey: 'chapter-2'
  })
  assert.deepEqual(ensured.map(({ characterKey }) => characterKey), ['hero', 'future'])
  assert.equal(result.readingFraction, 0.09)
  assert.deepEqual(result.warmup, { requested: 2, ready: 1, pending: 1, failed: 0 })
})

test('catalog progress never queues legacy v2 character bundles', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async advanceReaderPosition() {
        return {
          scope: 'catalog',
          readerTextOffset: 90,
          readingFraction: 0.09,
          chapterKey: 'chapter-2',
          charactersDue: [{ characterKey: 'legacy-v2-character' }]
        }
      },
      async ensureCharacterBundle() {
        throw new Error('legacy v2 character bundle must not be queued for catalog books')
      }
    })
  })

  const result = await service.advanceProgress('reader-1', 'book-1', {
    progressFraction: 0.09,
    textOffset: null,
    chapterKey: 'chapter-2'
  })

  assert.deepEqual(result.warmup, { requested: 0, ready: 0, pending: 0, failed: 0 })
})

test('progress with analysis repository queues charactersDue without a v3 cutoff', async () => {
  const ensured = []
  const service = createBookCatalogService({
    repository: repository({
      async advanceReaderPosition() {
        return {
          scope: 'private',
          analysisVersion: 'book-markup-v2',
          readerTextOffset: 90,
          readingFraction: 0.09,
          chapterKey: 'chapter-2',
          charactersDue: [{
            characterKey: 'character:hero',
            warmupTextOffset: 80,
            firstAppearanceTextOffset: 120
          }]
        }
      },
      async ensureCharacterBundle(input) {
        ensured.push(input)
        return { status: 'queued' }
      }
    }),
    analysisRepository: {
      async ensureLatestMediaProjection() { return { projected: true } }
    }
  })

  const result = await service.advanceProgress('reader-1', 'book-1', {
    progressFraction: 0.09,
    textOffset: null,
    chapterKey: 'chapter-2'
  })

  assert.equal(ensured.length, 1)
  assert.equal(ensured[0].characterKey, 'character:hero')
  assert.equal(ensured[0].bundleVersion, 'character-bundle-v3')
  assert.deepEqual(result.warmup, { requested: 1, ready: 0, pending: 1, failed: 0 })
})

test('canonical v3 progress queues media for characters behind the warmup frontier', async () => {
  const ensured = []
  const service = createBookCatalogService({
    repository: repository({
      async advanceReaderPosition() {
        return {
          scope: 'private',
          analysisVersion: 'book-markup-v3',
          readerTextOffset: 90,
          readingFraction: 0.09,
          chapterKey: 'chapter-2',
          charactersDue: [{
            characterKey: 'character:hero',
            warmupTextOffset: 80,
            firstAppearanceTextOffset: 120
          }]
        }
      },
      async ensureCharacterBundle(input) {
        ensured.push(input)
        return { status: 'queued' }
      }
    }),
    analysisRepository: {
      async ensureLatestMediaProjection() { return { projected: true } }
    }
  })

  const result = await service.advanceProgress('reader-1', 'book-1', {
    progressFraction: 0.09,
    textOffset: null,
    chapterKey: 'chapter-2'
  })

  assert.equal(ensured.length, 1)
  assert.equal(ensured[0].bookEditionId, 'book-1')
  assert.equal(ensured[0].characterKey, 'character:hero')
  assert.equal(ensured[0].bundleVersion, 'character-bundle-v3')
  assert.deepEqual(result.warmup, { requested: 1, ready: 0, pending: 1, failed: 0 })
})

test('canonical progress extends durable scene prefetch from the server position', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async advanceReaderPosition() {
        return {
          scope: 'private',
          analysisVersion: 'book-markup-v3',
          readerTextOffset: 36_000,
          readingFraction: 0.36,
          chapterKey: 'chapter-4',
          charactersDue: []
        }
      },
      async ensureBookScenesThrough(input) {
        calls.push(input)
        return { requested: 2, ready: 1, pending: 1, failed: 0 }
      }
    }),
    analysisRepository: {
      async ensureLatestMediaProjection() { return { projected: true } }
    }
  })

  const result = await service.advanceProgress('reader-1', 'book-1', {
    progressFraction: 0.36,
    textOffset: null,
    chapterKey: 'chapter-4'
  })

  assert.deepEqual(calls, [{
    subjectId: 'reader-1',
    bookEditionId: 'book-1',
    readerTextOffset: 36_000
  }])
  assert.deepEqual(result.sceneWarmup, { requested: 2, ready: 1, pending: 1, failed: 0 })
})

test('scene lookup returns a signed ready asset and never accepts scene text from the client', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async ensureReaderBookScene(input) {
        calls.push(['resolve', input])
        return {
          status: 'ready',
          sceneKey: 'text-interval-v1:6',
          slotIndex: 6,
          anchorTextOffset: 39_000,
          asset: { objectKey: 'generated/private/book-1/scenes/6.png', mimeType: 'image/png' }
        }
      }
    }),
    storage: {
      async createDownload(input) {
        calls.push(['sign', input])
        return { url: 'https://storage/scene', expiresAt: '2026-08-22T15:00:00.000Z' }
      }
    }
  })

  const result = await service.sceneAt('reader-1', 'book-1', {
    readerTextOffset: 38_500,
    progressFraction: null
  })

  assert.deepEqual(calls[0], ['resolve', {
    subjectId: 'reader-1',
    bookEditionId: 'book-1',
    readerTextOffset: 38_500,
    progressFraction: null
  }])
  assert.equal(result.status, 'ready')
  assert.equal(result.imageUrl, 'https://storage/scene')
  assert.equal(calls[1][0], 'sign')
})

test('sceneAt fills normalized text from the book file when analysis columns are empty', async () => {
  const sourceText = 'Анна открыла дверь и вошла в зал.'
  const sourceBytes = Buffer.from(sourceText, 'utf8')
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
  const textHash = createHash('sha256').update(sourceText).digest('hex')
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async getNormalizedSceneText() { return null },
      async getAccessibleBookFile() {
        return {
          objectKey: 'books/private/book-1/source.txt',
          mimeType: 'text/plain',
          byteSize: sourceBytes.byteLength,
          contentHash: sourceHash,
          format: 'txt'
        }
      },
      async saveNormalizedSceneText(input) {
        calls.push(['save', input])
        return { runId: 'run-1' }
      },
      async ensureReaderBookScene(input) {
        calls.push(['resolve', input])
        return {
          status: 'queued',
          sceneKey: 'text-interval-v1:0',
          slotIndex: 0,
          anchorTextOffset: 0
        }
      }
    }),
    storage: {
      async getBytes({ objectKey }) {
        calls.push(['get', objectKey])
        return { bytes: sourceBytes }
      },
      async putBytes(input) {
        calls.push(['put', input.objectKey])
        return {
          objectKey: input.objectKey,
          contentHash: createHash('sha256').update(input.bytes).digest('hex')
        }
      },
      async createDownload() {
        throw new Error('must not sign a queued scene')
      }
    }
  })

  const result = await service.sceneAt('reader-1', 'book-1', {
    readerTextOffset: 10,
    progressFraction: null
  })
  assert.equal(result.status, 'queued')
  assert.deepEqual(calls.find(([name]) => name === 'resolve')?.[1], {
    subjectId: 'reader-1',
    bookEditionId: 'book-1',
    readerTextOffset: 10,
    progressFraction: null,
    normalizedTextObjectKey: 'analysis/ondemand/book-1/normalized-text-v1.txt',
    normalizedTextHash: textHash
  })
  assert.deepEqual(calls.find(([name]) => name === 'save')?.[1], {
    bookEditionId: 'book-1',
    objectKey: 'analysis/ondemand/book-1/normalized-text-v1.txt',
    contentHash: textHash,
    textLength: sourceText.length
  })
})

test('sceneAt reuses prepared normalized text and does not re-extract the book file', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async getNormalizedSceneText() {
        return {
          objectKey: 'analysis/run-2/normalized-text-v1.txt',
          contentHash: HASH
        }
      },
      async getAccessibleBookFile() {
        throw new Error('must not open the source file')
      },
      async ensureReaderBookScene(input) {
        calls.push(input)
        return {
          status: 'queued',
          sceneKey: 'text-interval-v1:0',
          slotIndex: 0,
          anchorTextOffset: 0
        }
      }
    }),
    storage: {
      async getBytes() { throw new Error('must not download') },
      async putBytes() { throw new Error('must not upload') }
    }
  })

  const result = await service.sceneAt('reader-1', 'book-1', {
    readerTextOffset: 10,
    progressFraction: null
  })
  assert.equal(result.status, 'queued')
  assert.equal(calls[0].normalizedTextObjectKey, 'analysis/run-2/normalized-text-v1.txt')
  assert.equal(calls[0].normalizedTextHash, HASH)
})

test('local hash reuses a ready catalog edition and otherwise requests local registration', async () => {
  const catalog = { ...EDITION, id: 'catalog-1', scope: 'catalog', catalogKey: 'book' }
  const service = createBookCatalogService({
    repository: repository({
      async resolveBook({ contentSha256 }) {
        return contentSha256 === HASH ? catalog : null
      }
    })
  })
  assert.equal((await service.resolve('reader-1', {
    source: 'local', contentSha256: HASH
  })).resolution, 'catalog')
  assert.deepEqual(await service.resolve('reader-1', {
    source: 'local', contentSha256: 'b'.repeat(64)
  }), {
    resolution: 'local_registration_required',
    contentSha256: 'b'.repeat(64),
    ready: false
  })
})

test('book identity can become ready before the full manifest', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookIdentity(input) {
        assert.deepEqual(input, { subjectId: 'reader-1', bookEditionId: 'book-1' })
        return {
          version: 'book-identity-v1', bookEditionId: 'book-1', status: 'ready',
          title: 'Мертвое озеро', author: 'Николай Некрасов', source: 'llm',
          updatedAt: '2026-08-25T10:00:00.000Z'
        }
      }
    })
  })
  assert.deepEqual(await service.identity('reader-1', 'book-1'), {
    version: 'book-identity-v1', bookEditionId: 'book-1', status: 'ready',
    title: 'Мертвое озеро', author: 'Николай Некрасов', source: 'llm',
    updatedAt: '2026-08-25T10:00:00.000Z', pollAfterMs: undefined
  })
})

test('book identity polling exposes a bounded retry interval while the job is processing', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookIdentity() {
        return { version: 'book-identity-v1', bookEditionId: 'book-1', status: 'processing' }
      }
    })
  })
  assert.equal((await service.identity('reader-1', 'book-1')).pollAfterMs, 2_000)
})

test('catalog listing never receives processing editions from the service contract', async () => {
  const catalog = {
    ...EDITION,
    id: 'catalog-1',
    scope: 'catalog',
    catalogKey: 'book',
    language: 'ru',
    genres: ['literary-fiction', 'psychology-self-help'],
    cover: {
      objectKey: 'catalog/book/cover',
      contentHash: HASH,
      mimeType: 'image/jpeg',
      byteSize: 42
    }
  }
  const service = createBookCatalogService({
    repository: repository({
      async listCatalogBooks() {
        return {
          items: [catalog],
          nextCursor: { createdAt: catalog.createdAt, id: catalog.id }
        }
      }
    })
  })
  const result = await service.listCatalog({ limit: 1, cursor: null })
  assert.equal(result.items[0].ready, true)
  assert.equal(result.items[0].language, 'ru')
  assert.deepEqual(result.items[0].genres, ['literary-fiction', 'psychology-self-help'])
  assert.deepEqual(result.items[0].cover, {
    contentHash: HASH,
    mimeType: 'image/jpeg',
    byteSize: 42,
    downloadPath: '/v2/books/catalog-1/cover/download'
  })
  assert.deepEqual(result.nextCursor, { createdAt: catalog.createdAt, id: catalog.id })
})

test('language catalog listing binds the requested category to the repository', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async listCatalogBooks(input) {
        calls.push(input)
        return { items: [{ ...EDITION, scope: 'catalog', catalogKey: 'book', language: 'en' }], nextCursor: null }
      }
    })
  })
  const result = await service.listCatalogByLanguage({ language: 'en', limit: 24, cursor: null })
  assert.deepEqual(calls, [{ language: 'en', limit: 24, cursor: null }])
  assert.equal(result.items[0].language, 'en')
})

test('catalog cover download is authorized before storage signing', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async getCatalogBookCover(input) {
        calls.push(['authorize-cover', input])
        return { objectKey: 'catalog/cover', mimeType: 'image/jpeg' }
      }
    }),
    storage: {
      async createDownload(input) {
        calls.push(['sign-cover', input])
        return { url: 'https://storage/cover', expiresAt: '' }
      }
    }
  })
  assert.equal((await service.coverDownload('reader', 'book')).url, 'https://storage/cover')
  assert.equal(calls[0][0], 'authorize-cover')
  assert.equal(calls[1][0], 'sign-cover')
})

test('local registration and markup store only metadata and derived character profiles', async () => {
  const calls = []
  const privateEdition = {
    ...EDITION,
    id: 'book-private',
    status: 'draft',
    sourceStorage: 'local_only',
    expiresAt: '2026-08-17T00:00:00.000Z'
  }
  const store = repository({
    async registerLocalBook(input) {
      calls.push(['register', input])
      return privateEdition
    },
    async publishLocalBookMarkup(input) {
      calls.push(['publish', input])
      return {
        edition: { ...privateEdition, status: 'base_ready' },
        revision: 1,
        created: true
      }
    }
  })
  const service = createBookCatalogService({
    repository: store,
    idFactory: () => 'edition-proposed'
  })
  const registered = await service.registerLocalBook('reader', {
    contentSha256: HASH,
    title: 'Book', author: 'Author', format: 'epub', language: 'en'
  })
  assert.equal(registered.sourceDownloadPath, undefined)
  assert.equal(calls[0][1].proposedBookEditionId, 'edition-proposed')
  assert.equal(calls[0][1].language, 'en')

  const published = await service.publishLocalMarkup('reader', 'book-private', {
    characters: [{
      characterKey: 'hero', name: 'Hero', fullName: 'The Hero',
      firstAppearanceFraction: 0.2, warmupFraction: 0.15,
      profile: { role: 'protagonist' }
    }]
  })
  assert.equal(published.ready, true)
  const payload = calls.at(-1)[1]
  assert.equal(payload.characters[0].firstAppearanceTextOffset, 200_000)
  assert.equal(payload.characters[0].warmupTextOffset, 150_000)
  assert.equal('source' in payload, false)
})

test('media download is authorized by the repository before storage signing', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async getReaderMediaAsset(input) {
        calls.push(['authorize', input])
        return { objectKey: 'private/media', mimeType: 'image/png' }
      }
    }),
    storage: {
      async createDownload(input) {
        calls.push(['sign', input])
        return { url: 'https://storage/signed', expiresAt: '' }
      }
    }
  })
  assert.equal((await service.mediaDownload('reader', 'book', 'asset')).url, 'https://storage/signed')
  assert.equal(calls[0][0], 'authorize')
  assert.equal(calls[1][0], 'sign')
})

test('full catalog content signs the prepared text object without loading it', async () => {
  const calls = []
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookContent(input) {
        calls.push(['authorize', input])
        return {
          bookEditionId: 'book-1',
          objectKey: 'analysis/run-1/normalized-text-v1.txt',
          contentHash: HASH,
          textLength: 4,
          normalizationVersion: 'normalized-text-v1'
        }
      }
    }),
    storage: {
      async getObjectInfo(input) {
        calls.push(['info', input])
        return { byteSize: 8 }
      },
      async createDownload(input) {
        calls.push(['sign', input])
        return { url: 'https://storage/content', expiresAt: '2026-08-22T12:00:00.000Z' }
      }
    }
  })

  const result = await service.fullContent('reader-1', 'book-1')
  assert.equal(result.contentHash, HASH)
  assert.equal(result.byteSize, 8)
  assert.equal(result.url, 'https://storage/content')
  assert.deepEqual(calls.map(([name]) => name), ['authorize', 'info', 'sign'])
})

test('catalog content chunks start immediately and continue with an opaque cursor', async () => {
  const bytes = Buffer.from('абвг')
  const ranges = []
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookContent() {
        return {
          bookEditionId: 'book-1',
          objectKey: 'analysis/run-1/normalized-text-v1.txt',
          contentHash: HASH,
          textLength: 4,
          normalizationVersion: 'normalized-text-v1'
        }
      }
    }),
    storage: {
      async getObjectInfo() { return { byteSize: bytes.byteLength } },
      async getBytesRange(input) {
        ranges.push(input)
        return { bytes: bytes.subarray(input.startByte, input.endByteExclusive) }
      }
    },
    contentChunkChars: 2
  })

  const first = await service.contentChunk('reader-1', 'book-1', null)
  assert.equal(first.chunk.text, 'аб')
  assert.equal(first.chunk.startByte, 0)
  assert.equal(first.chunk.endByteExclusive, 4)
  assert.ok(first.nextCursor)
  assert.equal(decodeBookContentCursor(first.nextCursor).byteOffset, 4)

  const second = await service.contentChunk('reader-1', 'book-1', first.nextCursor)
  assert.equal(second.chunk.text, 'вг')
  assert.equal(second.chunk.startByte, 4)
  assert.equal(second.chunk.endByteExclusive, 8)
  assert.equal(second.nextCursor, null)
  const toc = await service.contentToc('reader-1', 'book-1')
  assert.equal(toc.source, 'fixed')
  assert.equal(toc.items.length, 1)
  assert.deepEqual(ranges.map(({ startByte, endByteExclusive }) => [startByte, endByteExclusive]), [
    [0, 8],
    [4, 8]
  ])
})

test('catalog reader chunks stop at chapters and split only an oversized chapter', async () => {
  const bytes = Buffer.from('AAAAABBBBBBBB')
  const navigation = {
    version: 'book-navigation-v1',
    source: 'nav',
    items: [
      { key: 'toc-1', title: 'One', level: 0, parentKey: null, sectionKey: 'one' },
      { key: 'toc-2', title: 'Two', level: 0, parentKey: null, sectionKey: 'two' }
    ],
    segments: [
      { key: 'one', title: 'One', startByte: 0, endByte: 5 },
      { key: 'two', title: 'Two', startByte: 5, endByte: 13 }
    ]
  }
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookContent() {
        return {
          bookEditionId: 'book-1', objectKey: 'analysis/run-1/text.txt',
          contentHash: HASH, textLength: bytes.length,
          normalizationVersion: 'normalized-text-v1', navigation
        }
      }
    }),
    storage: {
      async getObjectInfo() { return { byteSize: bytes.length } },
      async getBytesRange(input) {
        return { bytes: bytes.subarray(input.startByte, input.endByteExclusive) }
      }
    },
    contentChunkChars: 6
  })

  const first = await service.contentChunk('reader-1', 'book-1', null)
  assert.equal(first.chunk.text, 'AAAAA')
  assert.equal(first.section.key, 'one')
  assert.equal(first.sectionComplete, true)

  const second = await service.contentChunk('reader-1', 'book-1', first.nextCursor)
  assert.equal(second.chunk.text, 'BBBBBB')
  assert.equal(second.section.key, 'two')
  assert.equal(second.sectionComplete, false)

  const third = await service.contentChunk('reader-1', 'book-1', second.nextCursor)
  assert.equal(third.chunk.text, 'BB')
  assert.equal(third.section.key, 'two')
  assert.equal(third.sectionComplete, true)
  assert.equal(third.nextCursor, null)

  const toc = await service.contentToc('reader-1', 'book-1')
  assert.equal(toc.source, 'nav')
  assert.deepEqual(toc.items.map(({ title, startByte, endByte }) =>
    [title, startByte, endByte]), [
    ['One', 0, 5],
    ['Two', 5, 13]
  ])
})

test('catalog content rejects a cursor from another content version', async () => {
  const service = createBookCatalogService({
    repository: repository({
      async getReaderBookContent() {
        return {
          bookEditionId: 'book-1', objectKey: 'analysis/run-2/text.txt',
          contentHash: 'b'.repeat(64), textLength: 4,
          normalizationVersion: 'normalized-text-v1'
        }
      }
    }),
    storage: {
      async getObjectInfo() { return { byteSize: 8 } },
      async getBytesRange() { assert.fail('stale cursor must not read storage') }
    }
  })
  const stale = Buffer.from(JSON.stringify({ v: 1, h: HASH, o: 4 })).toString('base64url')
  await assert.rejects(
    () => service.contentChunk('reader-1', 'book-1', stale),
    (error) => error.code === 'CONTENT_VERSION_CHANGED' && error.status === 409
  )
})
