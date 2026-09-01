function terminalErrorCode(error) {
  if (error?.code === 'CANCELLED' || error?.name === 'AbortError') return 'CANCELLED'
  if (error?.code === 'CENSOR') return 'CENSOR'
  if (error?.code === 'VALIDATION') return 'VALIDATION'
  if (error?.code === 'PARSE' || error instanceof SyntaxError) return 'PARSE'
  if (error?.code === 'TIMEOUT' || error?.name === 'TimeoutError') return 'TIMEOUT'
  if (error?.code === 'TRUNCATED') return 'TRUNCATED'
  return 'NETWORK'
}

/**
 * A provider attempt becomes successful only after its response has been
 * consumed and parsed. The finalizer is idempotent, so callers may safely
 * surface the same downstream error without double-counting an attempt.
 */
export async function settleProviderResponse({ consume, finalizeAttempt }) {
  try {
    const value = await consume()
    await finalizeAttempt({ status: 'completed' })
    return value
  } catch (error) {
    await finalizeAttempt({ status: 'failed', error_code: terminalErrorCode(error) })
    throw error
  }
}

/** True when the provider stopped generating because max_tokens ran out. */
export function isTruncatedChatCompletion(payload) {
  return Array.isArray(payload?.choices) &&
    payload.choices.length > 0 &&
    payload.choices.every((choice) => choice?.finish_reason === 'length')
}

/**
 * Structured (JSON) tasks cannot survive a body cut by max_tokens: the JSON is
 * unparsable and retrying the same prompt reproduces the same cut. Callers that
 * need a whole document pass `rejectTruncated` so the failure is attributed to
 * TRUNCATED instead of a generic PARSE error.
 */
export function validateChatCompletionPayload(payload, { rejectTruncated = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('LLM returned an invalid completion payload'), {
      code: 'PARSE', status: 502
    })
  }
  if (payload.error) {
    const fingerprint = `${payload.error?.code || ''} ${payload.error?.type || ''}`.toLowerCase()
    const moderation = /content.?filter|moderation|safety|unsafe|censor|blocked/.test(fingerprint)
    throw Object.assign(
      new Error(moderation
        ? 'LLM completion was blocked by content safety'
        : 'LLM completion returned an upstream error'),
      { code: moderation ? 'CENSOR' : 'NETWORK', status: moderation ? 422 : 502 }
    )
  }
  if (
    !Array.isArray(payload.choices) ||
    payload.choices.length < 1 ||
    payload.choices.some((choice) => choice?.finish_reason === 'content_filter')
  ) {
    const censored = Array.isArray(payload.choices) &&
      payload.choices.some((choice) => choice?.finish_reason === 'content_filter')
    throw Object.assign(
      new Error(censored
        ? 'LLM completion was blocked by content safety'
        : 'LLM completion did not contain a choice'),
      { code: censored ? 'CENSOR' : 'PARSE', status: censored ? 422 : 502 }
    )
  }
  if (rejectTruncated && isTruncatedChatCompletion(payload)) {
    throw Object.assign(
      new Error('LLM completion was truncated by the max_tokens limit'),
      { code: 'TRUNCATED', status: 502, finishReason: 'length' }
    )
  }
  return payload
}

export { terminalErrorCode }
