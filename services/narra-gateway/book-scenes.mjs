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

export function bookSceneIdempotencyKey({
  bookEditionId,
  markupContentHash,
  policyVersion,
  slotIndex
}) {
  return [bookEditionId, 'scene', markupContentHash, policyVersion, slotIndex].join(':')
}

const PREVIOUS_SCENE_EXCERPT_LIMIT = 2

function intervalFromSceneOffsets({
  slotIndex,
  excerptStartTextOffset,
  excerptEndTextOffset
}) {
  if (
    Number.isSafeInteger(slotIndex) &&
    slotIndex > 0 &&
    Number.isSafeInteger(excerptStartTextOffset) &&
    excerptStartTextOffset > 0
  ) {
    const interval = Math.floor(excerptStartTextOffset / slotIndex)
    if (interval >= 1) return interval
  }
  if (
    Number.isSafeInteger(excerptStartTextOffset) &&
    Number.isSafeInteger(excerptEndTextOffset) &&
    excerptEndTextOffset > excerptStartTextOffset
  ) {
    return excerptEndTextOffset - excerptStartTextOffset
  }
  return BOOK_SCENE_INTERVAL_TEXT_LENGTH
}

export function previousSceneExcerptsFromText(text, input = {}) {
  if (typeof text !== 'string' || !text) return []
  const slotIndex = input.slotIndex
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 1) return []
  const textLength = Number.isSafeInteger(input.textLength) && input.textLength > 0
    ? input.textLength
    : text.length
  const intervalTextLength = intervalFromSceneOffsets(input)
  if (!Number.isSafeInteger(intervalTextLength) || intervalTextLength < 1) return []
  const policy = bookScenePolicy(textLength, { intervalTextLength })
  const excerpts = []
  const firstPrevious = Math.max(0, slotIndex - PREVIOUS_SCENE_EXCERPT_LIMIT)
  for (let previousIndex = firstPrevious; previousIndex < slotIndex; previousIndex += 1) {
    const slot = bookSceneSlotAt(
      policy,
      textLength,
      policy.startTextOffset + previousIndex * policy.intervalTextLength
    )
    const excerpt = text.slice(slot.excerptStartTextOffset, slot.excerptEndTextOffset).trim()
    if (excerpt) excerpts.push(excerpt)
  }
  return excerpts
}
