import express from 'express'
import cors from 'cors'
import { createHmac, randomUUID } from 'crypto'
import path from 'node:path'
import { httpsRequest } from './http.mjs'
import { attachBookSearchContext } from './book-chat-grounding.mjs'
import {
  parseAvatarBody,
  parseChatBody,
  parseCoverBody,
  parseCoverJobBody,
  parseImageBody,
  parsePortraitBody,
  parseSynthesisBody,
  validationErrors
} from './contracts.mjs'
import {
  coverImageConfig,
  coverRouteReadiness,
  llmRouteReadiness,
  requestChat,
  requestCoverImageWithFallback
} from './providers.mjs'
import {
  settleProviderResponse,
  validateChatCompletionPayload
} from './provider-response.mjs'
import { parseEventBatch } from './events.mjs'
import { createEventStore } from './event-store.mjs'
import { readBoundedBody } from './safe-fetch.mjs'
import { fetchImportSource, importSourceFailure } from './import-source.mjs'
import { createConcurrencyGate, requestAbortSignal, withTimeout } from './concurrency.mjs'
import { parseEnvBool, parseEnvInt } from './env.mjs'
import {
  analyticsRoute,
  completionProperties,
  createSseUsageCollector,
  providerAttemptProperties
} from './analytics-properties.mjs'
import {
  insecureVideoEnvironmentAllowed,
  isSecureServiceUrl,
  serviceUrl
} from './service-url.mjs'
import {
  shouldRetryKandinsky,
  shouldRetryKandinskyStatus,
  videoRetryDelay
} from './retry-policy.mjs'
import {
  imageEmptyResultError,
  imageUpstreamError,
  shouldFallbackAfterImageError
} from './image-policy.mjs'
import { sberCaBundle, verifiedSberCertificates } from './sber-tls.mjs'
import {
  createFixedWindowLimiter,
  createPersistentBudgetMiddleware,
  createTokenService,
  hashInstallationSecret,
  isInstallationId,
  requireGatewayAuth,
  requireOperatorAuth,
  resolveTokenSecret
} from './security.mjs'
import { createInstallationRegistry } from './installation-registry.mjs'
import { gatewayReadiness } from './readiness.mjs'
import { createCoverJobStore } from './cover-job-store.mjs'
import { createCoverJobRunner } from './cover-job-runner.mjs'
import { bookCoverPrompt } from './catalog-cover-prompt.mjs'
import { parseSceneJobBody, sceneGenerationPrompt } from './scene-generation.mjs'
import { createBookCatalogRouter } from './book-catalog-api.mjs'
import { createBookEmbeddingClientFromEnv } from './book-embedding-client.mjs'
import { createBookSearchRouter } from './book-search-api.mjs'
import { createPostgresBookSearchRepository } from './book-search-repository.mjs'
import { createBookSearchService } from './book-search-service.mjs'
import { createCatalogIngestRouter } from './catalog-ingest-api.mjs'
import { createCatalogIngestService } from './catalog-ingest-service.mjs'
import { createPostgresBookAnalysisRepository } from './book-analysis-repository.mjs'
import { bookAnalysisPipelineFromEnv } from './book-analysis-pipeline.mjs'
import { createBookOperatorRouter } from './book-operator-api.mjs'
import { createPostgresBookOperatorRepository } from './book-operator-repository.mjs'
import { createPostgresBookMarkupRepository } from './postgres-book-markup-repository.mjs'
import { createPostgresBookTtsMarkupRepository } from './book-tts-markup-repository.mjs'
import { createPostgresPoolFromEnv, runBookMarkupMigrations } from './postgres-runtime.mjs'
import { createBookObjectStorageFromEnv } from './book-object-storage.mjs'
import {
  createInternalGenerationRouter,
  createInternalGenerationService
} from './internal-generation-service.mjs'
import { createGenerationCostLedger } from './generation-cost-ledger.mjs'
import { createLocalIdleAnimation } from './local-idle-animation.mjs'
import { createPrivateMaterialCleanup } from './private-material-cleanup.mjs'
import { kandinskyImageTimeoutMs, kandinskyRequestTimeoutMs } from './image-timeouts.mjs'

