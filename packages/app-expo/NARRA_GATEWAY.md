# Narra gateway — contract as seen by the mobile app

The HTTP contract is owned by `services/narra-gateway`. Source of truth, in this order:

1. `services/narra-gateway/index.mjs` — auth, limits, AI/speech/media/events/import routes and
   the mount points of the routers below;
2. `services/narra-gateway/book-catalog-api.mjs` — everything under `/v2/books` (catalog,
   private books, manifest, progress, scenes, media downloads);
3. `services/narra-gateway/book-search-api.mjs` — `/v2/books/:id/search|graph|graph/search`,
   mounted **only** when `BOOK_SEARCH_ENABLED=true` (see "Optional search router").

Request-body validation lives in `services/narra-gateway/contracts.mjs` (AI, speech, media) and
in the parse helpers at the top of `book-catalog-api.mjs`. Every body is validated with
"exact keys": an unknown field is a `400 VALIDATION`, so **never add client fields without a
gateway change** (`book_edition_id` on `/v2/ai/chat/*` is a known example that is rejected).

This file lists the routes, the shapes the client relies on, and which client module calls
what. It does not replace `services/narra-gateway/README.md` (operations, workers,
analytics delivery, deployment).

## Client configuration

All network calls go through `src/lib/ai/narra-gateway-fetch.ts` (`narraGatewayRequest`,
`getNarraGatewayConfig`, installation auth, timeouts).

| Variable | Effect (`narra-gateway-fetch.ts:64-73`) |
|---|---|
| `EXPO_PUBLIC_NARRA_ENVIRONMENT` | `production` → base URL is hard-coded to `https://api.narra.disrupt.builders`, whatever `EXPO_PUBLIC_NARRA_GATEWAY_URL` says. `test` → build reports itself as a test build to `/health` diagnostics. Anything else → `unknown`. |
| `EXPO_PUBLIC_NARRA_GATEWAY_URL` | Base URL for non-production builds. When empty the client falls back to the staging host `https://api-test.narra.disrupt.builders`; there is no "not configured" state. |
| `EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE` | `installation` (default) — register/refresh flow, secret in SecureStore, `Authorization: Bearer <token>`. `none` — no `Authorization` header (local gateway / host adapter). |
| `EXPO_PUBLIC_NARRA_ANALYTICS_TIER` | `essential` (default) or `none`; sent as `analytics_tier` on AI calls and controls `/v2/events/batch` (`src/lib/analytics/telemetry.ts`). |
| `EXPO_PUBLIC_NARRA_USE_MOCKS` | Dev-only fixtures for character analysis UI (`src/lib/narra/character-analysis.ts`); ignored in production bundles. |
| `EXPO_PUBLIC_NARRA_TTS_PROVIDER` | `grok` (default) or `gateway` for character/scene voice (`src/lib/narra/media.ts:35-41`). `grok` calls OpenRouter **directly** with a bundled key, bypassing the gateway; that key is not set in any `eas.json` profile, so character/scene voice currently fails with `CONFIG` unless `gateway` is chosen. Book TTS always uses `/v2/speech/synthesize`. |

`eas.json` profiles: `development`/`preview`/`test` → `EXPO_PUBLIC_NARRA_ENVIRONMENT=test`,
URL `https://api-test.narra.disrupt.builders`; `production`/`production-*` →
`EXPO_PUBLIC_NARRA_ENVIRONMENT=production`, URL `https://api.narra.disrupt.builders`. All
profiles use `EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE=installation`.

Client timeouts (`narra-gateway-fetch.ts:16-22`): default 60 s, `/v2/media/images` 150 s,
`/v2/media/cover` 180 s, installation calls 15 s, `/health` 5 s. Streaming chat uses the
streaming fetch installed in `App.tsx`.

## Authentication (installation identity)

Unauthenticated routes: `GET /health`, `GET /ready`, `POST /v2/installations/register`,
`POST /v2/installations/refresh`, `GET /v2/updates/files/*` (desktop auto-update feed).
Everything else under `/v2` requires `Authorization: Bearer <installation token>`
(`requireGatewayAuth`, `index.mjs:1692`) and is subject to the API rate limit.

