export const BOOK_SCENE_POLICY_VERSION = 'text-interval-v1'
export const BOOK_SCENE_INTERVAL_TEXT_LENGTH = 6_000
export const BOOK_MEDIA_LOOKAHEAD_FRACTION = 0.1

function positiveTextLength(value, name = 'textLength') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name}: expected a positive safe integer`)
  }
  return value
}

function textOffset(value, textLength, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name}: expected a non-negative safe integer`)
  }
  return Math.min(value, textLength - 1)
}

export function bookScenePolicy(textLength, {
  intervalTextLength = BOOK_SCENE_INTERVAL_TEXT_LENGTH
} = {}) {
  positiveTextLength(textLength)
  if (!Number.isSafeInteger(intervalTextLength) || intervalTextLength < 1) {
    throw new TypeError('intervalTextLength: expected a positive safe integer')
  }
  return {
    version: BOOK_SCENE_POLICY_VERSION,
    startTextOffset: 0,
    intervalTextLength
  }
}

export function normalizeBookScenePolicy(value, textLength) {
  positiveTextLength(textLength)
  if (value == null) return bookScenePolicy(textLength)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('scenePolicy: expected an object')
  }
  const keys = Object.keys(value)
  if (keys.some((key) => !['version', 'startTextOffset', 'intervalTextLength'].includes(key))) {
    throw new TypeError('scenePolicy: unknown field')
  }
  if (value.version !== BOOK_SCENE_POLICY_VERSION) {
    throw new TypeError(`scenePolicy.version: expected ${BOOK_SCENE_POLICY_VERSION}`)
  }
  if (value.startTextOffset !== 0) {
    throw new TypeError('scenePolicy.startTextOffset: expected 0')
  }
  return bookScenePolicy(textLength, { intervalTextLength: value.intervalTextLength })
}

export function bookSceneSlotAt(policyValue, textLengthValue, readerTextOffsetValue) {
  const textLength = positiveTextLength(textLengthValue)
  const policy = normalizeBookScenePolicy(policyValue, textLength)
  const readerTextOffset = textOffset(readerTextOffsetValue, textLength, 'readerTextOffset')
  const slotIndex = Math.floor(
    Math.max(0, readerTextOffset - policy.startTextOffset) / policy.intervalTextLength
  )
  const excerptStartTextOffset = Math.min(
    textLength - 1,
    policy.startTextOffset + slotIndex * policy.intervalTextLength
  )
  const excerptEndTextOffset = Math.min(
    textLength,
    excerptStartTextOffset + policy.intervalTextLength
  )
  return {
    sceneKey: `${policy.version}:${slotIndex}`,
    slotIndex,
    anchorTextOffset: excerptStartTextOffset + Math.floor(
      (excerptEndTextOffset - excerptStartTextOffset) / 2
    ),
    excerptStartTextOffset,
    excerptEndTextOffset
  }
}

export function bookSceneSlotsThrough(policyValue, textLengthValue, frontierTextOffsetValue) {
  const textLength = positiveTextLength(textLengthValue)
  const policy = normalizeBookScenePolicy(policyValue, textLength)
  if (!Number.isSafeInteger(frontierTextOffsetValue) || frontierTextOffsetValue < 0) {
    throw new TypeError('frontierTextOffset: expected a non-negative safe integer')
  }
  const frontierTextOffset = Math.min(frontierTextOffsetValue, textLength)
  const slots = []
  for (let slotIndex = 0; ; slotIndex += 1) {
    const slotStart = policy.startTextOffset + slotIndex * policy.intervalTextLength
    if (slotStart >= textLength) break
    const slot = bookSceneSlotAt(policy, textLength, slotStart)
    if (slot.anchorTextOffset >= frontierTextOffset) break
    slots.push(slot)
  }
  return slots
}

export function bookMediaFrontier({ scope, textLength: textLengthValue, readerTextOffset = 0 }) {
  const textLength = positiveTextLength(textLengthValue)
  if (scope === 'catalog') return textLength
  if (scope !== 'private') throw new TypeError('scope: expected catalog or private')
  const currentOffset = textOffset(readerTextOffset, textLength, 'readerTextOffset')
  return Math.min(
    textLength,
    currentOffset + Math.ceil(textLength * BOOK_MEDIA_LOOKAHEAD_FRACTION)
  )
}

function snapToSentenceStart(text, offset, floor) {
  const window = text.slice(floor, offset)
  const match = window.match(/[.!?…»]\s+(?=[^\s])/g)
  if (!match) return floor
  const last = window.lastIndexOf(match[match.length - 1])
  return floor + last + match[match.length - 1].length
}

/**
 * The reader stands at the anchor (the middle of the interval), so the
 * illustrated excerpt must surround it instead of starting at the interval
 * head, where the previous scene already ended.
 */
export function sceneExcerptAround(text, { start, end, anchor }, maxChars = 1_200) {
  const boundedStart = Math.max(0, start)
  const boundedEnd = Math.min(text.length, end)
  if (boundedEnd <= boundedStart) return ''
  const half = Math.floor(maxChars / 2)
  const pivot = Math.min(boundedEnd, Math.max(boundedStart, anchor))
  let from = Math.max(boundedStart, pivot - half)
  let to = Math.min(boundedEnd, from + maxChars)
  from = Math.max(boundedStart, to - maxChars)
  if (from > boundedStart) {
    from = snapToSentenceStart(text, from + 1, Math.max(boundedStart, from - 200))
    to = Math.min(boundedEnd, from + maxChars)
  }
  return text.slice(from, to).trim()
}

/** Short tails of the two preceding slots keep the series consistent. */
export function previousSceneExcerptsFromText(text, policyValue, textLengthValue, slotIndex, count = 2) {
  const textLength = positiveTextLength(textLengthValue)
  const policy = normalizeBookScenePolicy(policyValue, textLength)
  const excerpts = []
  for (let index = slotIndex - 1; index >= 0 && excerpts.length < count; index -= 1) {
    const slot = bookSceneSlotAt(policy, textLength, policy.startTextOffset + index * policy.intervalTextLength)
    const excerpt = sceneExcerptAround(text, {
      start: slot.excerptStartTextOffset,
      end: slot.excerptEndTextOffset,
      anchor: slot.anchorTextOffset
    }, 240)
    if (excerpt) excerpts.unshift(excerpt)
  }
  return excerpts
}

/** Title of the navigation segment that contains the offset ('' when unknown). */
export function chapterTitleAtOffset(navigation, offset) {
  const segments = Array.isArray(navigation?.segments) ? navigation.segments : []
  let best = null
  for (const segment of segments) {
    if (!segment || !Number.isSafeInteger(segment.startOffset)) continue
    if (segment.startOffset > offset) continue
    if (!best || segment.startOffset >= best.startOffset) best = segment
  }
  const title = typeof best?.title === 'string' ? best.title.trim() : ''
  return title.slice(0, 300)
}

export function bookSceneIdempotencyKey({
  bookEditionId,
  markupContentHash,
  policyVersion,
  slotIndex
}) {
  return [bookEditionId, 'scene', markupContentHash, policyVersion, slotIndex].join(':')
}