// ================= Конфигурация =================
const PORT = process.env.PORT || 8787
const BOOK_ANALYSIS_PIPELINE = bookAnalysisPipelineFromEnv(process.env)
const INSECURE = process.env.ALLOW_INSECURE_TLS === 'true'
const PRODUCTION = process.env.NODE_ENV === 'production'
const BUILD_VERSION = String(process.env.GATEWAY_BUILD_VERSION || 'development').slice(0, 120)
if (PRODUCTION && INSECURE) throw new Error('ALLOW_INSECURE_TLS is forbidden in production')
const ANALYTICS_ENV = process.env.ANALYTICS_ENV || (PRODUCTION ? 'production' : 'development')
if (!['production', 'staging', 'development', 'test'].includes(ANALYTICS_ENV)) {
  throw new Error('ANALYTICS_ENV must be production, staging, development or test')
}
const VIDEO_REQUIRED = parseEnvBool(process.env, 'VIDEO_REQUIRED', false)
const BOOK_BACKEND_REQUIRED = parseEnvBool(process.env, 'BOOK_BACKEND_REQUIRED', false)
const BOOK_SEARCH_ENABLED = parseEnvBool(process.env, 'BOOK_SEARCH_ENABLED', false)
const BOOK_ANALYSIS_MEDIA_GENERATION_ENABLED = parseEnvBool(
  process.env,
  'BOOK_ANALYSIS_MEDIA_GENERATION_ENABLED',
  true
)
const BOOK_SHADOW_PREVIEW_ENABLED = parseEnvBool(
  process.env,
  'BOOK_SHADOW_PREVIEW_ENABLED',
  ANALYTICS_ENV !== 'production'
)
const ALLOW_INSECURE_VIDEO_HTTP = process.env.ALLOW_INSECURE_VIDEO_HTTP === 'true'
const INSECURE_VIDEO_ENV_ALLOWED = insecureVideoEnvironmentAllowed({
  production: PRODUCTION,
  analyticsEnvironment: ANALYTICS_ENV
})
if (ALLOW_INSECURE_VIDEO_HTTP && !INSECURE_VIDEO_ENV_ALLOWED) {
  throw new Error('ALLOW_INSECURE_VIDEO_HTTP is forbidden outside staging or local development/test')
}
const VIDEO_INSECURE_HTTP_HOSTS = String(process.env.VIDEO_INSECURE_HTTP_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const ALLOW_INSECURE_LLM_HTTP = parseEnvBool(process.env, 'ALLOW_INSECURE_LLM_HTTP', false)
const LLM_INSECURE_HTTP_HOSTS = String(process.env.LLM_INSECURE_HTTP_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
function envInt(name, fallback, max) {
  return parseEnvInt(process.env, name, fallback, max)
}
const REGISTRATION_LIMIT = envInt('REGISTRATION_LIMIT_PER_HOUR', 10, 1_000)
const REGISTRATION_GLOBAL_LIMIT = envInt('REGISTRATION_GLOBAL_LIMIT_PER_HOUR', 500, 100_000)
const REGISTRATION_GLOBAL_DAILY_LIMIT = envInt('REGISTRATION_GLOBAL_LIMIT_PER_DAY', 250, 100_000)
const INSTALLATION_REGISTRY_MAX = envInt('INSTALLATION_REGISTRY_MAX', 10_000, 100_000)
const INSTALLATION_INACTIVE_RETENTION_DAYS = envInt('INSTALLATION_INACTIVE_RETENTION_DAYS', 30, 365)
const INSTALLATION_TOKEN_TTL_SECONDS = envInt('INSTALLATION_TOKEN_TTL_SECONDS', 15 * 60, 24 * 60 * 60)
if (INSTALLATION_TOKEN_TTL_SECONDS < 5 * 60) {
  throw new Error('INSTALLATION_TOKEN_TTL_SECONDS must be at least 300 seconds')
}
const REFRESH_LIMIT = envInt('REFRESH_LIMIT_PER_HOUR', 20, 1_000)
const REFRESH_ATTEMPT_LIMIT = envInt('REFRESH_ATTEMPT_LIMIT_PER_HOUR', 40, 10_000)
const API_LIMIT = envInt('API_LIMIT_PER_MINUTE', 120, 10_000)
const EVENT_LIMIT = envInt('EVENT_LIMIT_PER_MINUTE', 10, 1_000)
const AI_LIMIT = envInt('AI_LIMIT_PER_MINUTE', 30, 1_000)
const AI_DAILY_LIMIT = envInt('AI_LIMIT_PER_DAY', 500, 100_000)
const AI_GLOBAL_DAILY_LIMIT = envInt('AI_GLOBAL_LIMIT_PER_DAY', 25_000, 10_000_000)
const SPEECH_LIMIT = envInt('SPEECH_LIMIT_PER_MINUTE', 60, 2_000)
const SPEECH_DAILY_LIMIT = envInt('SPEECH_LIMIT_PER_DAY', 1_000, 100_000)
const SPEECH_GLOBAL_DAILY_LIMIT = envInt('SPEECH_GLOBAL_LIMIT_PER_DAY', 50_000, 10_000_000)
const IMAGE_DAILY_LIMIT = envInt('IMAGE_LIMIT_PER_DAY', 100, 10_000)
const IMAGE_GLOBAL_DAILY_LIMIT = envInt('IMAGE_GLOBAL_LIMIT_PER_DAY', 5_000, 1_000_000)
const COVER_DAILY_LIMIT = envInt('COVER_LIMIT_PER_DAY', 60, 10_000)
const COVER_GLOBAL_DAILY_LIMIT = envInt('COVER_GLOBAL_LIMIT_PER_DAY', 3_000, 1_000_000)
const VIDEO_LIMIT = envInt('VIDEO_LIMIT_PER_HOUR', 8, 500)
const VIDEO_DAILY_LIMIT = envInt('VIDEO_LIMIT_PER_DAY', 20, 2_000)
const VIDEO_GLOBAL_DAILY_LIMIT = envInt('VIDEO_GLOBAL_LIMIT_PER_DAY', 500, 100_000)
const IMPORT_LIMIT = envInt('IMPORT_LIMIT_PER_MINUTE', 6, 100)
const IMPORT_DAILY_LIMIT = envInt('IMPORT_LIMIT_PER_DAY', 20, 1_000)
const IMPORT_GLOBAL_DAILY_LIMIT = envInt('IMPORT_GLOBAL_LIMIT_PER_DAY', 1_000, 100_000)
const IMPORT_DAILY_BYTES_MB = envInt('IMPORT_LIMIT_MIB_PER_DAY', 300, 30_000)
const IMPORT_GLOBAL_DAILY_BYTES_MB = envInt('IMPORT_GLOBAL_LIMIT_MIB_PER_DAY', 10_000, 300_000)
const IMPORT_CONCURRENCY = envInt('IMPORT_CONCURRENCY', 2, 20)
const IMPORT_QUEUE_LIMIT = envInt('IMPORT_QUEUE_LIMIT', 2, 50)
const BOOK_UPLOAD_MAX_BYTES = envInt('BOOK_UPLOAD_MAX_MIB', 50, 500) * 1024 * 1024
const PRIVATE_MATERIAL_TTL_DAYS = envInt('PRIVATE_MATERIAL_TTL_DAYS', 7, 365)
const PRIVATE_MATERIAL_CLEANUP_MS = envInt(
  'PRIVATE_MATERIAL_CLEANUP_MS',
  60 * 60 * 1_000,
  24 * 60 * 60 * 1_000
)
const PRIVATE_MATERIAL_CLEANUP_BATCH_SIZE = envInt('PRIVATE_MATERIAL_CLEANUP_BATCH_SIZE', 100, 1_000)
const LLM_RESPONSE_MAX_BYTES = envInt('LLM_RESPONSE_MAX_MIB', 8, 64) * 1024 * 1024
const KANDINSKY_QUEUE_LIMIT = envInt('KANDINSKY_QUEUE_LIMIT', 6, 100)
const KANDINSKY_IMAGE_TIMEOUT_MS = kandinskyImageTimeoutMs(process.env)
const KANDINSKY_REQUEST_TIMEOUT_MS = kandinskyRequestTimeoutMs(process.env)
const VIDEO_QUEUE_LIMIT = envInt('VIDEO_QUEUE_LIMIT', 4, 100)
const LLM_CONCURRENCY = envInt('LLM_CONCURRENCY', 12, 100)
const LLM_QUEUE_LIMIT = envInt('LLM_QUEUE_LIMIT', 16, 500)
// SALUTE_SPEECH_PERS is capped at five upstream streams. Reject a stale or
// accidental Railway override above the verified upstream scope.
const SPEECH_CONCURRENCY = envInt('SPEECH_CONCURRENCY', 5, 5)
const SPEECH_QUEUE_LIMIT = envInt('SPEECH_QUEUE_LIMIT', 16, 500)
const IMAGE_CONCURRENCY = envInt('IMAGE_CONCURRENCY', 4, 50)
const IMAGE_QUEUE_LIMIT = envInt('IMAGE_QUEUE_LIMIT', 12, 200)
const COVER_CONCURRENCY = envInt('COVER_CONCURRENCY', 2, 20)
const COVER_QUEUE_LIMIT = envInt('COVER_QUEUE_LIMIT', 8, 100)
const COVER_JOB_MAX = envInt('COVER_JOB_MAX', 1_000, 10_000)
const COVER_JOB_TTL_HOURS = envInt('COVER_JOB_TTL_HOURS', 24, 168)
const COVER_JOB_MAX_RESULT_MIB = envInt('COVER_JOB_MAX_RESULT_MIB', 16, 64)
const COVER_JOB_MAX_ATTEMPTS = envInt('COVER_JOB_MAX_ATTEMPTS', 3, 10)
const COVER_JOB_ATTEMPT_TIMEOUT_SECONDS = envInt('COVER_JOB_ATTEMPT_TIMEOUT_SECONDS', 32 * 60, 2 * 60 * 60)
const COVER_JOB_WORKER_ENABLED = parseEnvBool(process.env, 'COVER_JOB_WORKER_ENABLED', true)
const SCENE_JOB_MAX = envInt('SCENE_JOB_MAX', 1_000, 10_000)
const SCENE_JOB_TTL_HOURS = envInt('SCENE_JOB_TTL_HOURS', 24, 168)
const SCENE_JOB_MAX_ATTEMPTS = envInt('SCENE_JOB_MAX_ATTEMPTS', 3, 10)
const SCENE_JOB_ATTEMPT_TIMEOUT_SECONDS = envInt('SCENE_JOB_ATTEMPT_TIMEOUT_SECONDS', 15 * 60, 60 * 60)
const SCENE_JOB_WORKER_ENABLED = parseEnvBool(process.env, 'SCENE_JOB_WORKER_ENABLED', true)
const coverProviderConfig = coverImageConfig()
const coverProviderCallsPerAttempt =
  coverProviderConfig.fallbackModel && coverProviderConfig.fallbackModel !== coverProviderConfig.model ? 2 : 1
const minimumCoverAttemptTimeoutMs =
  coverProviderConfig.timeoutMs * coverProviderCallsPerAttempt + 15_000
if (COVER_JOB_ATTEMPT_TIMEOUT_SECONDS * 1_000 < minimumCoverAttemptTimeoutMs) {
  throw new Error(
    'COVER_JOB_ATTEMPT_TIMEOUT_SECONDS must cover every configured cover image model timeout plus 15 seconds'
  )
}
const llmGate = createConcurrencyGate({ limit: LLM_CONCURRENCY, queueLimit: LLM_QUEUE_LIMIT, name: 'LLM' })
const speechGate = createConcurrencyGate({ limit: SPEECH_CONCURRENCY, queueLimit: SPEECH_QUEUE_LIMIT, name: 'Speech' })
const imageGate = createConcurrencyGate({ limit: IMAGE_CONCURRENCY, queueLimit: IMAGE_QUEUE_LIMIT, name: 'Image' })
const coverGate = createConcurrencyGate({ limit: COVER_CONCURRENCY, queueLimit: COVER_QUEUE_LIMIT, name: 'Cover' })
const importGate = createConcurrencyGate({ limit: IMPORT_CONCURRENCY, queueLimit: IMPORT_QUEUE_LIMIT, name: 'Import' })
// Собирает Basic key из готового значения либо client id + secret.
function buildBasicKey(direct, clientId, clientSecret) {
  const d = (direct || '').trim()
  if (d) return d
  const id = (clientId || '').trim()
  const secret = (clientSecret || '').trim()
  if (id && secret) return Buffer.from(`${id}:${secret}`).toString('base64')
  return ''
}
// SaluteSpeech (speech.giga.chat): логин 'gigacons' + секрет → Basic base64(логин:секрет).
const SALUTE_CLIENT = (process.env.SBER_SALUTE_CLIENT || 'gigacons').trim()
const _saluteSecret = (process.env.SBER_SALUTE_AUTH_KEY || '').trim()
const SALUTE_KEY = _saluteSecret
  ? SALUTE_CLIENT
    ? Buffer.from(`${SALUTE_CLIENT}:${_saluteSecret}`).toString('base64')
    : _saluteSecret
  : buildBasicKey(
      process.env.SALUTESPEECH_AUTH_KEY,
      process.env.SALUTESPEECH_CLIENT_ID,
      process.env.SALUTESPEECH_CLIENT_SECRET
    )
// Основной командный LiteLLM-шлюз для GigaChat.
const LLM_BASE_URL = serviceUrl('LLM_BASE_URL', process.env.LLM_BASE_URL, {
  allowPrivateHttp: true,
  allowInsecureHttp: ALLOW_INSECURE_LLM_HTTP,
  allowedInsecureHosts: LLM_INSECURE_HTTP_HOSTS
})
const LLM_TRANSPORT_SECURE = isSecureServiceUrl(LLM_BASE_URL)
if (LLM_BASE_URL && !LLM_TRANSPORT_SECURE) {
  console.warn('[security] LLM_BASE_URL uses explicitly allowed plaintext HTTP; prompts and bearer credentials are not encrypted in transit')
}
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim() // виртуальный ключ LiteLLM (sk-...)
const LLM_MODEL = (process.env.LLM_MODEL || 'gigachat-3-ultra').trim()
// Независимый LiteLLM fallback. Он может маршрутизировать запросы в OpenRouter,
// но gateway знает только OpenAI-compatible proxy contract и отдельный proxy key.
const LITELLM_BASE_URL = serviceUrl('LITELLM_BASE_URL', process.env.LITELLM_BASE_URL, {
  allowPrivateHttp: true,
  allowInsecureHttp: ALLOW_INSECURE_LLM_HTTP,
  allowedInsecureHosts: LLM_INSECURE_HTTP_HOSTS
})
const LITELLM_TRANSPORT_SECURE = !LITELLM_BASE_URL || isSecureServiceUrl(LITELLM_BASE_URL)
if (LITELLM_BASE_URL && !LITELLM_TRANSPORT_SECURE) {
  console.warn('[security] LITELLM_BASE_URL uses explicitly allowed plaintext HTTP; prompts and bearer credentials are not encrypted in transit')
}
const TEXT_LLM_TRANSPORT_SECURE = Boolean(LLM_BASE_URL || LITELLM_BASE_URL) &&
  (!LLM_BASE_URL || LLM_TRANSPORT_SECURE) && LITELLM_TRANSPORT_SECURE

// Kandinsky 6.0 (studio.kandinskylab.ai) — один Bearer-токен
const KANDINSKY_TOKEN = (process.env.KANDINSKY_TOKEN || '').trim()
// SaluteSpeech — URL настраиваются через .env (у команды могут быть свои).
const SALUTE_OAUTH_URL = serviceUrl('SBER_SALUTE_OAUTH_URL', process.env.SBER_SALUTE_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth')
const SALUTE_SYNTH_URL = serviceUrl('SBER_SALUTE_SYNTH_URL', process.env.SBER_SALUTE_SYNTH_URL || 'https://smartspeech.sber.ru/rest/v1/text:synthesize')
const SALUTE_RECOGNIZE_URL = serviceUrl('SBER_SALUTE_RECOGNIZE_URL', process.env.SBER_SALUTE_RECOGNIZE_URL || 'https://smartspeech.sber.ru/rest/v1/speech:recognize')
const SALUTE_RECOGNITION_MODEL = (process.env.SBER_SALUTE_RECOGNITION_MODEL || 'voice_messaging').trim()
const SBER_CA_VERIFIED = verifiedSberCertificates.length === 2
const KANDINSKY_HOST = 'https://studio.kandinskylab.ai/api'
// Видео/аватар API (GigaAvatar: image + audio → говорящее видео)
const VIDEO_BASE_URL = serviceUrl('VIDEO_BASE_URL', process.env.VIDEO_BASE_URL, {
  allowPrivateHttp: true,
  allowInsecureHttp: ALLOW_INSECURE_VIDEO_HTTP,
  allowedInsecureHosts: VIDEO_INSECURE_HTTP_HOSTS
})
const VIDEO_TRANSPORT_SECURE = isSecureServiceUrl(VIDEO_BASE_URL)
if (VIDEO_BASE_URL && !VIDEO_TRANSPORT_SECURE) {
  console.warn('[security] VIDEO_BASE_URL uses explicitly allowed plaintext HTTP; media and bearer credentials are not encrypted in transit')
}
serviceUrl('OPENROUTER_BASE_URL', process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1')
const TRACTION_INGEST_URL = serviceUrl('TRACTION_INGEST_URL', process.env.TRACTION_INGEST_URL)
const TRACTION_INGEST_TOKEN = String(process.env.TRACTION_INGEST_TOKEN || '').trim()
if (Boolean(TRACTION_INGEST_URL) !== Boolean(TRACTION_INGEST_TOKEN)) {
  throw new Error('TRACTION_INGEST_URL and TRACTION_INGEST_TOKEN must be configured together')
}
if (PRODUCTION && TRACTION_INGEST_TOKEN && TRACTION_INGEST_TOKEN.length < 32) {
  throw new Error('TRACTION_INGEST_TOKEN must contain at least 32 characters in production')
}
const INSTALLATION_OPERATOR_TOKEN = String(process.env.INSTALLATION_OPERATOR_TOKEN || '').trim()
if (PRODUCTION && INSTALLATION_OPERATOR_TOKEN.length < 32) {
  throw new Error('INSTALLATION_OPERATOR_TOKEN must contain at least 32 characters in production')
}
const CATALOG_INGEST_TOKEN = String(process.env.CATALOG_INGEST_TOKEN || '').trim()
if (PRODUCTION && CATALOG_INGEST_TOKEN.length < 32) {
  throw new Error('CATALOG_INGEST_TOKEN must contain at least 32 characters in production')
}
const BOOK_OPERATOR_USERNAME = String(process.env.BOOK_OPERATOR_USERNAME || 'narra').trim()
const BOOK_OPERATOR_PASSWORD = String(process.env.BOOK_OPERATOR_PASSWORD || '').trim()
if (PRODUCTION && (BOOK_OPERATOR_USERNAME.length < 1 || BOOK_OPERATOR_PASSWORD.length < 20)) {
  throw new Error('BOOK_OPERATOR_USERNAME and a 20+ character BOOK_OPERATOR_PASSWORD are required in production')
}

// ================= Токены (кэш ~30 мин) =================
const tokenCache = {} // scope -> { token, expiresAt }

async function getToken(scope, basicKey, oauthUrl) {
  if (!basicKey) throw httpErr('NO_KEY', `Не задан ключ для scope ${scope}`)
  const now = Date.now()
  const c = tokenCache[scope]
  if (c && c.expiresAt - 60_000 > now) return c.token

  const res = await httpsRequest(oauthUrl, {
    method: 'POST',
    insecure: INSECURE,
    ca: sberCaBundle,
    timeoutMs: 20000,
    headers: {
      Authorization: `Basic ${basicKey}`,
      RqUID: randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: `scope=${scope}`
  })
  if (res.status === 401 || res.status === 403) throw httpErr('AUTH', `OAuth отклонил ключ (${res.status}) для ${scope}`)
  if (res.status !== 200) throw httpErr('NETWORK', `OAuth статус ${res.status}: ${String(res.body).slice(0, 200)}`)
  const json = JSON.parse(res.body)
  const token = json.access_token || json.tok || json.token
  // exp у speech.giga.chat — в секундах; expires_at у Сбера — в мс
  const expiresAt = json.expires_at || (json.exp ? json.exp * 1000 : now + 25 * 60 * 1000)
  if (!token) throw httpErr('AUTH', 'OAuth: сервер не вернул токен')
  tokenCache[scope] = { token, expiresAt }
  return token
}

function httpErr(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}
function statusFor(code) {
  return { NO_KEY: 400, VALIDATION: 400, AUTH: 401, CENSOR: 422, RATE: 429, TIMEOUT: 504, NETWORK: 502 }[code] || 500
}

// ================= Kandinsky 6.0 (kandinskylab) =================
// Стиль задаётся на клиенте (единая арт-дирекция), сервер не добавляет свой.
const STYLE_SUFFIX = ''

function kHeaders() {
  return { Authorization: `Bearer ${KANDINSKY_TOKEN}`, 'Content-Type': 'application/json' }
}

// подбираем поддерживаемое разрешение по ориентации
function resolutionFor(width, height) {
  if (height > width * 1.15) return '768x1280'
  if (width > height * 1.15) return '1280x768'
  return '1024x1024'
}

// Kandinsky не любит параллельных запросов — сериализуем и ретраим лимит.
let kandinskyChain = Promise.resolve()
let kandinskyPending = 0
function kandinskyQueued(prompt, width, height, signal) {
  if (kandinskyPending >= KANDINSKY_QUEUE_LIMIT) throw httpErr('RATE', 'Kandinsky: очередь переполнена')
  kandinskyPending += 1
  const run = kandinskyChain
    .then(() => {
      if (signal?.aborted) throw signal.reason || new Error('client disconnected')
      return kandinskyWithRetry(prompt, width, height, signal)
    })
    .finally(() => { kandinskyPending -= 1 })
  kandinskyChain = run.catch(() => {})
  return run
}
async function kandinskyWithRetry(prompt, width, height, signal, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await kandinskyGenerate(prompt, width, height, signal)
    } catch (e) {
      if (shouldRetryKandinsky(e) && i < attempts - 1) {
        console.error(`[kandinsky] временная ошибка ${e.code}, жду 20с (попытка ${i + 2}/${attempts})`)
        await abortableDelay(20000, signal)
        continue
      }
      throw e
    }
  }
}

async function kandinskyGenerate(prompt, width = 768, height = 1024, signal) {
  const resolution = resolutionFor(width, height)
  const deadline = Date.now() + KANDINSKY_IMAGE_TIMEOUT_MS
  const requestTimeoutMs = () => Math.max(
    1,
    Math.min(KANDINSKY_REQUEST_TIMEOUT_MS, deadline - Date.now())
  )
  // 1) создать задачу
  const runRes = await httpsRequest(`${KANDINSKY_HOST}/tasks/k6-image-t2i`, {
    method: 'POST',
    insecure: INSECURE,
    timeoutMs: requestTimeoutMs(),
    signal,
    headers: kHeaders(),
    body: JSON.stringify({ params: { query: `${prompt}${STYLE_SUFFIX}`.slice(0, 950), resolution } })
  })
  if (runRes.status >= 400) {
    throw imageUpstreamError({
      provider: 'Kandinsky',
      phase: 'create',
      status: runRes.status,
      detail: runRes.body
    })
  }
  const taskId = JSON.parse(runRes.body).task_id
  if (!taskId) throw httpErr('UNKNOWN', 'Kandinsky: нет task_id')

  // 2) поллинг статуса
  let done = false
  while (Date.now() < deadline) {
    await abortableDelay(4000, signal)
    let st
    try {
      st = await httpsRequest(`${KANDINSKY_HOST}/tasks/${taskId}`, {
        insecure: INSECURE,
        timeoutMs: 20000,
        signal,
        headers: kHeaders()
      })
    } catch (error) {
      if (shouldRetryKandinskyStatus(error)) continue
      throw error
    }
    if (st.status >= 400) {
      const upstreamError = imageUpstreamError({
        provider: 'Kandinsky',
        phase: 'status',
        status: st.status,
        detail: st.body
      })
      if (['NETWORK', 'RATE'].includes(upstreamError.code)) continue
      throw upstreamError
    }
    const statusBody = JSON.parse(st.body)
    const status = String(statusBody.status || '').toLowerCase()
    if (status === 'done') {
      done = true
      break
    }
    if (status === 'failed' || status === 'error') {
      throw imageEmptyResultError({
        provider: 'Kandinsky',
        detail: statusBody.error || statusBody.detail || statusBody.message
      })
    }
  }
  if (!done) {
    throw httpErr(
      'TIMEOUT',
      `Kandinsky: таймаут (${Math.round(KANDINSKY_IMAGE_TIMEOUT_MS / 1000)}с)`
    )
  }

  // 3) забрать результат (бинарный PNG)
  const resImg = await httpsRequest(`${KANDINSKY_HOST}/tasks/${taskId}/result`, {
    insecure: INSECURE,
    timeoutMs: requestTimeoutMs(),
    signal,
    binary: true,
    headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` }
  })
  if (resImg.status >= 400) {
    throw imageUpstreamError({
      provider: 'Kandinsky',
      phase: 'result',
      status: resImg.status,
      detail: resImg.body
    })
  }
  if (!resImg.body?.length) {
    throw imageEmptyResultError({ provider: 'Kandinsky' })
  }
  return resImg.body.toString('base64')
}

// ================= Видео (Kandinsky video API) =================
// Видеосервер не терпит параллельных запросов (429 LIMIT_EXHAUSTED) — очередь + ретраи.
let videoChain = Promise.resolve()
let videoPending = 0
function videoTask(taskType, params, signal) {
  if (videoPending >= VIDEO_QUEUE_LIMIT) throw httpErr('RATE', 'Видео: очередь переполнена')
  videoPending += 1
  const run = videoChain
    .then(() => {
      if (signal?.aborted) throw signal.reason || new Error('client disconnected')
      return videoTaskRetry(taskType, params, signal)
    })
    .finally(() => { videoPending -= 1 })
  videoChain = run.catch(() => {})
  return run
}
async function abortableDelay(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('client disconnected'))
    }, { once: true })
  })
}
async function videoTaskRetry(taskType, params, signal, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await videoTaskRaw(taskType, params, signal)
    } catch (e) {
      const wait = videoRetryDelay(e)
      if (wait && i < attempts - 1) {
        // 'concurrent' — заняты все GPU-слоты, освободятся через минуты; 'rate' — секунды
        console.error(`[video] лимит (${wait === 45_000 ? 'слоты заняты' : 'частота'}), жду ${wait / 1000}с (${i + 2}/${attempts})`)
        await abortableDelay(wait, signal)
        continue
      }
      throw e
    }
  }
}

async function videoTaskRaw(taskType, params, signal) {
  if (!VIDEO_BASE_URL) throw httpErr('NO_KEY', 'Видео: VIDEO_BASE_URL не задан')
  const create = await fetch(`${VIDEO_BASE_URL}/tasks/${taskType}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ censor: true, params }),
    signal: withTimeout(signal, 30_000)
  })
  if (!create.ok) {
    const t = await create.text().catch(() => '')
    throw imageUpstreamError({
      provider: 'Kandinsky video',
      phase: 'create',
      status: create.status,
      detail: t
    })
  }
  const { task_id } = await create.json()
  if (!task_id) throw httpErr('UNKNOWN', 'Видео: сервер не вернул task_id')

  const deadline = Date.now() + 480_000
  while (Date.now() < deadline) {
    await abortableDelay(5000, signal)
    const st = await fetch(`${VIDEO_BASE_URL}/tasks/${task_id}`, {
      headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` },
      signal: withTimeout(signal, 20_000)
    })
    if (!st.ok) continue
    const j = await st.json()
    const status = String(j.status || '').toLowerCase()
    if (status === 'done') {
      const r = await fetch(`${VIDEO_BASE_URL}/tasks/${task_id}/result`, {
        headers: { Authorization: `Bearer ${KANDINSKY_TOKEN}` },
        signal: withTimeout(signal, 60_000)
      })
      if (!r.ok) {
        const detail = await r.text().catch(() => '')
        throw imageUpstreamError({
          provider: 'Kandinsky video',
          phase: 'result',
          status: r.status,
          detail
        })
      }
      return Buffer.from(await r.arrayBuffer()).toString('base64')
    }
    if (status === 'failed' || status === 'error') {
      throw imageUpstreamError({
        provider: 'Kandinsky video',
        phase: 'status',
        detail: j.error || j.detail || j.message
      })
    }
  }
  console.error(`[video] ${taskType} таймаут 480с`)
  throw httpErr('TIMEOUT', 'Видео: таймаут (8 мин)')
}

// говорящая голова: портрет + аудио (с ретраем)
async function gigaAvatar(image, audio, query, signal) {
  const params = {
    query: query || 'talking character portrait, front view, natural facial motion, subtle head movement',
    image,
    audio
  }
  return videoTask('giga_avatar', params, signal)
}

// idle-анимация портрета (без звука). Бьютификатор отключён — он падает на воркере.
// С ретраем: видео-воркер иногда падает разово.
async function animatePortrait(image, query, quality, signal) {
  const model = quality === 'hd' ? 'k5-i2v-hd' : 'k5-i2v-lite'
  const params = {
    query: query || 'he stays still, only blinks slowly and breathes subtly, locked camera, fixed framing, no zoom',
    image,
    beautificator: 'disabled'
  }
  return videoTask(model, params, signal)
}

async function recordInternalGenerationCost(input) {
  if (!generationCostLedger) {
    throw Object.assign(new Error('generation cost ledger is not ready'), {
      code: 'GENERATION_COST_LEDGER_UNAVAILABLE',
      status: 503
    })
  }
  return generationCostLedger.record(input)
}

async function completeInternalChat({ messages, signal, costContext }) {
  let release
  const requestId = randomUUID()
  let providerResult
  let recorded = false
  try {
    release = await llmGate.acquire(signal)
    providerResult = await requestChat({
      messages,
      purpose: 'structured_task',
      stream: false,
      requestId,
      signal
    })
    const { response, finalizeAttempt } = providerResult
    const payload = await settleProviderResponse({
      finalizeAttempt,
      consume: async () => {
        const bytes = await readBoundedBody(response, LLM_RESPONSE_MAX_BYTES, signal)
        let json
        try {
          json = JSON.parse(bytes.toString('utf8'))
        } catch (error) {
          throw Object.assign(error, { code: 'PARSE', status: 502 })
        }
        return validateChatCompletionPayload(json)
      }
    })
    await recordInternalGenerationCost({
      context: costContext,
      modality: 'text',
      requestId,
      attempts: providerResult.attempts,
      usage: payload?.usage,
      responseCost: providerResult.responseCost
    })
    recorded = true
    return payload?.choices?.[0]?.message?.content || ''
  } catch (error) {
    const attempts = providerResult?.attempts || error?.attempts
    if (!recorded && Array.isArray(attempts) && attempts.length) {
      await recordInternalGenerationCost({
        context: costContext,
        modality: 'text',
        requestId: providerResult?.requestId || error?.requestId || requestId,
        attempts,
        responseCost: providerResult?.responseCost
      })
    }
    throw error
  } finally {
    release?.()
  }
}

async function generateInternalPortrait(prompt, signal, costContext = null) {
  // Portraits use the same gpt-image-2 cover chain as generateInternalScene.
  // Never send bound art through GigaChat Image.
  return generateInternalCharacterPortrait(prompt, signal, costContext)
}

async function measuredInternalImageRequest({ prompt, aspectRatio, signal, costContext }) {
  try {
    const generated = await requestCoverImageWithFallback({
      prompt,
      aspectRatio,
      requestId: randomUUID(),
      signal
    })
    await recordInternalGenerationCost({
      context: costContext,
      modality: 'image',
      requestId: generated.requestId,
      attempts: generated.attempts,
      usage: generated.usage,
      responseCost: generated.responseCost
    })
    return generated
  } catch (error) {
    if (Array.isArray(error?.attempts) && error.attempts.length) {
      await recordInternalGenerationCost({
        context: costContext,
        modality: 'image',
        requestId: error.requestId,
        attempts: error.attempts
      })
    }
    throw error
  }
}

async function generateInternalCover(prompt, signal, costContext) {
  let release
  try {
    release = await imageGate.acquire(signal)
    const generated = await measuredInternalImageRequest({
      prompt,
      aspectRatio: '2:3',
      costContext,
      signal
    })
    const bytes = Buffer.from(generated.image, 'base64')
    if (!bytes.byteLength || bytes.byteLength > 18 * 1024 * 1024) {
      throw httpErr('NETWORK', 'Image provider returned an invalid cover')
    }
    return {
      bytes,
      mimeType: generated.mimeType,
      model: generated.model,
      provider: `${coverProviderConfig.provider}:${generated.model}`
    }
  } finally {
    release?.()
  }
}

async function generateInternalCharacterPortrait(prompt, signal, costContext) {
  let release
  try {
    release = await imageGate.acquire(signal)
    const generated = await measuredInternalImageRequest({
      prompt,
      aspectRatio: '3:4',
      costContext,
      signal
    })
    const bytes = Buffer.from(generated.image, 'base64')
    if (!bytes.byteLength || bytes.byteLength > 18 * 1024 * 1024) {
      throw httpErr('NETWORK', 'Image provider returned an invalid portrait')
    }
    return {
      bytes,
      mimeType: generated.mimeType,
      model: generated.model,
      provider: `${coverProviderConfig.provider}:${generated.model}`
    }
  } finally {
    release?.()
  }
}

async function generateInternalScene(prompt, signal, costContext) {
  let release
  try {
    release = await imageGate.acquire(signal)
    const generated = await measuredInternalImageRequest({
      prompt,
      aspectRatio: '4:3',
      costContext,
      signal
    })
    const bytes = Buffer.from(generated.image, 'base64')
    if (!bytes.byteLength || bytes.byteLength > 18 * 1024 * 1024) {
      throw httpErr('NETWORK', 'Image provider returned an invalid scene')
    }
    return {
      bytes,
      mimeType: generated.mimeType,
      model: generated.model,
      provider: `${coverProviderConfig.provider}:${generated.model}`
    }
  } finally {
    release?.()
  }
}

async function synthesizeInternalSpeech(text, voice, signal) {
  let release
  try {
    release = await speechGate.acquire(signal)
    const { providerVoice } = parseSynthesisBody({ text, voice })
    const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
    const response = await httpsRequest(
      `${SALUTE_SYNTH_URL}?format=wav16&voice=${encodeURIComponent(providerVoice)}`,
      {
        method: 'POST',
        insecure: INSECURE,
        ca: sberCaBundle,
        timeoutMs: 60_000,
        maxResponseBytes: 16 * 1024 * 1024,
        signal,
        binary: true,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/text'
        },
        body: Buffer.from(text, 'utf8')
      }
    )
    if (response.status === 401) {
      delete tokenCache['SALUTE_SPEECH_PERS']
      throw httpErr('AUTH', 'SaluteSpeech rejected the service token')
    }
    if (response.status === 429) throw httpErr('RATE', 'SaluteSpeech rate limit')
    if (response.status !== 200 || !response.body?.length) {
      throw httpErr('NETWORK', `SaluteSpeech returned ${response.status}`)
    }
    return { bytes: Buffer.from(response.body), mimeType: 'audio/wav', provider: 'salute-speech' }
  } finally {
    release?.()
  }
}

async function generateInternalIdleAnimation(
  portraitBytes,
  signal,
  query = 'the character stays still, blinks slowly and breathes subtly, locked camera, no zoom',
  quality = 'lite'
) {
  if (KANDINSKY_TOKEN && VIDEO_BASE_URL) {
    try {
      const base64 = await animatePortrait(
        Buffer.from(portraitBytes).toString('base64'),
        query,
        quality,
        signal
      )
      const bytes = Buffer.from(base64, 'base64')
      if (bytes.byteLength) return { bytes, mimeType: 'video/mp4', provider: 'kandinsky-video' }
    } catch (error) {
      console.error('[internal-generation] video provider failed, using local idle animation:', error.message)
    }
  }
  return { ...(await createLocalIdleAnimation(portraitBytes, signal)), provider: 'local-ffmpeg' }
}


// Долгие задачи: отвечаем сразу и шлём keep-alive пробелы, чтобы fetch клиента
// не обрывался по таймауту (undici ждёт первых байт максимум 5 минут).
// JSON.parse спокойно терпит ведущие пробелы.
async function longJob(res, job) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const ka = setInterval(() => res.write(' '), 15000)
  try {
    const data = await job()
    clearInterval(ka)
    res.end(JSON.stringify(data))
  } catch (e) {
    clearInterval(ka)
    res.end(JSON.stringify({ error: e.message, code: e.code || 'UNKNOWN' }))
  }
}

// ================= Express =================
const app = express()
const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true)
      callback(new Error('Origin is not allowed'))
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Audio-Type'],
    exposedHeaders: ['X-Narra-Auth-Error', 'RateLimit-Reset'],
    maxAge: 3600
  })
)
const tokenSecret = resolveTokenSecret()
const tokenService = createTokenService(tokenSecret, { ttlSeconds: INSTALLATION_TOKEN_TTL_SECONDS })
const analyticsSecret = String(process.env.ANALYTICS_HMAC_SECRET || (!PRODUCTION ? tokenSecret : ''))
const installationSecretPepper = String(
  process.env.INSTALLATION_SECRET_PEPPER || (!PRODUCTION ? tokenSecret : '')
)
if (PRODUCTION && analyticsSecret.length < 32) throw new Error(
  'ANALYTICS_HMAC_SECRET must be a separate stable secret of at least 32 characters in production'
)
if (PRODUCTION && installationSecretPepper.length < 32) {
  throw new Error('INSTALLATION_SECRET_PEPPER must contain at least 32 characters in production')
}
if (PRODUCTION && analyticsSecret === tokenSecret) {
  throw new Error('ANALYTICS_HMAC_SECRET must differ from GATEWAY_TOKEN_SECRET in production')
}
if (
  PRODUCTION &&
  new Set([
    tokenSecret,
    analyticsSecret,
    installationSecretPepper,
    INSTALLATION_OPERATOR_TOKEN,
    CATALOG_INGEST_TOKEN,
    BOOK_OPERATOR_PASSWORD
  ]).size !== 6
) {
  throw new Error('Gateway, analytics, installation pepper, operator, catalog and book UI secrets must all differ')
}
const dataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production'
  ? '/data'
  : new URL('./.data', import.meta.url).pathname)
if (PRODUCTION) {
  const railway = Boolean(process.env.RAILWAY_ENVIRONMENT_ID)
  const railwayMount = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim()
  const declaredMount = railway
    ? railwayMount
    : String(process.env.PERSISTENT_DATA_MOUNT_PATH || '').trim()
  if (railway && !railwayMount) {
    throw new Error('Railway production requires an attached Volume with RAILWAY_VOLUME_MOUNT_PATH')
  }
  if (!declaredMount || path.resolve(declaredMount) !== path.resolve(dataDir)) {
    throw new Error('Production DATA_DIR must exactly match the declared persistent Volume mount')
  }
  if (process.env.INSTALLATION_SINGLE_REPLICA_ACK !== 'true') {
    throw new Error('INSTALLATION_SINGLE_REPLICA_ACK=true is required for the file-backed registry')
  }
  if (railway) {
    const overlapSeconds = Number(process.env.RAILWAY_DEPLOYMENT_OVERLAP_SECONDS || 0)
    const drainingSeconds = Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS || 0)
    if (!Number.isInteger(overlapSeconds) || overlapSeconds !== 0) {
      throw new Error('Railway deployment overlap must be exactly 0 seconds')
    }
    if (!Number.isInteger(drainingSeconds) || drainingSeconds < 30) {
      throw new Error('Railway deployment draining must be at least 30 seconds')
    }
  }
}
const installationRegistry = createInstallationRegistry({
  dataDir,
  environment: ANALYTICS_ENV,
  maxInstallations: INSTALLATION_REGISTRY_MAX,
  registrationLimitPerHour: REGISTRATION_GLOBAL_LIMIT,
  registrationLimitPerDay: REGISTRATION_GLOBAL_DAILY_LIMIT,
  inactiveRetentionDays: INSTALLATION_INACTIVE_RETENTION_DAYS
})
await installationRegistry.start()
const eventStore = createEventStore({
  dataDir,
  environment: ANALYTICS_ENV,
  tractionUrl: TRACTION_INGEST_URL,
  tractionToken: TRACTION_INGEST_TOKEN
})
eventStore.start()
const coverJobStore = createCoverJobStore({
  dataDir,
  environment: ANALYTICS_ENV,
  maxJobs: COVER_JOB_MAX,
  resultTtlMs: COVER_JOB_TTL_HOURS * 60 * 60 * 1000,
  maxResultBytes: COVER_JOB_MAX_RESULT_MIB * 1024 * 1024
})
await coverJobStore.start()
const coverJobRunner = createCoverJobRunner({
  store: coverJobStore,
  enabled: COVER_JOB_WORKER_ENABLED,
  concurrency: COVER_CONCURRENCY,
  maxAttempts: COVER_JOB_MAX_ATTEMPTS,
  attemptTimeoutMs: COVER_JOB_ATTEMPT_TIMEOUT_SECONDS * 1000,
  generate: async ({ prompt, signal }) => {
    const generated = await generateInternalCover(prompt, signal)
    return {
      image: generated.bytes.toString('base64'),
      mimeType: generated.mimeType,
      model: generated.model
    }
  }
})
coverJobRunner.start()
const sceneJobStore = createCoverJobStore({
  dataDir,
  environment: ANALYTICS_ENV,
  namespace: 'scene',
  maxJobs: SCENE_JOB_MAX,
  resultTtlMs: SCENE_JOB_TTL_HOURS * 60 * 60 * 1000,
  maxResultBytes: COVER_JOB_MAX_RESULT_MIB * 1024 * 1024
})
await sceneJobStore.start()
const sceneJobRunner = createCoverJobRunner({
  store: sceneJobStore,
  enabled: SCENE_JOB_WORKER_ENABLED,
  concurrency: IMAGE_CONCURRENCY,
  maxAttempts: SCENE_JOB_MAX_ATTEMPTS,
  attemptTimeoutMs: SCENE_JOB_ATTEMPT_TIMEOUT_SECONDS * 1000,
  generate: async ({ prompt, signal }) => {
    // Bound scene jobs use the same gpt-image-2 cover chain as scenes/at.
    // Never send scenes through GigaChat Image.
    const generated = await generateInternalScene(prompt, signal)
    return {
      image: generated.bytes.toString('base64'),
      mimeType: generated.mimeType,
      model: generated.provider
    }
  }
})
sceneJobRunner.start()

let bookMarkupPool = null
let bookMarkupRepository = null
let bookAnalysisRepository = null
let bookTtsMarkupRepository = null
let bookOperatorRepository = null
let generationCostLedger = null
let bookSearchRepository = null
let bookSearchService = null
let privateMaterialCleanupTimer = null
let privateMaterialCleanupInitialTimer = null
const bookObjectStorage = createBookObjectStorageFromEnv(process.env)
const generatorServiceToken = String(process.env.GENERATOR_SERVICE_TOKEN || '').trim()
const internalGenerationService = bookObjectStorage && generatorServiceToken
  ? createInternalGenerationService({
      storage: bookObjectStorage,
      completeChat: completeInternalChat,
      generatePortrait: generateInternalCharacterPortrait,
      generateCover: generateInternalCover,
      generateScene: generateInternalScene,
      synthesizeSpeech: synthesizeInternalSpeech,
      generateIdleAnimation: generateInternalIdleAnimation,
      maxBookBytes: BOOK_UPLOAD_MAX_BYTES
    })
  : null
if (!internalGenerationService) {
  console.warn('[internal-generation] storage or GENERATOR_SERVICE_TOKEN is not configured; internal API is disabled')
}
if (process.env.DATABASE_URL) {
  bookMarkupPool = await createPostgresPoolFromEnv(process.env)
  await runBookMarkupMigrations(bookMarkupPool)
  generationCostLedger = createGenerationCostLedger(bookMarkupPool, {
    required: String(process.env.GENERATION_COST_LEDGER_REQUIRED || 'true').trim().toLowerCase() !== 'false'
  })
  bookMarkupRepository = createPostgresBookMarkupRepository(bookMarkupPool, {
    privateMaterialTtlDays: PRIVATE_MATERIAL_TTL_DAYS
  })
  bookAnalysisRepository = createPostgresBookAnalysisRepository(bookMarkupPool, {
    defaultPipelineId: BOOK_ANALYSIS_PIPELINE,
    mediaGenerationEnabled: BOOK_ANALYSIS_MEDIA_GENERATION_ENABLED
  })
  bookTtsMarkupRepository = createPostgresBookTtsMarkupRepository(bookMarkupPool)
  bookOperatorRepository = createPostgresBookOperatorRepository(bookMarkupPool)
  if (BOOK_SEARCH_ENABLED) {
    bookSearchRepository = createPostgresBookSearchRepository(bookMarkupPool)
    bookSearchService = createBookSearchService({
      repository: bookSearchRepository,
      embeddingClient: createBookEmbeddingClientFromEnv(process.env)
    })
    console.info('[book-search] API enabled; books are enqueued only by explicit operator command')
  }
  if (bookAnalysisRepository) {
    const analysisBackfill = await bookAnalysisRepository.enqueueCatalogAnalysisBackfill()
    console.info('[book-analysis] catalog marking_up backfill checked', {
      books: analysisBackfill.length,
      created: analysisBackfill.filter((item) => item.created).length
    })
  }
  if (internalGenerationService && BOOK_ANALYSIS_MEDIA_GENERATION_ENABLED) {
    const identityJobs = await bookMarkupRepository.enqueueMissingBookIdentities()
    const coverJobs = await bookMarkupRepository.enqueueMissingCatalogCovers()
    const characterMediaJobs = await bookMarkupRepository.enqueueCharacterMediaBackfill()
    const sceneBackfills = await bookMarkupRepository.enqueueBookSceneBackfill()
    console.info('[book-identity] durable backfill checked', {
      jobs: identityJobs.length,
      created: identityJobs.filter((job) => job.created).length
    })
    console.info('[catalog-cover] durable backfill checked', {
      jobs: coverJobs.length,
      created: coverJobs.filter((job) => job.created).length
    })
    console.info('[character-media] independent backfill checked', {
      jobs: characterMediaJobs.length,
      created: characterMediaJobs.filter((job) => job.created).length
    })
    console.info('[book-scenes] durable backfill checked', {
      books: sceneBackfills.length,
      requested: sceneBackfills.reduce((total, value) => total + value.requested, 0),
      pending: sceneBackfills.reduce((total, value) => total + value.pending, 0)
    })
  } else if (internalGenerationService) {
    console.info('[book-media] generation and startup backfills are disabled')
  }
  if (bookObjectStorage) {
    const cleanup = createPrivateMaterialCleanup({
      repository: bookMarkupRepository,
      storage: bookObjectStorage,
      batchSize: PRIVATE_MATERIAL_CLEANUP_BATCH_SIZE
    })
    const runCleanup = () => void cleanup.runOnce().catch((error) => {
      console.error('[book-cleanup] cleanup loop failed', error)
    })
    privateMaterialCleanupInitialTimer = setTimeout(runCleanup, 5_000)
    privateMaterialCleanupInitialTimer.unref?.()
    privateMaterialCleanupTimer = setInterval(runCleanup, PRIVATE_MATERIAL_CLEANUP_MS)
    privateMaterialCleanupTimer.unref?.()
  }
} else {
  console.warn('[book-markup] DATABASE_URL is not configured; catalog API is disabled')
}

async function checkBookBackendReady() {
  if (!bookMarkupPool || !bookObjectStorage || !internalGenerationService) return false
  try {
    await Promise.all([
      bookMarkupPool.query('SELECT 1'),
      bookObjectStorage.checkReady({ signal: AbortSignal.timeout(3_000) })
    ])
    return true
  } catch {
    return false
  }
}

function actorIdFor(req) {
  return createHmac('sha256', analyticsSecret).update(req.installation.sub).digest('hex')
}

async function appendInternalEvent(req, eventName, properties, eventId = randomUUID()) {
  try {
    await eventStore.append([{
      event_id: eventId,
      event_name: eventName,
      actor_id: actorIdFor(req),
      occurred_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      session_id: null,
      schema_version: 1,
      properties
    }])
  } catch (error) {
    // Product requests must keep working if the analytics volume is degraded.
    console.error('[analytics] internal event was not persisted:', error?.message || error)
  }
}
const registrationLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: REGISTRATION_LIMIT,
  key: (req) => req.ip
})
const refreshAttemptLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: REFRESH_ATTEMPT_LIMIT,
  key: (req) => `${req.ip}:${req.body?.installation_id || ''}`
})
const refreshSuccessLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: REFRESH_LIMIT,
  key: (req) => req.body.installation_id
})
const apiLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: API_LIMIT,
  key: (req) => req.installation?.sub || req.ip
})
const installationKey = (req) => req.installation?.sub || req.ip
const eventLimit = createFixedWindowLimiter({ windowMs: 60 * 1000, limit: EVENT_LIMIT, key: installationKey })
const aiLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: AI_LIMIT,
  key: installationKey
})
const aiDailyLimit = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'ai_requests',
  perInstallationLimit: AI_DAILY_LIMIT,
  globalLimit: AI_GLOBAL_DAILY_LIMIT
})
const videoLimit = createFixedWindowLimiter({
  windowMs: 60 * 60 * 1000,
  limit: VIDEO_LIMIT,
  key: installationKey
})
const videoDailyLimit = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'video_requests',
  perInstallationLimit: VIDEO_DAILY_LIMIT,
  globalLimit: VIDEO_GLOBAL_DAILY_LIMIT
})
const speechLimit = createFixedWindowLimiter({
  windowMs: 60 * 1000,
  limit: SPEECH_LIMIT,
  key: installationKey
})
const speechDailyLimit = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'speech_requests',
  perInstallationLimit: SPEECH_DAILY_LIMIT,
  globalLimit: SPEECH_GLOBAL_DAILY_LIMIT
})
const imageDailyLimit = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'image_requests',
  perInstallationLimit: IMAGE_DAILY_LIMIT,
  globalLimit: IMAGE_GLOBAL_DAILY_LIMIT
})
const coverDailyLimit = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'cover_requests',
  perInstallationLimit: COVER_DAILY_LIMIT,
  globalLimit: COVER_GLOBAL_DAILY_LIMIT
})
const importLimit = createFixedWindowLimiter({ windowMs: 60 * 1000, limit: IMPORT_LIMIT, key: installationKey })
const importDailyLimit = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'import_requests',
  perInstallationLimit: IMPORT_DAILY_LIMIT,
  globalLimit: IMPORT_GLOBAL_DAILY_LIMIT
})
const importByteBudget = createPersistentBudgetMiddleware({
  registry: installationRegistry,
  metric: 'import_bytes',
  amount: () => 30 * 1024 * 1024,
  perInstallationLimit: IMPORT_DAILY_BYTES_MB * 1024 * 1024,
  globalLimit: IMPORT_GLOBAL_DAILY_BYTES_MB * 1024 * 1024
})

app.get('/health', (_req, res) => {
  const llm = llmRouteReadiness()
  const durableImageReady = Boolean(LLM_API_KEY || KANDINSKY_TOKEN)
  res.json({
    ok: true,
    version: BUILD_VERSION,
    environment: ANALYTICS_ENV,
    services: {
      gigachat: llm.ready,
      salutespeech: !!SALUTE_KEY && SBER_CA_VERIFIED,
      kandinsky: !!KANDINSKY_TOKEN,
      cover: durableImageReady,
      video: !!KANDINSKY_TOKEN && !!VIDEO_BASE_URL,
      book_markup: Boolean(bookMarkupRepository),
      book_storage: Boolean(bookObjectStorage),
      internal_generation: Boolean(internalGenerationService),
      book_backend_required: BOOK_BACKEND_REQUIRED
    },
    media_transport: {
      llm_https: TEXT_LLM_TRANSPORT_SECURE,
      litellm_https: LITELLM_TRANSPORT_SECURE,
      llm_insecure_http_allowed: Boolean(
        ALLOW_INSECURE_LLM_HTTP &&
        ((LLM_BASE_URL && !LLM_TRANSPORT_SECURE) || (LITELLM_BASE_URL && !LITELLM_TRANSPORT_SECURE))
      ),
      video_https: VIDEO_TRANSPORT_SECURE,
      video_insecure_http_allowed: Boolean(VIDEO_BASE_URL && !VIDEO_TRANSPORT_SECURE && ALLOW_INSECURE_VIDEO_HTTP),
      sber_ca_verified: SBER_CA_VERIFIED
    },
    llm_routes: llm.purposes,
    analytics_delivery: eventStore.status(),
    installation_registry: {
      storage_verified: installationRegistry.status().storage_verified,
      capacity_remaining: installationRegistry.status().capacity_remaining
    },
    cover_jobs: {
      ...coverJobStore.status(),
      worker: coverJobRunner.status()
    },
    scene_jobs: {
      ...sceneJobStore.status(),
      worker: sceneJobRunner.status()
    },
    concurrency: { llm: llmGate.status(), speech: speechGate.status(), image: imageGate.status(), cover: coverGate.status(), import: importGate.status() }
  })
})

app.get('/ready', async (_req, res) => {
  const llm = llmRouteReadiness()
  const coverReady = Boolean(LLM_API_KEY || KANDINSKY_TOKEN)
  const registryStatus = installationRegistry.status()
  const coverJobStatus = coverJobStore.status()
  const bookBackendReady = await checkBookBackendReady()
  const videoConfigured = !!KANDINSKY_TOKEN && !!VIDEO_BASE_URL
  const videoTransportAccepted =
    VIDEO_TRANSPORT_SECURE ||
    Boolean(ALLOW_INSECURE_VIDEO_HTTP && INSECURE_VIDEO_ENV_ALLOWED)
  const readiness = gatewayReadiness({
    llmReady: llm.ready,
    speechReady: !!SALUTE_KEY && SBER_CA_VERIFIED,
    imageReady: coverReady || !!KANDINSKY_TOKEN,
    storageReady: registryStatus.storage_verified && coverJobStatus.storage_verified,
    videoConfigured,
    videoTransportAccepted,
    videoRequired: VIDEO_REQUIRED,
    videoTransportSecure: VIDEO_TRANSPORT_SECURE,
    llmTransportSecure: TEXT_LLM_TRANSPORT_SECURE,
    environment: ANALYTICS_ENV,
    bookBackendRequired: BOOK_BACKEND_REQUIRED,
    bookBackendReady
  })
  res.status(readiness.ready ? 200 : 503).json({
    ok: readiness.ready,
    version: BUILD_VERSION,
    environment: ANALYTICS_ENV,
    degraded: readiness.degraded,
    checks: readiness.checks,
    media_transport: {
      llm_https: TEXT_LLM_TRANSPORT_SECURE,
      litellm_https: LITELLM_TRANSPORT_SECURE,
      llm_insecure_http_allowed: Boolean(
        ALLOW_INSECURE_LLM_HTTP &&
        ((LLM_BASE_URL && !LLM_TRANSPORT_SECURE) || (LITELLM_BASE_URL && !LITELLM_TRANSPORT_SECURE))
      ),
      video_https: VIDEO_TRANSPORT_SECURE,
      video_insecure_http_allowed: Boolean(
        videoConfigured && !VIDEO_TRANSPORT_SECURE && ALLOW_INSECURE_VIDEO_HTTP
      ),
      sber_ca_verified: SBER_CA_VERIFIED
    },
    llm_routes: llm.purposes,
    installation_registry: {
      storage_verified: registryStatus.storage_verified
    },
    cover_jobs: {
      storage_verified: coverJobStatus.storage_verified,
      worker_enabled: coverJobRunner.status().enabled
    }
  })
})

app.post('/v2/installations/register', registrationLimit, express.json({ limit: '16kb' }), async (req, res, next) => {
  const body = req.body || {}
  const keys = Object.keys(body)
  if (keys.some((key) => !['installation_id', 'installation_secret', 'app_version', 'platform', 'arch'].includes(key))) {
    return res.status(400).json({ error: 'Неизвестное поле регистрации', code: 'VALIDATION' })
  }
  if (!isInstallationId(body.installation_id)) {
    return res.status(400).json({ error: 'Некорректный installation_id', code: 'VALIDATION' })
  }
  const refreshSecretHash = hashInstallationSecret(body.installation_secret, installationSecretPepper)
  if (!refreshSecretHash) {
    return res.status(400).json({ error: 'Некорректный installation secret', code: 'VALIDATION' })
  }
  for (const key of ['app_version', 'platform', 'arch']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 80)) {
      return res.status(400).json({ error: `Некорректное поле ${key}`, code: 'VALIDATION' })
    }
  }
  try {
    const registration = await installationRegistry.register({
      installationId: body.installation_id,
      refreshSecretHash,
      appVersion: body.app_version,
      platform: body.platform,
      arch: body.arch
    })
    if (!registration.ok) {
      if (registration.code === 'REVOKED') {
        return res.status(403).json({ error: 'Эта установка отозвана', code: 'AUTH' })
      }
      if (registration.code === 'INVALID_PROOF') {
        return res.status(403).json({ error: 'Installation proof отклонён', code: 'AUTH' })
      }
      if (registration.resetAt) {
        res.setHeader('RateLimit-Reset', String(Math.ceil(registration.resetAt / 1000)))
      }
      return res.status(429).json({
        error: registration.code === 'REGISTRY_FULL'
          ? 'Лимит зарегистрированных установок исчерпан'
          : 'Общий лимит регистраций исчерпан',
        code: 'RATE'
      })
    }
    return res.status(registration.created ? 201 : 200).json({
      token: tokenService.issue(
        body.installation_id,
        registration.record.token_version
      ),
      token_type: 'Bearer',
      expires_in: INSTALLATION_TOKEN_TTL_SECONDS
    })
  } catch (error) {
    next(error)
  }
})

app.post(
  '/v2/installations/refresh',
  express.json({ limit: '16kb' }),
  refreshAttemptLimit,
  async (req, res, next) => {
    try {
      const body = req.body || {}
      if (
        Object.keys(body).some((key) => !['installation_id', 'installation_secret'].includes(key)) ||
        !isInstallationId(body.installation_id)
      ) {
        return res.status(400).json({ error: 'Некорректный refresh payload', code: 'VALIDATION' })
      }
      const refreshSecretHash = hashInstallationSecret(
        body.installation_secret,
        installationSecretPepper
      )
      if (!refreshSecretHash) {
        return res.status(400).json({ error: 'Некорректный installation secret', code: 'VALIDATION' })
      }
      const refresh = await installationRegistry.refresh(body.installation_id, refreshSecretHash)
      if (!refresh.ok) {
        if (refresh.code === 'NOT_FOUND') {
          res.setHeader('X-Narra-Auth-Error', 'installation_not_found')
          return res.status(404).json({
            error: 'Установка больше не зарегистрирована',
            code: 'INSTALLATION_NOT_FOUND'
          })
        }
        if (refresh.code === 'REVOKED') {
          return res.status(403).json({ error: 'Установка отозвана', code: 'REVOKED' })
        }
        return res.status(403).json({ error: 'Installation proof отклонён', code: 'AUTH' })
      }
      return refreshSuccessLimit(req, res, () => {
        res.json({
          token: tokenService.issue(body.installation_id, refresh.record.token_version),
          token_type: 'Bearer',
          expires_in: INSTALLATION_TOKEN_TTL_SECONDS
        })
      })
    } catch (error) {
      next(error)
    }
  }
)

const operatorAuth = requireOperatorAuth(INSTALLATION_OPERATOR_TOKEN)
app.get('/v2/admin/installations/:installationId', operatorAuth, (req, res) => {
  if (!isInstallationId(req.params.installationId)) {
    return res.status(400).json({ error: 'Некорректный installation_id', code: 'VALIDATION' })
  }
  const record = installationRegistry.get(req.params.installationId)
  if (!record) return res.status(404).json({ error: 'Установка не найдена', code: 'NOT_FOUND' })
  res.json({ installation_id: req.params.installationId, ...record })
})
app.post(
  '/v2/admin/installations/:installationId/revoke',
  operatorAuth,
  express.json({ limit: '4kb' }),
  async (req, res, next) => {
    if (!isInstallationId(req.params.installationId)) {
      return res.status(400).json({ error: 'Некорректный installation_id', code: 'VALIDATION' })
    }
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== 'reason') ||
      (req.body.reason !== undefined && typeof req.body.reason !== 'string')
    ) {
      return res.status(400).json({ error: 'Некорректная причина отзыва', code: 'VALIDATION' })
    }
    try {
      const record = await installationRegistry.revoke(
        req.params.installationId,
        req.body.reason
      )
      if (!record) return res.status(404).json({ error: 'Установка не найдена', code: 'NOT_FOUND' })
      res.json({
        installation_id: req.params.installationId,
        status: record.status,
        revoked_at: record.revoked_at
      })
    } catch (error) {
      next(error)
    }
  }
)

if (bookMarkupRepository && bookObjectStorage) {
  const catalogIngestService = createCatalogIngestService({
    repository: bookMarkupRepository,
    analysisRepository: bookAnalysisRepository,
    storage: bookObjectStorage
  })
  app.use('/v2/admin/catalog', createCatalogIngestRouter({
    token: CATALOG_INGEST_TOKEN,
    service: catalogIngestService,
    uploadMaxBytes: BOOK_UPLOAD_MAX_BYTES
  }))
  if (BOOK_OPERATOR_PASSWORD && bookOperatorRepository) {
    app.use('/operator', createBookOperatorRouter({
      username: BOOK_OPERATOR_USERNAME,
      password: BOOK_OPERATOR_PASSWORD,
      dashboardRepository: bookOperatorRepository,
      analysisRepository: bookAnalysisRepository,
      catalogService: catalogIngestService,
      uploadMaxBytes: BOOK_UPLOAD_MAX_BYTES
    }))
  }
}

// Public generic update feed. Integrity comes from electron-builder SHA-512
// metadata plus the required Developer ID signature of the macOS app. Keeping
// it before /v2 auth is required because electron-updater does not hold an
// installation bearer token.
app.use('/v2/updates/files', express.static(new URL('./updates', import.meta.url).pathname, {
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', filePath.endsWith('.yml') ? 'no-store' : 'public, max-age=31536000, immutable')
  }
}))
app.use('/v2/updates/files', (_req, res) => res.status(404).json({ error: 'Update artifact not found' }))

if (internalGenerationService) {
  app.use('/internal', createInternalGenerationRouter({
    token: generatorServiceToken,
    service: internalGenerationService
  }))
}

app.use('/v2', requireGatewayAuth(tokenService, installationRegistry), apiLimit)
// Parsers deliberately live after bearer auth/rate limiting. Large unauthenticated
// bodies are rejected before Express buffers or parses them. Endpoint quotas
// are attached directly before each parser so Express path normalization cannot
// bypass them with case or trailing-slash variants.
if (bookMarkupRepository) {
  if (bookSearchService) {
    app.use('/v2/books', createBookSearchRouter({ service: bookSearchService }))
  }
  app.use('/v2/books', createBookCatalogRouter({
    repository: bookMarkupRepository,
    analysisRepository: bookAnalysisRepository,
    ttsMarkupRepository: bookTtsMarkupRepository,
    shadowPreviewEnabled: BOOK_SHADOW_PREVIEW_ENABLED,
    storage: bookObjectStorage,
    uploadMaxBytes: BOOK_UPLOAD_MAX_BYTES
  }))
}

app.post('/v2/events/batch', eventLimit, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    if (
      !req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== 'events') ||
      !Array.isArray(req.body.events) || req.body.events.length < 1 || req.body.events.length > 100
    ) {
      return res.status(400).json({ error: 'events: нужен массив из 1–100 событий', code: 'VALIDATION' })
    }
    const events = []
    const rejected = []
    for (const candidate of req.body.events) {
      try {
        events.push(parseEventBatch({ events: [candidate] })[0])
      } catch {
        rejected.push({
          event_id: typeof candidate?.eventId === 'string' ? candidate.eventId.slice(0, 36) : ''
        })
      }
    }
    const actorId = actorIdFor(req)
    const receivedAt = new Date().toISOString()
    if (events.length) {
      await eventStore.append(events.map((event) => ({
        ...event,
        actor_id: actorId,
        received_at: receivedAt
      })))
    }
    res.status(202).json({ accepted: events.length, rejected })
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

// --- Чат: стриминг через LiteLLM-шлюз (OpenAI /v1/chat/completions) ---
app.post('/v2/ai/chat/stream', aiLimit, aiDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const startedAt = Date.now()
  const clientSignal = requestAbortSignal(req, res)
  let requestId
  let release
  let analyticsOrigin = 'user'
  let recordActorAnalytics = true
  let requestPurpose
  try {
    release = await llmGate.acquire(clientSignal)
    const input = parseChatBody(req.body, { stream: true })
    analyticsOrigin = input.origin
    recordActorAnalytics = input.analyticsTier !== 'none'
    requestPurpose = input.purpose
    requestId = input.requestId || randomUUID()
    if (recordActorAnalytics) {
      await appendInternalEvent(req, 'ai_request_started', {
        request_id: requestId,
        purpose: input.purpose,
        origin: input.origin
      })
    }
    const { response: upstream, provider, model, responseCost, finalizeAttempt } = await requestChat({
      ...input,
      requestId,
      stream: true,
      onAttempt: recordActorAnalytics
        ? (attempt) => appendInternalEvent(
            req,
            `provider_attempt_${attempt.status}`,
            providerAttemptProperties(requestId, input.purpose, attempt),
            attempt.event_id
          )
        : undefined,
      signal: clientSignal
    })
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Request-Id', requestId)
    res.setHeader('X-Narra-Route', analyticsRoute(provider, model))
    let usageCollector
    const usage = await settleProviderResponse({
      finalizeAttempt,
      consume: async () => {
        let streamedBytes = 0
        usageCollector = createSseUsageCollector()
        for await (const chunk of upstream.body) {
          streamedBytes += Buffer.byteLength(chunk)
          if (streamedBytes > LLM_RESPONSE_MAX_BYTES) {
            await upstream.body.cancel().catch(() => {})
            throw Object.assign(new Error('LLM response exceeded the gateway limit'), { code: 'NETWORK', status: 502 })
          }
          usageCollector.push(chunk)
          res.write(chunk)
        }
        return usageCollector.value()
      }
    })
    res.end()
    const finishReason = usageCollector?.finishReason()
    if (finishReason === 'length') {
      console.warn(`[llm] ответ обрезан лимитом max_tokens: purpose=${input.purpose} request_id=${requestId}`)
    }
    if (recordActorAnalytics) {
      await appendInternalEvent(req, 'ai_request_completed', completionProperties({
        requestId,
        purpose: input.purpose,
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        usage,
        responseCost,
        origin: input.origin,
        finishReason
      }))
    }
  } catch (e) {
    if (requestId && recordActorAnalytics) await appendInternalEvent(req, 'ai_request_failed', {
      request_id: requestId,
      ...(requestPurpose ? { purpose: requestPurpose } : {}),
      origin: analyticsOrigin,
      latency_ms: Date.now() - startedAt,
      error_code: e.code || 'NETWORK',
      success: false
    }).catch(() => {})
    if (!res.headersSent) {
      res.status(e.status || 502).json({
        error: String(e.message),
        code: e.code || 'NETWORK',
        request_id: e.requestId
      })
    } else {
      const code = [
        'PARSE', 'CENSOR', 'CANCELLED', 'TIMEOUT', 'NETWORK'
      ].includes(e.code) ? e.code : 'NETWORK'
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: { code } })}\n\n`)
      } catch {
        // The client may already have disconnected; analytics is still failed.
      }
      res.end()
    }
  } finally {
    release?.()
  }
})