| Route | Body / result |
|---|---|
| `POST /v2/installations/register` | `{ installation_id, installation_secret, app_version?, platform?, arch? }` → `201/200 { token, token_type: "Bearer", expires_in }`. `403 AUTH` for revoked installations or a wrong proof; `429 RATE` when the per-IP or global registration budget is exhausted (`RateLimit-Reset` header). |
| `POST /v2/installations/refresh` | `{ installation_id, installation_secret }` → `200 { token, token_type, expires_in }`. `404 INSTALLATION_NOT_FOUND` with header `X-Narra-Auth-Error: installation_not_found` when the registry no longer knows the installation (client re-registers); `403 REVOKED` / `403 AUTH` otherwise. |

Token TTL is `INSTALLATION_TOKEN_TTL_SECONDS` (default 900 s, minimum 300 s). An expired or
invalid bearer token yields `401` with header `X-Narra-Auth-Error: installation_token`
(`security.mjs:159`); the client drops the cached token and retries once
(`narra-gateway-fetch.ts:402-456`). Both headers are CORS-exposed together with
`RateLimit-Reset`.

## Rate limits and daily budgets (gateway defaults)

Per installation unless stated; all configurable via env (`index.mjs:180-213`).

| Scope | Limit |
|---|---|
| Registration | 10 / hour per IP; global 500 / hour, 250 / day |
| Refresh | 20 successful / hour per installation; 40 attempts / hour per IP+installation |
| Any `/v2/*` | 120 requests / minute (`apiLimit`) |
| `/v2/ai/chat/*` | 30 / minute; 500 / day per installation; 25 000 / day global |
| `/v2/speech/*` | 60 / minute; 1 000 / day; 50 000 / day global |
| `/v2/media/images` | 100 / day; 5 000 / day global (no per-minute limit by design) |
| `/v2/media/cover*` | 60 / day; 3 000 / day global |
| `/v2/media/avatar`, `/v2/media/portrait-animation` | 8 / hour; 20 / day; 500 / day global |
| `/v2/import/fetch` | 6 / minute; 20 / day; 300 MiB / day; global 1 000 / day, 10 000 MiB |
| `/v2/events/batch` | 10 / minute |
| `PUT /v2/books/:id/source` | body ≤ `BOOK_UPLOAD_MAX_MIB` (default 50 MiB) |

Concurrency gates (LLM 16, speech 5 on staging, image 4, cover 2, import 2) queue requests and
return `429 RATE` when the queue is full.

## Error envelope

Every JSON error is `{ "error": "<human message, mostly Russian>", "code": "<CODE>" }`;
AI routes add `request_id`. Codes seen by the client: `VALIDATION` (400/413), `AUTH` (401/403),
`REVOKED`, `INSTALLATION_NOT_FOUND`, `RATE` (429), `NO_KEY`, `NETWORK` (502), `TIMEOUT`,
`PARSE`, `CENSOR`, `CANCELLED`, `NOT_FOUND` (404), `UPLOAD_INTEGRITY` (409),
`CATALOG_CONFLICT` (409), `MARKUP_PROCESSING`, `MARKUP_FAILED` (409), `ANALYSIS_UNAVAILABLE`
(503), `DOWNLOAD_UNAVAILABLE` (503), `PREVIEW_DISABLED` (404), `UNAVAILABLE`, `UNKNOWN`.
The client maps these in `src/lib/narra/errors.ts`.

Routes that are not mounted (e.g. the search router when the flag is off, or `/v2/books` when
the book backend is not configured) fall through to Express and answer with an **HTML 404**,
not the JSON envelope. Clients must treat a non-JSON 404 as "feature unavailable".

## Books: catalog, private books, manifest, progress, scenes

Mounted at `/v2/books` from `book-catalog-api.mjs` when the book backend is configured
(`index.mjs:1697-1710`); staging and production both have it (`/health` →
`services.book_markup: true`).

Common JSON shapes (`book-catalog-api.mjs:356-483`):

- **book** — `{ resolution: "catalog"|"local", book_edition_id, catalog_key, title, author,
  genres: string[], language: string|null, format, content_sha256, generation_status, ready,
  source_download_path, source_uploaded, expires_at, cover?: { content_hash, mime_type,
  byte_size, download_path } }`.
