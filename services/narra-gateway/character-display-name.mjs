const LOWERCASE_LETTER_AT_WORD_START = /(^|[^\p{L}\p{M}\p{N}])(\p{Ll})/gu

/**
 * Formats a character name for public display without rewriting source identity data.
 * Only word-start letters are uppercased; existing inner casing stays untouched.
 */
export function formatCharacterDisplayName(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')

  return normalized.replace(
    LOWERCASE_LETTER_AT_WORD_START,
    (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`
  )
}

const PSEUDO_CHARACTER_NAMES = new Set([
  'рассказчик', 'рассказчица', 'нарратор', 'повествователь', 'автор', 'авторша',
  'narrator', 'author', 'storyteller', 'the narrator', 'the author'
])

/**
 * The scan model sometimes promotes the narrative voice («Рассказчик»,
 * «Автор») to a character. Such pseudo-characters must not reach the
 * reader's cast: they have no persona, and voice markup falls back to the
 * narrator for them anyway. A named narrator (full name present) is kept.
 */
export function isPseudoCharacterName(name, fullName = '') {
  const normalized = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!PSEUDO_CHARACTER_NAMES.has(normalized)) return false
  const full = String(fullName || '').trim().toLowerCase().replace(/\s+/g, ' ')
  return !full || full === normalized || PSEUDO_CHARACTER_NAMES.has(full)
}