// --- Чат: обычный ответ (для разметки/саммари/эмоций) ---
app.post('/v2/ai/chat/complete', aiLimit, aiDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const startedAt = Date.now()
  const clientSignal = requestAbortSignal(req, res)
  let requestId
  let release
  let analyticsOrigin = 'user'
  let recordActorAnalytics = true
  let requestPurpose
  try {
    release = await llmGate.acquire(clientSignal)
    const input = parseChatBody(req.body)
    analyticsOrigin = input.origin
    recordActorAnalytics = input.analyticsTier !== 'none'
    requestPurpose = input.purpose
    requestId = input.requestId || randomUUID()
    const groundedMessages = await attachBookSearchContext({
      search: bookSearchService?.search?.bind(bookSearchService),
      subjectId: req.installation?.sub,
      bookEditionId: input.bookEditionId,
      messages: input.messages,
      purpose: input.purpose
    })
    if (recordActorAnalytics) {
      await appendInternalEvent(req, 'ai_request_started', {
        request_id: requestId,
        purpose: input.purpose,
        origin: input.origin
      })
    }
    const { response: r, provider, model, attempts, responseCost, finalizeAttempt } = await requestChat({
      ...input,
      messages: groundedMessages,
      requestId,
      stream: false,
      onAttempt: recordActorAnalytics
        ? (attempt) => appendInternalEvent(
            req,
            `provider_attempt_${attempt.status}`,
            providerAttemptProperties(requestId, input.purpose, attempt),
            attempt.event_id
          )
        : undefined,
      signal: clientSignal
    })
    const j = await settleProviderResponse({
      finalizeAttempt,
      consume: async () => {
        const responseBytes = await readBoundedBody(r, LLM_RESPONSE_MAX_BYTES, clientSignal)
        let payload
        try {
          payload = JSON.parse(responseBytes.toString('utf8'))
        } catch (error) {
          throw Object.assign(error, { code: 'PARSE', status: 502 })
        }
        return validateChatCompletionPayload(payload)
      }
    })
    const finishReason = j?.choices?.[0]?.finish_reason
    if (finishReason === 'length') {
      console.warn(`[llm] ответ обрезан лимитом max_tokens: purpose=${input.purpose} request_id=${requestId}`)
    }
    if (recordActorAnalytics) {
      await appendInternalEvent(req, 'ai_request_completed', completionProperties({
        requestId,
        purpose: input.purpose,
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        usage: j?.usage,
        responseCost,
        origin: input.origin,
        finishReason
      }))
    }
    res.json({
      text: j?.choices?.[0]?.message?.content ?? '',
      request_id: requestId,
      route: analyticsRoute(provider, model),
      usage: j?.usage || null,
      attempts: attempts.length
    })
  } catch (e) {
    if (requestId && recordActorAnalytics) await appendInternalEvent(req, 'ai_request_failed', {
      request_id: requestId,
      ...(requestPurpose ? { purpose: requestPurpose } : {}),
      origin: analyticsOrigin,
      latency_ms: Date.now() - startedAt,
      error_code: e.code || 'NETWORK',
      success: false
    }).catch(() => {})
    res.status(e.status || 502).json({ error: String(e.message), code: e.code || 'NETWORK', request_id: e.requestId })
  } finally {
    release?.()
  }
})

