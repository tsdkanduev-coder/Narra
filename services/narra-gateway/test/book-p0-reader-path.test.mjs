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
