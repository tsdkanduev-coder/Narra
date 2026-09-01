import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTruncatedChatCompletion,
  settleProviderResponse,
  validateChatCompletionPayload
} from '../provider-response.mjs'

test('provider completion is emitted only after response consumption', async () => {
  const events = []
  const value = await settleProviderResponse({
    consume: async () => ({ ok: true }),
    finalizeAttempt: async (event) => events.push(event)
  })
  assert.deepEqual(value, { ok: true })
  assert.deepEqual(events, [{ status: 'completed' }])
})

for (const [name, failure, expected] of [
  ['broken SSE body', Object.assign(new Error('socket reset'), { code: 'NETWORK' }), 'NETWORK'],
  ['malformed JSON body', Object.assign(new SyntaxError('bad json'), { code: 'PARSE' }), 'PARSE'],
  ['oversized body', Object.assign(new Error('body too large'), { code: 'NETWORK' }), 'NETWORK']
]) {
  test(`${name} emits a failed attempt and never a completed attempt`, async () => {
    const events = []
    await assert.rejects(settleProviderResponse({
      consume: async () => { throw failure },
      finalizeAttempt: async (event) => events.push(event)
    }))
    assert.deepEqual(events, [{ status: 'failed', error_code: expected }])
  })
}

test('non-stream completion rejects in-band error and content-filter finish', () => {
  assert.throws(
    () => validateChatCompletionPayload({ error: { code: 'upstream_failure' } }),
    (error) => error?.code === 'NETWORK'
  )
  assert.throws(
    () => validateChatCompletionPayload({
      choices: [{ finish_reason: 'content_filter' }]
    }),
    (error) => error?.code === 'CENSOR'
  )
})

test('a completion cut by max_tokens is reported as TRUNCATED only for whole-document callers', async () => {
  const truncated = {
    choices: [{ finish_reason: 'length', message: { content: '{"traits":[' } }]
  }
  assert.equal(validateChatCompletionPayload(truncated), truncated)
  assert.equal(isTruncatedChatCompletion(truncated), true)
  assert.equal(isTruncatedChatCompletion({ choices: [{ finish_reason: 'stop' }] }), false)
  assert.throws(
    () => validateChatCompletionPayload(truncated, { rejectTruncated: true }),
    (error) => error?.code === 'TRUNCATED' && error?.status === 502
  )
  const events = []
  await assert.rejects(settleProviderResponse({
    consume: async () => validateChatCompletionPayload(truncated, { rejectTruncated: true }),
    finalizeAttempt: async (event) => events.push(event)
  }))
  assert.deepEqual(events, [{ status: 'failed', error_code: 'TRUNCATED' }])
})
