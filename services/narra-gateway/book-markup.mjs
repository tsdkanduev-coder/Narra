/** Legacy private-book worker only. Catalog publish is book-markup-v3 via analysis. */
export const BOOK_MARKUP_ANALYSIS_VERSION = 'book-markup-v2'
export const BOOK_MARKUP_SCHEMA_VERSION = 2
export const CHARACTER_BUNDLE_VERSION = 'character-bundle-v1'
export const LOCAL_MARKUP_ANALYSIS_VERSION = 'local-character-v1'
export const LOCAL_MARKUP_PROGRESS_SCALE = 1_000_000

export const REQUIRED_CHARACTER_MEDIA = Object.freeze([
  'primary_portrait',
  'greeting_audio',
  'idle_animation'
])

export const CHARACTER_MEDIA_JOB_TYPES = Object.freeze({
  primary_portrait: 'character_portrait',
  greeting_audio: 'character_audio',
  idle_animation: 'character_animation'
})

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/i
const JOB_STATUSES = new Set(['queued', 'running', 'ready', 'failed'])

function invalid(message) {
  const error = new Error(message)
  error.code = 'VALIDATION'
  error.status = 400
  throw error
}

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    invalid(`${name}: invalid identifier`)
  }
  return value
}

function textOffset(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${name}: expected a non-negative safe integer`)
  }
  return value
}

function optionalSectionIndex(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function optionalFraction(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null
}

/** Maps a canonical extracted-text offset to its stable source section. */
export function sectionAnchorForTextOffset(sections, rawTextOffset) {
  const offset = textOffset(rawTextOffset, 'textOffset')
  if (!Array.isArray(sections) || !sections.length) {
    invalid('sections: expected a non-empty array')
  }
  let selectedIndex = sections.findIndex((section, index) =>
    section &&
    Number.isSafeInteger(section.startOffset) &&
    Number.isSafeInteger(section.endOffset) &&
    offset >= section.startOffset &&
    (offset < section.endOffset || (index === sections.length - 1 && offset === section.endOffset))
  )
  if (selectedIndex < 0) selectedIndex = offset < sections[0].startOffset ? 0 : sections.length - 1
  const section = sections[selectedIndex]
  const length = Math.max(1, section.endOffset - section.startOffset)
  return {
    firstAppearanceSectionIndex: Number.isSafeInteger(section.sourceIndex) && section.sourceIndex >= 0
      ? section.sourceIndex
      : selectedIndex,
    firstAppearanceSectionKey: typeof section.key === 'string' ? section.key.slice(0, 900) : '',
    firstAppearanceSectionFraction: Math.min(
      1,
      Math.max(0, (offset - section.startOffset) / length)
    )
  }
}

/**
 * Normalizes the server-side character anchor produced by book markup.
 * warmupTextOffset is deliberately separate from firstAppearanceTextOffset:
 * the former may trigger shared work, while the latter controls reader access.
 */
export function normalizeCharacterAnchor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('character: expected an object')
  }
  const characterKey = identifier(input.characterKey, 'characterKey')
  const firstAppearanceTextOffset = textOffset(
    input.firstAppearanceTextOffset,
    'firstAppearanceTextOffset'
  )
  const warmupTextOffset = textOffset(input.warmupTextOffset, 'warmupTextOffset')
  if (warmupTextOffset > firstAppearanceTextOffset) {
    invalid('warmupTextOffset: must not be after firstAppearanceTextOffset')
  }
  return { characterKey, firstAppearanceTextOffset, warmupTextOffset }
}

/** Returns all characters whose markup-defined warmup frontier has been crossed. */
export function charactersDueForWarmup(characters, readerTextOffset) {
  const offset = textOffset(readerTextOffset, 'readerTextOffset')
  if (!Array.isArray(characters)) invalid('characters: expected an array')
  return characters
    .map(normalizeCharacterAnchor)
    .filter((character) => character.warmupTextOffset <= offset)
    .sort((left, right) =>
      left.warmupTextOffset - right.warmupTextOffset ||
      left.firstAppearanceTextOffset - right.firstAppearanceTextOffset ||
      left.characterKey.localeCompare(right.characterKey)
    )
}

export function characterBundleIdempotencyKey({
  bookEditionId,
  characterKey,
  bundleVersion = CHARACTER_BUNDLE_VERSION
}) {
  return [
    identifier(bookEditionId, 'bookEditionId'),
    identifier(characterKey, 'characterKey'),
    identifier(bundleVersion, 'bundleVersion')
  ].join(':')
}

export function characterMediaTargetVersion({ bundleVersion, mediaRevision }) {
  identifier(bundleVersion, 'bundleVersion')
  if (!Number.isSafeInteger(mediaRevision) || mediaRevision < 1) {
    invalid('mediaRevision: expected a positive safe integer')
  }
  return `${bundleVersion}:r${mediaRevision}`
}

export function characterMediaIdempotencyKey({
  bookEditionId,
  characterKey,
  targetVersion,
  assetType
}) {
  if (!Object.hasOwn(CHARACTER_MEDIA_JOB_TYPES, assetType)) {
    invalid('assetType: unsupported character media type')
  }
  return [
    identifier(bookEditionId, 'bookEditionId'),
    identifier(characterKey, 'characterKey'),
    identifier(targetVersion, 'targetVersion'),
    identifier(assetType, 'assetType')
  ].join(':')
}

export function isCompleteCharacterBundle(bundle) {
  if (!bundle || bundle.status !== 'ready' || !Array.isArray(bundle.assets)) return false
  const readyTypes = new Set(
    bundle.assets
      .filter((asset) => asset?.status === 'ready' && typeof asset.assetId === 'string')
      .map((asset) => asset.type)
  )
  return REQUIRED_CHARACTER_MEDIA.every((type) => readyTypes.has(type))
}

/**
 * Computes the state exposed for one reader without leaking future character
 * metadata. A warm bundle remains hidden until this reader crosses the first
 * appearance anchor.
 */
export function hasReaderReachedCharacter(characterInput, readerPosition) {
  const character = normalizeCharacterAnchor(characterInput)
  const data = characterInput?.data && typeof characterInput.data === 'object'
    ? characterInput.data
    : characterInput
  const characterSectionIndex = optionalSectionIndex(data?.firstAppearanceSectionIndex)
  const characterSectionFraction = optionalFraction(data?.firstAppearanceSectionFraction)
  const position = typeof readerPosition === 'number'
    ? { textOffset: readerPosition }
    : readerPosition
  const readerSectionIndex = optionalSectionIndex(position?.sectionIndex)
  const readerSectionFraction = optionalFraction(position?.sectionFraction)

  if (characterSectionIndex != null && readerSectionIndex != null) {
    if (readerSectionIndex !== characterSectionIndex) {
      return readerSectionIndex > characterSectionIndex
    }
    if (characterSectionFraction != null && readerSectionFraction != null) {
      return readerSectionFraction >= characterSectionFraction
    }
  }
  const offset = textOffset(position?.textOffset ?? 0, 'readerTextOffset')
  return offset >= character.firstAppearanceTextOffset
}

export function readerCharacterState(characterInput, bundle, readerPosition) {
  if (!hasReaderReachedCharacter(characterInput, readerPosition)) return 'hidden'
  return isCompleteCharacterBundle(bundle) ? 'ready' : 'preparing'
}

/**
 * Requests one atomic character bundle. The repository operation must perform
 * an atomic insert-or-return-existing using the supplied idempotency key.
 */
export async function ensureCharacterBundle(repository, input) {
  if (!repository || typeof repository.ensureCharacterBundle !== 'function') {
    throw new TypeError('repository.ensureCharacterBundle is required')
  }
  const bundleVersion = input.bundleVersion ?? CHARACTER_BUNDLE_VERSION
  const idempotencyKey = characterBundleIdempotencyKey({ ...input, bundleVersion })
  const result = await repository.ensureCharacterBundle({
    bookEditionId: input.bookEditionId,
    characterKey: input.characterKey,
    bundleVersion,
    idempotencyKey,
    requiredMedia: [...REQUIRED_CHARACTER_MEDIA]
  })
  if (!result || typeof result !== 'object' || !JOB_STATUSES.has(result.status)) {
    throw new Error('repository returned an invalid character bundle status')
  }
  return { ...result, idempotencyKey, bundleVersion }
}