// --- SaluteSpeech: синтез сегмента ---
app.post('/v2/speech/synthesize', speechLimit, speechDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const clientSignal = requestAbortSignal(req, res)
  let release
  try {
    release = await speechGate.acquire(clientSignal)
    const { text, ssml, providerVoice, sampleRate } = parseSynthesisBody(req.body)
    const isSsml = !!ssml
    const payload = isSsml ? ssml : text || ''
    const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
    const url = `${SALUTE_SYNTH_URL}?format=wav16&voice=${encodeURIComponent(providerVoice)}`
    const r = await httpsRequest(url, {
      method: 'POST',
      insecure: INSECURE,
      ca: sberCaBundle,
      timeoutMs: 60000,
      maxResponseBytes: 16 * 1024 * 1024,
      signal: clientSignal,
      binary: true,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': isSsml ? 'application/ssml' : 'application/text'
      },
      body: Buffer.from(payload, 'utf8')
    })
    if (r.status === 401) {
      delete tokenCache['SALUTE_SPEECH_PERS']
      return res.status(401).json({ error: 'SaluteSpeech: токен отклонён', code: 'AUTH' })
    }
    if (r.status === 429) return res.status(429).json({ error: 'SaluteSpeech: лимит', code: 'RATE' })
    if (r.status !== 200) {
      return res.status(502).json({ error: `SaluteSpeech ${r.status}: ${r.body?.toString('utf8').slice(0, 160)}`, code: 'NETWORK' })
    }
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('X-Audio-Sample-Rate', String(sampleRate))
    res.send(r.body)
  } catch (e) {
    res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
  } finally {
    release?.()
  }
})

