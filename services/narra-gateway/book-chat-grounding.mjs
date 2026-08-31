const GROUNDED_PURPOSES = new Set([
  'character_chat',
  'structured_task',
  'summary',
  'scenario'
])

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content.trim()
    }
  }
  return ''
}

function groundingMessage(snippets) {
  const lines = snippets
    .map((snippet) => String(snippet || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((snippet, index) => `${index + 1}. ${snippet}`)
  return {
    role: 'system',
    content: [
      'Фрагменты книги для ответа. Не выходи за них и не спойлери дальше позиции читателя.',
      lines.join('\n')
    ].join('\n')
  }
}

export async function attachBookSearchContext({
  search,
  subjectId,
  bookEditionId,
  messages,
  purpose
}) {
  if (!bookEditionId || typeof search !== 'function' || !Array.isArray(messages)) {
    return messages
  }
  if (!GROUNDED_PURPOSES.has(purpose)) return messages
  const query = lastUserText(messages)
  if (query.length < 2) return messages
  try {
    const result = await search(subjectId, bookEditionId, {
      query: query.slice(0, 500),
      mode: 'hybrid',
      spoilerMode: 'reader',
      limit: 8
    })
    const snippets = (result?.results || []).map((item) => item.snippet).filter(Boolean)
    if (!snippets.length) return messages
    return [groundingMessage(snippets), ...messages]
  } catch (error) {
    if (
      error?.status === 409 ||
      error?.status === 404 ||
      error?.code === 'SEARCH_NOT_READY' ||
      error?.code === 'NOT_FOUND' ||
      error?.code === 'SEMANTIC_SEARCH_NOT_READY'
    ) {
      return messages
    }
    throw error
  }
}