- **manifest** — `{ source: "v3", book, availability: "ready"|"processing"|"failed"|"cancelled"|
  "unavailable", publication_id, run_id, content_hash, published_at, correction, reader_text_offset,
  reading_fraction, reader_section_index, reader_section_fraction, analysis?: { run_id, stage,
  status, retryable, error_code, updated_at, text_length, completed_scan_chunks,
  total_scan_chunks }, markup?: { schema_version, analysis_version: "book-markup-v3", revision,
  text_length, scene_policy: { version: "text-interval-v1", start_text_offset,
  interval_text_length: 6000 }, published_at }, tts_markup?: { status, version, revision,
  retry_after_ms }, characters: [...] }`.
- **manifest.characters[]** — `{ character_key, name, full_name, first_appearance_text_offset,
  provisional, state: "ready"|"preparing", profile: { role, description,
  descriptionRevealTextOffset, traits[], personalitySnapshots[], speechStyle, speechExamples[],
  appearancePrompt, greeting, voice, analysisSource }, bundle?: { version: "character-bundle-v3",
  assets: [{ asset_id, type: "primary_portrait"|"greeting_audio"|"idle_animation", content_hash,
  mime_type, byte_size, download_path }] } }`. `profile.voice` is a SaluteSpeech voice code
  (e.g. `Erm`); the client treats it as a hint and assigns the final voice locally
  (`src/lib/narra/voice-rules.ts`). Only v3 manifests are served; editions with v2-only markup
  come back as `availability: "unavailable"` with `characters: []`.

| Route | Purpose · body → response | Client module |
|---|---|---|
| `GET /v2/books/genres` | `{ version: "catalog-genres-v1", items: [{ id, label_ru, label_en, order }] }` | `backend-catalog-api.ts` |
| `GET /v2/books/catalog?limit&cursor` | Popular catalog (`base_ready`/`published` editions only) → `{ items: book[], next_cursor }` | `backend-catalog-api.ts` |
| `GET /v2/books/catalog/languages/:language?limit&cursor` | `ru` or `en` shelf → `{ contract_version: "book-catalog-language-v1", language, items, next_cursor }`; cursors are language-bound | `backend-catalog-api.ts` |
| `POST /v2/books/resolve` | `{ source: "catalog", catalog_key }` or `{ source: "local", content_sha256 }` → book | `backend-book-sync.ts` |
| `POST /v2/books/local` | `{ content_sha256, title, author, format: "epub"|"fb2"|"txt"|"pdf", language? }` → `201` book (or `200` when the hash matches a catalog edition, `resolution: "catalog"`) | `backend-book-sync.ts` |
| `PUT /v2/books/:id/source` | Raw file bytes, `Content-Type` = file MIME, ≤ 50 MiB → `202` book. `409 UPLOAD_INTEGRITY` when the bytes do not match `content_sha256`; `413 VALIDATION` when too large. Upload starts canonical analysis (`ensureCanonicalAnalysis`). | `backend-book-sync.ts` |
| `GET /v2/books/:id/source/download` | `{ download_url, expires_at }` signed URL for the catalog EPUB | `backend-catalog-import.ts` |
| `GET /v2/books/:id/cover/download` | `{ download_url, expires_at }` | `backend-catalog-api.ts` |
| `GET /v2/books/:id/media/:assetId/download` | `{ download_url, expires_at }` for a character asset; the gateway re-checks the reader has reached the character | `backend-character-media.ts` |
| `GET /v2/books/:id/identity` | `202`/`200` `{ version, book_edition_id, status, title, author, source, updated_at, poll_after_ms, error_code }` | `backend-book-sync.ts` |
| `GET /v2/books/:id/manifest` | `202` while `availability: "processing"`, `200` otherwise (including `failed`/`unavailable`) | `backend-book-sync.ts` |
| `POST /v2/books/:id/progress` | exactly one of `progress_fraction` (0–1) or `text_offset`; optional `chapter_key`, `section_index`+`section_fraction` → `{ book_edition_id, reader_text_offset, reading_fraction, chapter_key, section_index, section_fraction, warmup, scene_warmup }`. High-water mark: the server never moves the reader backwards. `scene_warmup` is currently always zeros (no frontier extension on progress). | `backend-book-api.ts` |
| `POST /v2/books/:id/scenes/at` | exactly one of `reader_text_offset` or `progress_fraction` → `200` when ready, `202` while `queued`/`running`/`processing`, `409` on `MARKUP_FAILED`. Body: `{ status, code, error_code, retryable, analysis?, scene_key, slot_index, anchor_text_offset, image_url, mime_type, expires_at, poll_after_ms }`. Slots are 6 000 normalized characters wide (`book-scenes.mjs`). `MARKUP_PROCESSING` → poll after 5 s; otherwise `poll_after_ms: 2000`. `404 NOT_FOUND` for editions without v3 markup + normalized text. | `backend-scene.ts` |
| `POST /v2/books/:id/analysis/retry` | `{ request_id: uuid }` → `202/200 { status, created, idempotent, run_id, run_sequence, analysis }`; only private editions are retryable | `backend-book-api.ts` |
| `GET /v2/books/:id/content` | Full normalized text: `{ contract_version, representation, book_edition_id, content_hash, text_length, byte_size, download_url, expires_at }` | (not called by the app) |
| `GET /v2/books/:id/content/chunks?cursor` | Chunked normalized text with section info | (not called) |
| `GET /v2/books/:id/content/toc` | Server TOC mapped to text offsets | (not called) |
| `GET /v2/books/:id/tts-script/sections/:sectionIndex` | Role-attributed TTS script per section; `202` + `Retry-After` while processing, `200 { contract_version, revision, normalized_text_hash, section: { key, title, index, start_offset, end_offset, segments: [{ id, start_offset, end_offset, text, kind, character_key, confidence }] } }` when ready | (not called yet; client does dialogue attribution locally in `voice-markup.ts`) |
| `GET /v2/books/:id/analysis-shadow/manifest` | Preview of the latest shadow publication; `404 PREVIEW_DISABLED` unless `BOOK_SHADOW_PREVIEW_ENABLED=true` | (operators) |
| `POST /v2/books/:id/local-markup` | Legacy `local-character-v1` upload; effectively dead once the analysis repository is configured (v3 manifests ignore it) | (no longer called) |