// gigachat-image через шлюз — мгновенно, тем же ключом, без рейт-лимита Кандинского.
async function gigachatImage(prompt, signal) {
  const r = await fetch(`${LLM_BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gigachat-image', prompt: String(prompt).slice(0, 1000) }),
    signal: withTimeout(signal, 90_000)
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw imageUpstreamError({
      provider: 'GigaChat Image',
      phase: 'create',
      status: r.status,
      detail: t
    })
  }
  const j = await r.json()
  const b64 = j?.data?.[0]?.b64_json
  if (!b64) {
    throw imageEmptyResultError({
      provider: 'GigaChat Image',
      detail: JSON.stringify(j)
    })
  }
  return b64
}

// --- SaluteSpeech: распознавание речи (ASR) ---
app.post(
  '/v2/speech/recognize',
  speechLimit,
  speechDailyLimit,
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res) => {
    if (!SALUTE_KEY) return res.status(400).json({ error: 'ASR: ключ не задан', code: 'NO_KEY' })
    const clientSignal = requestAbortSignal(req, res)
    let release
    try {
      release = await speechGate.acquire(clientSignal)
      const token = await getToken('SALUTE_SPEECH_PERS', SALUTE_KEY, SALUTE_OAUTH_URL)
      const ct = String(req.headers['x-audio-type'] || 'audio/x-pcm;bit=16;rate=16000')
      const url =
        SALUTE_RECOGNIZE_URL +
        (SALUTE_RECOGNITION_MODEL ? `?model=${encodeURIComponent(SALUTE_RECOGNITION_MODEL)}` : '')
      const r = await httpsRequest(url, {
        method: 'POST',
        insecure: INSECURE,
        ca: sberCaBundle,
        timeoutMs: 60000,
        signal: clientSignal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': ct },
        body: req.body
      })
      if (r.status === 401) {
        delete tokenCache['SALUTE_SPEECH_PERS']
        return res.status(401).json({ error: 'ASR: токен отклонён', code: 'AUTH' })
      }
      if (r.status !== 200) {
        return res
          .status(502)
          .json({ error: `ASR ${r.status}: ${String(r.body).slice(0, 160)}`, code: 'NETWORK' })
      }
      const j = JSON.parse(r.body)
      const text = Array.isArray(j.result) ? j.result.join(' ') : j.result || j.text || ''
      res.json({ text })
    } catch (e) {
      res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
    } finally {
      release?.()
    }
  }
)

// --- Генерация изображения: gigachat-image (осн.), Kandinsky (фолбэк) ---
// Загрузка книг по ссылке (AO3 заблокирован в РФ — качаем сервером).
// Строгий белый список хостов, только https, лимит 30 МБ.
app.get('/v2/import/fetch', importLimit, importDailyLimit, importByteBudget, async (req, res) => {
  const clientSignal = requestAbortSignal(req, res)
  let release
  try {
    release = await importGate.acquire(clientSignal)
    const r = await fetchImportSource(String(req.query.url || ''), { signal: clientSignal })
    if (!r.ok) {
      const failure = importSourceFailure(r.status)
      await r.body?.cancel().catch(() => {})
      return res.status(failure.status).json({
        error: failure.code === 'RATE'
          ? 'Сайт временно ограничил загрузку (антифлуд). Подожди пару минут и попробуй снова.'
          : `Источник ответил ${r.status}`,
        code: failure.code
      })
    }
    const buf = await readBoundedBody(r, 30 * 1024 * 1024, clientSignal)
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
    res.send(buf)
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e.message), code: e.code || 'NETWORK' })
  } finally {
    release?.()
  }
})

// Пиковую нагрузку регулирует imageGate внутри обработчика, а расходы — суточный
// бюджет. Почасовой middleware здесь нельзя ставить: он возвращает 429 раньше,
// чем основной image-провайдер успевает переключиться на fallback.
app.post('/v2/media/images', imageDailyLimit, express.json({ limit: '1mb' }), async (req, res) => {
  const signal = requestAbortSignal(req, res)
  let release
  try {
    release = await imageGate.acquire(signal)
    const { prompt, width, height, engine } = parseImageBody(req.body)
    // Scene and cover never go through GigaChat Image. Bound generateInternalScene
    // and this one-off route share the gpt-image-2 cover provider chain.
    // `engine` stays in the HTTP body for released clients and is ignored for
    // provider selection.
    const isCover = height > width
    const isScene = engine === 'kandinsky' || width === height
    const aspectRatio = isCover
      ? (width * 4 === height * 3 ? '3:4' : '2:3')
      : isScene
        ? '4:3'
        : width * 4 === height * 3 ? '3:4' : width === height ? '1:1' : width > height ? '3:2' : '2:3'
    const image = await requestCoverImageWithFallback({ prompt, aspectRatio, signal })
    return res.json({ image: image.image, mime_type: image.mimeType })
  } catch (e) {
    res.status(statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
  } finally {
    release?.()
  }
})

function coverJobPollAfter(job) {
  if (job.status === 'retry_wait') {
    return Math.min(60_000, Math.max(3_000, job.next_attempt_at - Date.now()))
  }
  return ['queued', 'running'].includes(job.status) ? 3_000 : 0
}

async function coverJobPayload(job, { includeImage = false } = {}) {
  const payload = {
    job_id: job.job_id,
    status: job.status,
    poll_after_ms: coverJobPollAfter(job),
    attempt_count: job.attempt_count,
    expires_at: job.expires_at
  }
  if (job.status === 'failed') {
    payload.code = job.error_code || 'UNKNOWN'
    payload.error = job.error_message || 'Не удалось создать обложку'
  }
  if (includeImage && job.status === 'completed') {
    const result = await coverJobStore.readResult(job)
    payload.image = result?.toString('base64')
    payload.mime_type = job.mime_type || 'image/jpeg'
    payload.model = job.model || undefined
  }
  return payload
}

async function sceneJobPayload(job, { includeImage = false } = {}) {
  const payload = {
    job_id: job.job_id,
    status: job.status,
    poll_after_ms: coverJobPollAfter(job),
    attempt_count: job.attempt_count,
    expires_at: job.expires_at
  }
  if (job.status === 'failed') {
    payload.code = job.error_code || 'UNKNOWN'
    payload.error = job.error_message || 'Не удалось создать сцену'
  }
  if (includeImage && job.status === 'completed') {
    const result = await sceneJobStore.readResult(job)
    payload.image = result?.toString('base64')
    payload.mime_type = job.mime_type || 'image/png'
    payload.model = job.model || undefined
  }
  return payload
}

async function reserveCoverJobBudget(installationId) {
  const reservation = await installationRegistry.reserve({
    installationId,
    metric: 'cover_requests',
    perInstallationLimit: COVER_DAILY_LIMIT,
    globalLimit: COVER_GLOBAL_DAILY_LIMIT
  })
  if (!reservation.ok) {
    const error = new Error(
      reservation.scope === 'global'
        ? 'Общий дневной бюджет сервиса исчерпан'
        : 'Дневной лимит установки исчерпан'
    )
    error.code = 'RATE'
    error.status = 429
    error.resetAt = reservation.resetAt
    throw error
  }
  return reservation
}

async function reserveSceneJobBudget(installationId) {
  const reservation = await installationRegistry.reserve({
    installationId,
    metric: 'image_requests',
    perInstallationLimit: IMAGE_DAILY_LIMIT,
    globalLimit: IMAGE_GLOBAL_DAILY_LIMIT
  })
  if (!reservation.ok) {
    const error = new Error(
      reservation.scope === 'global'
        ? 'Общий дневной бюджет сервиса исчерпан'
        : 'Дневной лимит установки исчерпан'
    )
    error.code = 'RATE'
    error.status = 429
    error.resetAt = reservation.resetAt
    throw error
  }
  return reservation
}

// Durable cover jobs: the HTTP request ends immediately, while the worker keeps
// GPT Image → Nano Banana running on the persistent gateway volume.
app.post('/v2/media/cover/jobs', express.json({ limit: '64kb' }), async (req, res) => {
  let reservation
  try {
    const { prompt: legacyPrompt, book, requestId } = parseCoverJobBody(req.body)
    const prompt = legacyPrompt ?? bookCoverPrompt(book)
    const result = await coverJobStore.createOrGet({
      installationId: req.installation.sub,
      requestId,
      prompt,
      beforeCreate: async () => {
        reservation = await reserveCoverJobBudget(req.installation.sub)
      }
    })
    if (reservation) {
      res.setHeader('RateLimit-Daily-Limit', String(COVER_DAILY_LIMIT))
      res.setHeader('RateLimit-Daily-Remaining', String(reservation.installationRemaining))
      res.setHeader('RateLimit-Global-Remaining', String(reservation.globalRemaining))
      res.setHeader('RateLimit-Reset', String(Math.ceil(reservation.resetAt / 1000)))
    }
    if (result.created) coverJobRunner.notify()
    const status = ['completed', 'failed'].includes(result.job.status) ? 200 : 202
    res.status(status).json(await coverJobPayload(result.job, {
      includeImage: result.job.status === 'completed'
    }))
  } catch (error) {
    if (error.resetAt) res.setHeader('RateLimit-Reset', String(Math.ceil(error.resetAt / 1000)))
    res.status(error.status || statusFor(error.code)).json({
      error: error.message,
      code: error.code || 'UNKNOWN'
    })
  }
})

app.get('/v2/media/cover/jobs/:jobId', async (req, res) => {
  try {
    const job = coverJobStore.getForInstallation(req.params.jobId, req.installation.sub)
    if (!job) return res.status(404).json({ error: 'Задача обложки не найдена', code: 'NOT_FOUND' })
    res.json(await coverJobPayload(job, { includeImage: true }))
  } catch (error) {
    res.status(error.status || statusFor(error.code)).json({
      error: error.message,
      code: error.code || 'UNKNOWN'
    })
  }
})

app.post('/v2/media/cover/jobs/:jobId/ack', async (req, res) => {
  try {
    const acknowledged = await coverJobStore.acknowledge(req.params.jobId, req.installation.sub)
    if (!acknowledged) return res.status(404).json({ error: 'Задача обложки не найдена', code: 'NOT_FOUND' })
    res.status(204).end()
  } catch (error) {
    res.status(error.status || statusFor(error.code)).json({
      error: error.message,
      code: error.code || 'UNKNOWN'
    })
  }
})

// Scene requests carry structured book facts. Prompt construction, credentials,
// provider selection, retry and persisted result ownership stay on the gateway.
app.post('/v2/media/scene/jobs', express.json({ limit: '64kb' }), async (req, res) => {
  let reservation
  try {
    const input = parseSceneJobBody(req.body)
    const result = await sceneJobStore.createOrGet({
      installationId: req.installation.sub,
      requestId: input.requestId,
      prompt: sceneGenerationPrompt(input),
      beforeCreate: async () => {
        reservation = await reserveSceneJobBudget(req.installation.sub)
      }
    })
    if (reservation) {
      res.setHeader('RateLimit-Daily-Limit', String(IMAGE_DAILY_LIMIT))
      res.setHeader('RateLimit-Daily-Remaining', String(reservation.installationRemaining))
      res.setHeader('RateLimit-Global-Remaining', String(reservation.globalRemaining))
      res.setHeader('RateLimit-Reset', String(Math.ceil(reservation.resetAt / 1000)))
    }
    if (result.created) sceneJobRunner.notify()
    const status = ['completed', 'failed'].includes(result.job.status) ? 200 : 202
    res.status(status).json(await sceneJobPayload(result.job, {
      includeImage: result.job.status === 'completed'
    }))
  } catch (error) {
    if (error.resetAt) res.setHeader('RateLimit-Reset', String(Math.ceil(error.resetAt / 1000)))
    res.status(error.status || statusFor(error.code)).json({
      error: error.message,
      code: error.code || 'UNKNOWN'
    })
  }
})

app.get('/v2/media/scene/jobs/:jobId', async (req, res) => {
  try {
    const job = sceneJobStore.getForInstallation(req.params.jobId, req.installation.sub)
    if (!job) return res.status(404).json({ error: 'Задача сцены не найдена', code: 'NOT_FOUND' })
    res.json(await sceneJobPayload(job, { includeImage: true }))
  } catch (error) {
    res.status(error.status || statusFor(error.code)).json({
      error: error.message,
      code: error.code || 'UNKNOWN'
    })
  }
})

app.post('/v2/media/scene/jobs/:jobId/ack', async (req, res) => {
  try {
    const acknowledged = await sceneJobStore.acknowledge(req.params.jobId, req.installation.sub)
    if (!acknowledged) return res.status(404).json({ error: 'Задача сцены не найдена', code: 'NOT_FOUND' })
    res.status(204).end()
  } catch (error) {
    res.status(error.status || statusFor(error.code)).json({
      error: error.message,
      code: error.code || 'UNKNOWN'
    })
  }
})

// Compatibility route for already released clients. Kandinsky is deliberately
// not part of the cover path; new clients use the durable job endpoints above.
app.post('/v2/media/cover', coverDailyLimit, express.json({ limit: '64kb' }), async (req, res) => {
  const signal = requestAbortSignal(req, res)
  let release
  try {
    release = await coverGate.acquire(signal)
    const { prompt } = parseCoverBody(req.body)
    const cover = await requestCoverImageWithFallback({ prompt, signal })
    res.json({ image: cover.image, mime_type: cover.mimeType })
  } catch (e) {
    res.status(e.status || statusFor(e.code)).json({ error: e.message, code: e.code || 'UNKNOWN' })
  } finally {
    release?.()
  }
})

// --- GigaAvatar: портрет + аудио → говорящее видео ---
app.post('/v2/media/avatar', videoLimit, videoDailyLimit, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { image, audio, query } = parseAvatarBody(req.body)
    if (!KANDINSKY_TOKEN) return res.status(400).json({ error: 'Видео: токен не задан на сервере', code: 'NO_KEY' })
    const signal = requestAbortSignal(req, res)
    longJob(res, async () => ({ video: await gigaAvatar(image, audio, query, signal) }))
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

// --- Idle-анимация портрета (image → короткое видео, без звука) ---
app.post('/v2/media/portrait-animation', videoLimit, videoDailyLimit, express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { image, query, quality } = parsePortraitBody(req.body)
    const signal = requestAbortSignal(req, res)
    longJob(res, async () => {
      const generated = await generateInternalIdleAnimation(
        Buffer.from(image, 'base64'), signal, query, quality
      )
      return { video: generated.bytes.toString('base64'), provider: generated.provider }
    })
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'UNKNOWN' })
  }
})

app.use(validationErrors)
app.use((error, _req, res, _next) => {
  if (error?.message === 'Origin is not allowed') {
    return res.status(403).json({ error: 'Origin is not allowed', code: 'AUTH' })
  }
  console.error('[gateway]', error)
  res.status(500).json({ error: 'Внутренняя ошибка gateway', code: 'UNKNOWN' })
})

const httpServer = app.listen(PORT, () => {
  const llm = llmRouteReadiness()
  console.log(`[narra-proxy] слушает :${PORT}`)
  console.log(`  чат(LLM): ${llm.ready ? 'ok' : '—'}  salutespeech: ${SALUTE_KEY ? 'ok' : '—'}  kandinsky: ${KANDINSKY_TOKEN ? 'ok' : '—'}`)
  console.log(`  шлюз: ${LLM_BASE_URL}  модель: ${LLM_MODEL}`)
  console.log(`  fallback LiteLLM: ${LITELLM_BASE_URL || '—'}`)
})

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  if (privateMaterialCleanupTimer) clearInterval(privateMaterialCleanupTimer)
  if (privateMaterialCleanupInitialTimer) clearTimeout(privateMaterialCleanupInitialTimer)
  console.log(`[narra-proxy] ${signal}: draining HTTP and analytics outbox`)
  const force = setTimeout(() => process.exit(1), 25_000)
  force.unref?.()
  httpServer.close(async (error) => {
    try {
      await coverJobRunner.stop()
      await sceneJobRunner.stop()
      await Promise.all([
        eventStore.stop(),
        installationRegistry.stop(),
        coverJobStore.stop(),
        sceneJobStore.stop(),
        bookMarkupPool?.end()
      ])
      if (error) throw error
      clearTimeout(force)
      process.exit(0)
    } catch (shutdownError) {
      console.error('[narra-proxy] graceful shutdown failed', shutdownError)
      process.exit(1)
    }
  })
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
