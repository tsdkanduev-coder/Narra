# Narra character gateway

The character feature is isolated from the app's general Narra AI configuration. It has no
API key in the client. The unconfigured native fallback is the production Gateway
`https://api.narra.disrupt.builders`. Never bake `api-test.narra.disrupt.builders`.

Configure the Expo build with:

```sh
EXPO_PUBLIC_NARRA_GATEWAY_URL=https://api.narra.disrupt.builders
EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE=installation
```

For local UI review without waiting for the external gateway, enable development-only fixtures:

```sh
EXPO_PUBLIC_NARRA_USE_MOCKS=1
```

This flag is ignored by production bundles. It seeds character cards, locked states, memory, and a
short sample conversation when the user starts character analysis.

`EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE` is optional. With `installation`, the client uses the
installation registration/refresh flow and stores the generated installation secret in SecureStore.
Without it, requests are sent without an Authorization header, which is useful for a local gateway
or a host-provided adapter.

The live HTTP contract is owned by `services/narra-gateway` and documented in
[`services/narra-gateway/README.md`](../../services/narra-gateway/README.md). This file lists the
routes the mobile app actually calls. Do not treat it as a place to invent or rewrite request
shapes.

## Auth

- `POST /v2/installations/register`
- `POST /v2/installations/refresh`

## LLM

- `POST /v2/ai/chat/stream` — character analysis (SSE or `{ "text": "..." }`)
- `POST /v2/ai/chat/complete` — character chat and memory (`{ "text": "..." }`). Optional
  `book_edition_id` (UUID) makes the gateway retrieve `GET /v2/books/:bookEditionId/search`
  before the LLM. Existing clients may omit the field.

The Gateway owns model sampling. A legacy `temperature` field is still accepted for compatibility
and ignored.

## Speech

- `POST /v2/speech/synthesize` — role TTS (`{ ssml, voice }` or text). There is no `POST /v2/speech`.

## Manual media (legacy parallel jobs)

- `POST /v2/media/images` — client-initiated portraits / one-off images
- `POST /v2/media/cover` — compatibility cover route
- `POST /v2/media/cover/jobs`, `GET /v2/media/cover/jobs/:jobId`, `POST /v2/media/cover/jobs/:jobId/ack`
- `POST /v2/media/scene/jobs` — reader-selected excerpt scenes (not the in-text inset loop)

## Automatic reader scenes and progress

- `POST /v2/books/:bookEditionId/scenes/at` — in-text scene insets. Client sends only the reading
  position. Gateway owns the slot, prompt and image.
- `POST /v2/books/:bookEditionId/progress` — canonical reader progress and scene warmup frontier
- `GET /v2/books/:bookEditionId/manifest`
- `GET /v2/books/:bookEditionId/search` — book-grounded retrieval for chat
- `GET /v2/books/:bookEditionId/media/:assetId/download`
- `GET /v2/books/:bookEditionId/cover/download`
- `GET /v2/books/:bookEditionId/source/download`

## Catalog

- `GET /v2/books/catalog`
- `GET /v2/books/catalog/languages/:language` (`ru` | `en`)
- `GET /v2/books/genres`

`EXPO_PUBLIC_NARRA_GATEWAY_URL` overrides the production fallback. A host may also call
`setNarraGatewayAdapter`. Characters, memories, chat history and generated portrait and scene
file paths are persisted locally by the app store.
