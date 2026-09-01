import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('P0: loadSceneContext accepts any published markup, not only v3+shadow', async () => {
  const source = await readFile(
    new URL('../postgres-book-markup-repository.mjs', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('async function loadSceneContext')
  const end = source.indexOf('async function ensureSceneSlot')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const fn = source.slice(start, end)
  assert.match(fn, /markup\.status = 'published'/)
  assert.doesNotMatch(fn, /markup\.analysis_version = 'book-markup-v3'/)
  assert.doesNotMatch(fn, /AND value\.channel = 'shadow'/)
  assert.match(fn, /FROM book_analysis_publications/)
  assert.match(fn, /FROM book_analysis_runs/)
})

test('P0: ensureSceneSlot requeues failed scene_image at prefetch priority 45', async () => {
  const source = await readFile(
    new URL('../postgres-book-markup-repository.mjs', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('async function ensureSceneSlot')
  const end = source.indexOf('function identityJobSpec')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const fn = source.slice(start, end)
  assert.match(fn, /job\.status === 'failed' && priority >= 45/)
  assert.doesNotMatch(fn, /priority >= 70/)
})

test('P0: enqueueBookMarkupBackfill resets failed book_markup to queued', async () => {
  const source = await readFile(
    new URL('../postgres-book-markup-repository.mjs', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('async enqueueBookMarkupBackfill')
  const end = source.indexOf('async enqueueBookIdentity')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const fn = source.slice(start, end)
  assert.match(fn, /AND job\.status <> 'failed'/)
  assert.match(fn, /row\.status === 'failed'/)
  assert.match(fn, /SET status = 'queued'/)
  assert.match(fn, /edition\.scope = 'private'/)
})

test('P0: catalog marking_up starts book-analysis, not legacy v2 markup jobs', async () => {
  const markup = await readFile(
    new URL('../postgres-book-markup-repository.mjs', import.meta.url),
    'utf8'
  )
  const ingest = await readFile(
    new URL('../catalog-ingest-service.mjs', import.meta.url),
    'utf8'
  )
  const analysis = await readFile(
    new URL('../book-analysis-repository.mjs', import.meta.url),
    'utf8'
  )
  const gateway = await readFile(
    new URL('../index.mjs', import.meta.url),
    'utf8'
  )
  const backfill = markup.slice(
    markup.indexOf('async enqueueBookMarkupBackfill'),
    markup.indexOf('async enqueueBookIdentity')
  )
  const catalogBackfill = analysis.slice(
    analysis.indexOf('async enqueueCatalogAnalysisBackfill'),
    analysis.indexOf('async getReadyAnalysisSource')
  )
  assert.match(backfill, /edition\.scope = 'private'/)
  assert.match(ingest, /ensureAnalysisRun/)
  assert.doesNotMatch(ingest, /enqueueBookMarkup\(/)
  assert.match(catalogBackfill, /edition\.scope = 'catalog'/)
  assert.match(catalogBackfill, /edition\.status IN \('marking_up', 'failed'\)/)
  assert.match(catalogBackfill, /restartAnalysisRun/)
  assert.match(catalogBackfill, /run\.status IN \('queued', 'running'\)/)
  assert.match(catalogBackfill, /lease_expires_at > now\(\)/)
  assert.match(catalogBackfill, /LEASE_EXPIRED/)
  assert.match(gateway, /enqueueCatalogAnalysisBackfill/)
  assert.equal(
    (await import('../book-markup.mjs')).BOOK_MARKUP_ANALYSIS_VERSION,
    'book-markup-v2'
  )
})

test('P0: getBookSceneInput supplies catalog genre and chapter to generateBookScene', async () => {
  const markup = await readFile(
    new URL('../postgres-book-markup-repository.mjs', import.meta.url),
    'utf8'
  )
  const generator = await readFile(
    new URL('../internal-generation-service.mjs', import.meta.url),
    'utf8'
  )
  const input = markup.slice(
    markup.indexOf('async getBookSceneInput'),
    markup.indexOf('async getCatalogCoverInput')
  )
  const scene = generator.slice(
    generator.indexOf('async generateBookScene'),
    generator.indexOf('async generateCharacterBundle')
  )
  assert.match(input, /FROM book_edition_genres/)
  assert.match(input, /content_navigation->'segments'/)
  assert.match(input, /genreId: bookSubjects\[0\]/)
  assert.match(scene, /genreId: input\.genreId/)
  assert.match(scene, /chapter: input\.chapter/)
  assert.doesNotMatch(scene, /genreId: ''/)
})

test('P0: catalog progress uses charactersDue without a v3 cutoff', async () => {
  const source = await readFile(
    new URL('../book-catalog-service.mjs', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(
    source,
    /progress\.analysisVersion === BOOK_ANALYSIS_MARKUP_VERSION/
  )
  assert.match(
    source,
    /const charactersDue = analysisRepository\s*\n\s*\? progress\.charactersDue/
  )
})

test('P1: loadSceneContext keeps a published markup row without normalized_text_*', async () => {
  const source = await readFile(
    new URL('../postgres-book-markup-repository.mjs', import.meta.url),
    'utf8'
  )
  const start = source.indexOf('async function loadSceneContext')
  const end = source.indexOf('function withNormalizedText')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const fn = source.slice(start, end)
  assert.match(fn, /if \(!row\) return null/)
  assert.doesNotMatch(
    fn,
    /if \(!row \|\| !row\.normalized_text_object_key \|\| !row\.normalized_text_hash\) return null/
  )
  assert.match(fn, /normalizedTextObjectKey: row\.normalized_text_object_key \|\| null/)
})

test('speech path stays POST /v2/speech/synthesize', async () => {
  const index = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(index, /app\.post\('\/v2\/speech\/synthesize'/)
  assert.doesNotMatch(index, /app\.post\('\/v2\/speech'[,)]/)
})
