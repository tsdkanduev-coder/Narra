import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { attachBookSearchContext } from '../book-chat-grounding.mjs'

const messages = [
  { role: 'system', content: 'Ты герой книги.' },
  { role: 'user', content: 'Что сказала Анна у двери?' }
]

test('character chat retrieves book search snippets before the LLM messages', async () => {
  const calls = []
  const grounded = await attachBookSearchContext({
    search: async (subjectId, bookEditionId, query) => {
      calls.push({ subjectId, bookEditionId, query })
      return { results: [{ snippet: 'Анна открыла дверь и вошла в зал.' }] }
    },
    subjectId: 'reader-1',
    bookEditionId: '11111111-1111-4111-8111-111111111111',
    messages,
    purpose: 'character_chat'
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].query.query, 'Что сказала Анна у двери?')
  assert.equal(grounded[0].role, 'system')
  assert.match(grounded[0].content, /Анна открыла дверь/)
  assert.equal(grounded.length, messages.length + 1)
})

test('memory purpose and missing edition skip retrieval', async () => {
  let called = false
  const search = async () => {
    called = true
    return { results: [{ snippet: 'x' }] }
  }
  assert.deepEqual(await attachBookSearchContext({
    search, subjectId: 'r', bookEditionId: 'book', messages, purpose: 'memory'
  }), messages)
  assert.equal(called, false)
  assert.deepEqual(await attachBookSearchContext({
    search, subjectId: 'r', messages, purpose: 'character_chat'
  }), messages)
})

test('not-ready search does not fail the chat', async () => {
  const grounded = await attachBookSearchContext({
    search: async () => {
      throw Object.assign(new Error('index'), { code: 'SEARCH_NOT_READY', status: 409 })
    },
    subjectId: 'reader-1',
    bookEditionId: 'book-1',
    messages,
    purpose: 'character_chat'
  })
  assert.deepEqual(grounded, messages)
})

test('complete chat retrieves book search before requestChat', async () => {
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("app.post('/v2/ai/chat/complete'")
  const end = source.indexOf("app.post('/v2/speech/synthesize'")
  assert.notEqual(start, -1)
  assert.ok(end > start)
  const handler = source.slice(start, end)
  assert.match(handler, /attachBookSearchContext/)
  assert.match(handler, /bookSearchService\?\.search/)
  assert.match(handler, /input\.bookEditionId/)
  assert.ok(handler.indexOf('attachBookSearchContext') < handler.indexOf('requestChat'))
})