## Optional search router (`BOOK_SEARCH_ENABLED`)

`book-search-api.mjs` is mounted **before** the catalog router only when
`BOOK_SEARCH_ENABLED=true` (`index.mjs:1216,1698`); `.env.example` ships `false`. On
2026-09-01 staging (`api-test`, build `ebd6773d`) `GET /v2/books/:id/search` answers with an
HTML 404, i.e. the flag is off and no indexes are built. Indexes are created only by the
operator CLI (`book-search-operator.mjs`); nothing enqueues them automatically today.

| Route | Query → response |
|---|---|
| `GET /v2/books/:id/search` | `q` (2–500 chars), `mode=lexical|semantic|hybrid` (default `hybrid`), `spoiler_mode=reader|full` (default `reader`, capped at the reader's max text offset), `limit` 1–20 (default 10) → `{ contract_version: "book-search-v1", book_edition_id, query, requested_mode, effective_mode, spoiler_mode, max_text_offset, index: { state, embedding_model, embedding_dimensions }, results: [{ chunk_id, chapter_key, score, matched_by, start_text_offset, end_text_offset, snippet }] }`. A missing index yields `409 SEARCH_NOT_READY` from the service. |
| `GET /v2/books/:id/graph` | `spoiler_mode` → `book-narrative-graph-v1` nodes / edges / story arcs |
| `GET /v2/books/:id/graph/search` | search params + `max_hops` 1–2 → `book-graph-search-v1` (content results + graph neighbourhood + evidence) |

Client: `src/lib/ai/narra-book-search.ts` exposes the server search as the assistant's
`ragSearch` tool and silently falls back to the local index / book file on 404, 409 and most
errors. Character chat does not use it yet.

## AI chat

Both routes are proxies to the LLM router (`requestChat`); the gateway owns provider, model
and sampling. Body (`contracts.mjs:93-205`):

```jsonc
{
  "messages": [{ "role": "system|user|assistant|tool", "content": "...", "name?": "...",
                 "tool_calls?": [...], "tool_call_id?": "..." }],   // 1–64
  "purpose": "assistant|character_chat|structured_task|summary|scenario|memory",
  "temperature?": 0.7,            // accepted, provider may ignore
  "request_id?": "<uuid>",
  "origin?": "user|background",   // default user
  "analytics_tier?": "essential|none",  // user ⇒ essential, background ⇒ none (enforced)
  "tools?": [...], "tool_choice?": "auto|none|required|{...}", "parallel_tool_calls?": true
}
```

No other field is accepted (`book_edition_id`, character keys, progress → `400 VALIDATION`).
Default purpose: `character_chat` for stream, `structured_task` for complete.

| Route | Response |
|---|---|
| `POST /v2/ai/chat/stream` | `text/event-stream` in OpenAI chat-completions chunk format, headers `X-Request-Id`, `X-Narra-Route`. Mid-stream failures are emitted as `event: error` / `data: {"error":{"code":"PARSE|CENSOR|CANCELLED|TIMEOUT|NETWORK"}}`. Used by the Narra assistant (`src/lib/ai/narra-assistant-gateway.ts`, purpose `assistant`, LangChain tools). |
| `POST /v2/ai/chat/complete` | `{ text, request_id, route, usage, attempts }` (`text` = first choice content). Used by character chat / greeting / memory (`src/lib/ai/narra-chat.ts`, purpose `character_chat`, `memory`), summaries (`src/lib/narra/summary.ts`, `summary`), scene audio scripts and other structured tasks (`structured_task`). |

Per-purpose provider routes are visible in `GET /health` → `llm_routes` (staging: `assistant`
and `structured_task` via LiteLLM only; `character_chat`, `summary`, `scenario`, `memory` try
GigaChat first, then LiteLLM). Responses cut by `max_tokens` are logged on the gateway
(`finish_reason=length`) but currently returned as normal text.

## Speech

| Route | Body → response |
|---|---|
| `POST /v2/speech/synthesize` | exactly one of `text` (≤ 12 000) or `ssml` (≤ 24 000) plus `voice` (default `Che`; must exist in `voices.mjs`) → binary `audio/wav` with header `X-Audio-Sample-Rate`. `429 RATE` + `Retry-After` when SaluteSpeech throttles, `502 NETWORK` when unavailable. Client: `synthesizeNarraBookSpeech` / `synthesizeNarraSpeech` in `src/lib/narra/media.ts` (SSML `<prosody rate pitch>` is supported). |
| `POST /v2/speech/recognize` | raw audio (`X-Audio-Type` header, default PCM16 16 kHz) → `{ text }`. Not used by the app. |

There is no `GET /v2/speech` voice registry. The allowed codes live in
`services/narra-gateway/voices.mjs`: assistants `Che` (f), `She` (m), `Erm` (f); 48 kHz
library `Ast`, `Gal`, `Bez`, `Ego`, `Izv` (m), `Ste`, `Tso`, `Chr` (f); a larger 24 kHz
library; child voices (`Ksa`, `Saf`, `Bsa`, `Kkr`, `Ktr`, `Kbu`, `Koz`); manual-only `Mar`,
`Kas` and 32 more (`Kov`, `Shi`, …). The client table `src/lib/narra/voice-rules.ts` must stay
a subset of that map — `Efo` (Фокин) is **not** registered on the gateway, which is why it
answers `400 VALIDATION` ("voice: голос не поддерживается"), not a provider failure.

## Media (client-driven generation)

These are the manual paths; the in-text reader scenes use `/v2/books/:id/scenes/at` above.

| Route | Body → response | Client |
|---|---|---|
| `POST /v2/media/images` | `{ prompt ≤ 4000, width?, height? (256–2048, default 768×1024), engine?: "kandinsky"|"openrouter" }` → `{ image: <base64>, mime_type? }`. `openrouter` = gpt-image chain with Nano Banana fallback (Kandinsky is not part of that path); otherwise vertical images (`height > width`, covers) and explicit `engine: "kandinsky"` (scenes) go to Kandinsky, square/landscape without engine go to GigaChat image, with mutual fallback. | `media.ts` (portraits, manual scene, safety fallback), `scene-image-openrouter.ts` |
| `POST /v2/media/cover/jobs` | `{ request_id: uuidv4, book: { title, author?, description?, excerpt?, subjects? } }` or legacy `{ request_id, prompt }` → durable job | `cover-jobs.ts` |
| `GET /v2/media/cover/jobs/:jobId` | job status; completed → `{ image, mime_type }` | `cover-jobs.ts` |
| `POST /v2/media/cover/jobs/:jobId/ack` | acknowledge download | `cover-jobs.ts` |
| `POST /v2/media/cover` | Compatibility route `{ prompt ≤ 8000 }` → `{ image, mime_type }` | legacy (`narra-gateway-fetch.ts` keeps a 180 s timeout for it) |
| `POST /v2/media/scene/jobs`, `GET …/:jobId`, `POST …/:jobId/ack` | Durable manual scene job from structured book facts (not the in-text inset loop) | not called on `main` |
| `POST /v2/media/avatar` | `{ image, audio, query? }` base64 → long job `{ video }`; requires Kandinsky + video backend (`services.video: false` on staging) | not called |
| `POST /v2/media/portrait-animation` | `{ image, query?, quality: "lite"|"hd" }` → `{ video, provider }` idle animation | not called on `main` (idle animations arrive as manifest assets) |

There is **no** `/v2/media/videos` route (404) — the ledger's "оживление" request is still open.

## Events and import

| Route | Notes |
|---|---|
| `POST /v2/events/batch` | `{ events: [1..100] }` → `202 { accepted, rejected: [{ event_id }] }`. Client: `src/lib/analytics/telemetry.ts`, gated by `EXPO_PUBLIC_NARRA_ANALYTICS_TIER`. |
| `GET /v2/import/fetch?url=` | Server-side download for whitelisted https hosts (AO3 etc.), ≤ 30 MiB, streams the body with the upstream `Content-Type`. |

## Operator / internal routes (never called by the app)

`GET /v2/admin/metrics`, `GET /v2/admin/installations/:id`,
`POST /v2/admin/installations/:id/revoke` (operator token); `/v2/admin/catalog/*` (catalog
ingest token); `/operator/*` (basic auth dashboard); `/internal/v1/*` (generation service
token, used by workers for scenes/portraits/analysis). `GET /ready` reports readiness of LLM,
speech, book backend and registry storage.

## Live staging facts (api-test, 2026-09-01, gateway build `ebd6773d`)

- `/health`: `environment: "staging"`, `book_markup`/`book_storage`/`internal_generation`
  true, `video` false, `book_backend_required` true.
- `GET /v2/books/catalog` → 50 items on the first page, all `language: "ru"`; `genres` is
  filled for part of the catalog only.
- Manifests of the top catalog books are `availability: "ready"`, `source: "v3"`, with 20
  characters each and complete `character-bundle-v3` bundles (portrait + greeting audio +
  idle animation); `tts_markup.status: "ready"`.
- Profile quality is uneven: e.g. Раскольников has `role: "Готовился стать юристом."`,
  empty `description`/`speechStyle`/`full_name`, and `traits` that are raw quotes — the
  client must tolerate empty fields.
- `POST /v2/books/:id/scenes/at`: slots 0 and 1 answer `ready` immediately; later slots go
  `queued` → `running` slowly (one worker, priority-35 backlog). Expect minutes, not seconds,
  for on-demand slots.
- `GET /v2/books/:id/search` → HTML 404 (`BOOK_SEARCH_ENABLED` off). Assistant grounding falls
  back to the local index.

## Rules for client changes

- Additive fields only, and only after the gateway accepts them; unknown keys are rejected.
- Treat `availability !== "ready"` as "no characters / no scenes yet", never as an app error;
  `unavailable` means v2-only markup (no automatic upgrade).
- Poll `scenes/at` at `poll_after_ms` (≥ 250 ms client floor) with an upper deadline; `4xx`
  responses and `MARKUP_FAILED` are terminal for the current attempt.
- A `401` with `X-Narra-Auth-Error: installation_token` invalidates the cached token; a
  refresh `404` re-registers the installation.
