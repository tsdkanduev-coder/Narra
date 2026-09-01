# Ledger — work order «Narra core loop и UI/UX»

Формат: фаза · дата · коммит · что сделано · проверки · открытые вопросы.

## Кампания 2026-08-31 — ветка `cursor/core-loop-uiux-3230` (от `main`)

Work order P1–P8 + обязательные backend P0 (реализация, не rewrite контракта).

### Bug ledger

| Pri | Issue | Status |
|---|---|---|
| P0 | `loadSceneContext` требовал только `book-markup-v3` + publication `shadow` → `POST /v2/books/:id/scenes/at` 404 на v2 publish | fixed `a19a07ce` |
| P0 | `ensureSceneSlot` переставлял failed `scene_image` только при priority ≥ 70; prefetch 45 оставлял слот мёртвым | fixed `a19a07ce` |
| P0 | `charactersDue` отсекался по v3; `enqueueBookMarkupBackfill` не брал failed `book_markup` (Война и мир зависала в marking_up) | fixed `a19a07ce` |
| P1 | На `main` ART_STYLE — semi-realistic anime, не канон work order | fixed `9daea76f` |
| P0 | Таббар Library / Chats / Search / Profile вместо Library / Reader / My path / Profile | fixed `3f3c192c` |
| P1 | «Читаю сейчас» и page-curl не подключены в LibraryScreen | fixed `f09783b5` |
| P1 | Канонический якорь сцены стирал inset на втором CFI той же sceneKey | fixed `c3443f80` |
| P2 | `sceneInsertAnchors` читал только `book.scenes`, не `scenesByBackendId` | fixed `daee4273` |
| P2 | Дефолт врезок 4 стр., в work order 8 | fixed `6cfb68a0` |
| P2 | Единая ☰-панель TOC/закладки/поиск не собрана; `useReaderSearch` не подключён | fixed `e5641fa2` |
| P2 | Android `ReaderToolbar` = `null`, TTS только в overflow | fixed `e86678d2` |
| P1 | `POST /v2/books/:id/scenes/at` 404/null, если в `book_analysis_runs` нет `normalized_text_*` | fixed `22162ae1` |
| P1 | `packages/app-expo/NARRA_GATEWAY.md` не перечислял scenes/at, progress, catalog, `/v2/speech/synthesize` | fixed `dbb9e7eb` |
| P0 | «Мой путь» скрывал locked и private; тап по locked — no-op | fixed `2054fe69` |
| P1 | gateway `scene-generation.mjs` без канона fanart (cinematic / empty genre) | fixed `e27322cc` |
| P0 | `generateBookScene` слал пустые genre/chapter | fixed `570ebc01` |
| P0 | Catalog ingest / marking_up оставлял v2-константу; «Война и мир» без analysis-run | fixed `b3aefcbc` |
| P0 | `POST /v2/ai/chat/complete` отвечал без `GET /:bookEditionId/search` | fixed `e0c24363` |
| P1 | `ChatScreen` слал Loop 6 через local RAG `useStreamingChat`; `SEARCH_NOT_READY` глотался и шёл ответ мимо книги | fixed `5d9ca406` |
| P1 | Пустой search (`snippets.length===0`) шёл в LLM без фрагментов | fixed `d0ef91ae` |
| P1 | ReaderScreen без edition рисовал сцену через OpenRouter | fixed `d0ef91ae` |
| P1 | Catalog analysis backfill не лечил dead-leased queued/running (Война и мир) | fixed `d0ef91ae` |
| P1 | `generateInternalPortrait` всё ещё gigachat-image | fixed `d0ef91ae` |
| P1 | `narra-gateway-fetch.ts` зашивал `api-test.narra.disrupt.builders` | documented `3d44fc1d` — канон README, host не выдумывали |
| P1 | sceneJobRunner и `/v2/media/images` слали сцены/обложки в gigachat-image | fixed `9665e023` |
| P2 | пустой поиск по книге с запросом писал «Введите слово…» | fixed `f9ce77ae` |
| P1 | `POST /v2/ai/chat/stream` без search-before-LLM (complete уже грунтовал) | fixed `7f88466e` |
| P1 | Prefetch / `ensureBookScenesThrough` 404/null без `normalized_text_*` | fixed `7f88466e` |
| P1 | `generateBookScene` слал `previousExcerpts=[]` при уже загруженном тексте | fixed `7f88466e` |

### Что починено (этот проход)

- `a19a07ce` backend P0-1/2/3 в `postgres-book-markup-repository.mjs` и `book-catalog-service.mjs`
- `9daea76f` client P1: канон `ART_STYLE` work order, бюджет 950, стиль не режется
- `3f3c192c` P3/P0 таббар: Библиотека / Читалка / Мой путь / Профиль; поиск в стеке Профиля
- `c3443f80` P1 scene anchors: биндинг и картинка на каждом тапнутом CFI той же sceneKey
- `daee4273` P2: `sceneInsertAnchors` читает и `scenesByBackendId`
- `caeb89c5` P1 refinement: тест persist/reload — тапнутый CFI не залипает на «Рисуем…»
- `f09783b5` P4: полка «Читаю сейчас» + прогресс + page-curl
- `6cfb68a0` P6: дефолт врезок 8 страниц
- `e86678d2` P7: TTS на нижней панели Android
- `e5641fa2` P8: ☰ содержание = TOC / закладки / поиск
- `22162ae1` leftover P1: scenes/at без колонок `normalized_text_*`
- `dbb9e7eb` docs: NARRA_GATEWAY.md = реальные маршруты
- `2054fe69` P0: «Мой путь» — locked grey+% и private
- `e27322cc` P0: fanart-хвост в gateway scene prompt
- `b3aefcbc` P0: catalog marking_up → book-analysis backfill; v2 только private
- `e0c24363` P0: chat/complete ищет книгу до LLM
- `570ebc01` P0: generateBookScene берёт жанр издания и главу
- `9665e023` P1: сцены/обложки через gpt-image-2, не GigaChat Image
- `3d44fc1d` P1: fallback Gateway снова канон README (`api-test`); выдуманный production откатили
- `f9ce77ae` поиск по книге: запрос без совпадений — «Ничего не найдено»
- `5d9ca406` P1: ChatScreen → `/v2/ai/chat/complete`; `SEARCH_NOT_READY` не отвечает мимо книги
- `d0ef91ae` P1: пустой search / сцена без edition / dead-leased analysis / портреты gpt-image-2
- `7f88466e` leftover P1: stream search-before-LLM, prefetch без `normalized_text_*`, `previousExcerpts` из текста

### Что всплыло после более поздней фазы

- После backend P0: `scenes/at` всё ещё 404 без `normalized_text_*` у analysis run — fixed `22162ae1`.
- После P4: NARRA_GATEWAY.md был 39 строк без scenes/at — fixed `dbb9e7eb`.
- После P4: «Мой путь» резал locked/private — fixed `2054fe69`.
- После P4: scene prompt на gateway без fanart-канона — fixed `e27322cc`.
- После P4: catalog marking_up без analysis-run (Война и мир) — fixed `b3aefcbc`.
- После P4: чат героя без поиска по книге — fixed `e0c24363`.
- После fanart-хвоста: generateBookScene всё ещё слал пустые genre/chapter — fixed `570ebc01`.
- После P1 leftover: sceneJobRunner / `/v2/media/images` шли в GigaChat — fixed `9665e023`.
- После specialist paper на `0e87cbdb`: выдуманный `api.narra` откатили на канон README — `3d44fc1d`.
- Поиск ☰ с запросом без хитов писал «Введите слово…» — fixed `f9ce77ae`.
- После P0 chat grounding: `ChatScreen` всё ещё звал `useStreamingChat` (core local RAG), а gateway глотал `SEARCH_NOT_READY` и отвечал мимо книги — fixed `5d9ca406`.
- Пустой search после grounding всё ещё пускал LLM без фрагментов — чиним в этом проходе.
- ReaderScreen без `bookEditionId` шёл в OpenRouter/`/v2/media/images`, мимо `scenes/at`.
- Catalog backfill пропускал queued/running с мёртвым lease — «Война и мир» зависала в marking_up.
- `generateInternalPortrait` оставался на gigachat-image; сцены не трогали.
- Paper PASS на `05961d9e` для P4–P8 + «Мой путь» — не пересобирали.
- Stream `/v2/ai/chat/stream` всё ещё без search-before-LLM — fixed `7f88466e`.
- Prefetch без `normalized_text_*` (on-demand `scenes/at` уже чинили) — fixed `7f88466e`.
- `generateBookScene` слал `previousExcerpts=[]` при уже загруженном тексте — fixed `7f88466e`.

### Что остаётся

- P2 `voice-rules.ts` уже есть (`e74f36af` на `main`): SoT + тесты. Этот проход файл не пересобирал.
- Устройство / симулятор не проверены. Живая «Война и мир» на postgres не гонялась.
- Desktop FoliateViewer без scene slots / character tap / `/scenes/at` — leftover.
- P5 matcher не переписывали: vitest 48/48. Wiring `setCharacterNames` на месте.
- Worker пишет `BOOK_MARKUP_ANALYSIS_VERSION='book-markup-v2'` только для private. Catalog — v3 analysis.
- Fallback Gateway и EAS — `api-test.narra.disrupt.builders` (канон `services/narra-gateway/README.md`). Другой production-хост не выдумывали.
- `generateInternalScene`, `/v2/media/images` и портреты (`generateInternalPortrait` → `generateInternalCharacterPortrait`) идут в gpt-image-2. Сцены не возвращали в GigaChat Image. HTTP не меняли.
- `generateBookScene` берёт жанр из `book_edition_genres` и главу из `content_navigation`; если главы нет — поле пустое, жанр тогда из названия.
- Чат с вкладки «Мой путь» может слать stale `book.progress` (из reader tap `publishCharacterProgress` ок).
- Документ `NARRA_GATEWAY.md` сверяет маршруты, формы запросов не переписывались. Речь: `POST /v2/speech/synthesize`.
- `scenes/at` не ставит отдельную v3-разметку в очередь — v3 идёт своим analysis-пайплайном.
- Пакетный `enqueueBookSceneBackfill` всё ещё выбирает только published `book-markup-v3`. On-demand `scenes/at` и prefetch этим фильтром не пользуются.
- Без `analysisRepository` catalog-scope по-прежнему не греет `charactersDue` (как было в коде; канон «только catalog» коду не соответствует).
- Postgres integration / e2e без `BOOK_MARKUP_TEST_DATABASE_URL` не гонялись.
- `character-analysis.ts` ещё ходит в `POST /v2/ai/chat/stream` без `book_edition_id` — поиск не запускается (как complete без edition). Loop 6 чат идёт в complete.
- Stream и complete теперь оба зовут `attachBookSearchContext` до LLM. HTTP-формы не меняли.

## P0 — backend reader path · 2026-08-31 · a19a07ce

- `loadSceneContext`: любая published-разметка; publication не только shadow; текст из любого analysis run книги.
- `ensureSceneSlot`: requeue failed `scene_image` при priority ≥ 45 (prefetch и scenes/at).
- `book-catalog-service`: `charactersDue` без отсечки v3.
- `enqueueBookMarkupBackfill`: кандидаты с failed `book_markup`; reset в `queued`.
- Проверки: `node --test` book-p0-reader-path + book-catalog-service — 30/30 (повтор 2026-08-31).
- Не проверено: postgres integration / e2e без `BOOK_MARKUP_TEST_DATABASE_URL`.
- Leftover: пакетный scene backfill только v3; worker пишет v2; `scenes/at` не enqueue v3-analysis.

## P0 — catalog analysis backfill · 2026-08-31 · b3aefcbc

- `enqueueBookMarkupBackfill` только `scope = 'private'`.
- `enqueueCatalogAnalysisBackfill`: catalog в `marking_up`/`failed` без queued/running/ready analysis → `ensureAnalysisRun`; failed-прогон → `restartAnalysisRun`.
- Старт gateway вызывает backfill. `BOOK_MARKUP_ANALYSIS_VERSION` остаётся `book-markup-v2`.
- Проверки: gateway `node --test` book-p0 + catalog-ingest + contracts + scene-generation + book-chat-grounding — 33/33 в том наборе; отдельно ingest 4/4.
- Не проверено: живой postgres «Война и мир».

## P0 — chat/complete grounded search · 2026-08-31 · e0c24363

- Опциональный `book_edition_id` (UUID) на `POST /v2/ai/chat/complete`.
- Gateway вызывает тот же поиск, что `GET /:bookEditionId/search`, до LLM.
- Клиент шлёт edition из backendBinding / library book. Memory-purpose без поиска.
- HTTP-форма остальных полей не менялась. Stream-чат не грунтуем.
- Позже: 409/`SEARCH_NOT_READY` больше не глотается — см. leftover P1 Loop 6.
- Проверки на тот коммит: book-chat-grounding 4/4, contracts (optional UUID), tsc app-expo 0.
- Не проверено: живой индекс и устройство.

## P0 — genre/chapter в generateBookScene · 2026-08-31 · 570ebc01

- `getBookSceneInput` читает `book_edition_genres` и сегмент `content_navigation`.
- `generateBookScene` передаёт их в `sceneGenerationPrompt`. Публичный HTTP не менялся.
- Проверки: book-p0 + scene-generation + chat-grounding + contracts — 31/31.
- Не проверено: живая генерация сцены «Война и мир».

## leftover P1 — stream grounding / prefetch text / previousExcerpts · 2026-09-01 · 7f88466e

- `POST /v2/ai/chat/stream` зовёт тот же `attachBookSearchContext`, что complete: search до LLM; `SEARCH_NOT_READY` / `SEMANTIC_SEARCH_NOT_READY` / `SEARCH_EMPTY` («Ничего не найдено») не пускают ответ мимо книги. HTTP-формы не меняли.
- Prefetch (`manifest` / `advanceProgress` → `warmupBookScenes`) извлекает `normalized_text_*` так же, как on-demand `scenes/at`, и передаёт ключи в `ensureBookScenesThrough`.
- `generateBookScene` берёт до 2 предыдущих отрывков из уже загруженного нормализованного текста (`previousSceneExcerptsFromText`). Слот 0 — пусто. Схему запроса не расширяли.
- Paper PASS на `05961d9e` для P4–P8 + «Мой путь» не трогали. Foliate / устройство — leftover.
- Проверки: gateway book-chat-grounding + p0 + catalog + book-scenes + internal-generation-service 88/88.
- Не проверено: устройство, Foliate, живая «Война и мир».

## leftover P1 — empty search / bound scene / dead-lease analysis / portraits · 2026-09-01 · d0ef91ae

- Пустой book search (`snippets.length===0`) бросает `SEARCH_EMPTY` / «Ничего не найдено» — LLM без фрагментов не вызывается.
- `ReaderScreen` без edition не зовёт OpenRouter; только `scenes/at` + `generateInternalScene` (gpt-image-2).
- `enqueueCatalogAnalysisBackfill` лечит queued/running без живого job (dead lease) — fail `LEASE_EXPIRED` + `restartAnalysisRun`.
- `generateInternalPortrait` = `generateInternalCharacterPortrait` (gpt-image-2). `/v2/media/images` уже на cover-chain. Сцены не в GigaChat.
- Host fallback без изменений: `api-test.narra.disrupt.builders`.
- Loop 6 / P0 landings сохранены. Stream без search — leftover, клиентский чат его не зовёт.
- Проверки: gateway book-chat-grounding + p0 + compose + analysis-repository 37/37 в этом наборе; vitest errors/chat-ui/reader-bound/narra-chat/haptics 14/14; tsc app-expo 0.
- Не проверено: устройство, Foliate, живая «Война и мир».

## leftover P1 — Loop 6 ChatScreen → gateway search-before-LLM · 2026-09-01 · 5d9ca406

- `ChatScreen` больше не зовёт `useStreamingChat` / local RAG. Loop 6 (чат с Narra) идёт в `POST /v2/ai/chat/complete` с `book_edition_id`.
- `attachBookSearchContext` больше не глотает 409/`SEARCH_NOT_READY`/`SEMANTIC_SEARCH_NOT_READY`/`NOT_FOUND`: без индекса чат падает, ответа мимо книги нет.
- UI показывает `SEARCH_NOT_READY` тостом. Повтор — та же кнопка.
- `previousExcerpts=[]` не трогали. `generateInternalScene` по-прежнему gpt-image-2, не GigaChat Image.
- Проверки: gateway book-chat-grounding 5/5; vitest errors + chat-ui + narra-chat 10/10; tsc app-expo 0; biome по изменённым файлам чисто.
- Не проверено: устройство / живой индекс «Война и мир». Stream grounding — см. `7f88466e`.

## leftover P1 — host/README + gpt-image-2 + поиск · 2026-09-01 · 3d44fc1d, 9665e023, f9ce77ae

- `narra-gateway-fetch.ts`: fallback = канон README `api-test`. Env перекрывает. `api.narra` не канон — откатили.
- sceneJobRunner и `POST /v2/media/images` для сцен/обложек — gpt-image-2 (`generateInternalScene`). HTTP не меняли.
- `voice-rules.ts` + тесты уже в репо (`e74f36af`) — второй файл не добавляли.
- ☰-поиск: пустой запрос — подсказка; запрос без хитов — «Ничего не найдено».
- Проверки: vitest fetch + contents + voice-rules 42/42.
- Не проверено: устройство, живая «Война и мир», десктопный Foliate.

## leftover P1 — scenes/at без normalized_text_* · 2026-08-31 · 22162ae1

- `loadSceneContext` больше не возвращает null только из-за пустых `normalized_text_*`.
- `sceneAt` берёт уже подготовленный текст или извлекает его из файла книги (`analysis/ondemand/...`), пишет ключи в job и заполняет пустой analysis run, если он есть.
- Prefetch без этих колонок чинится в `7f88466e` (`warmupBookScenes`). Пакетный backfill по-прежнему без on-demand текста.
- Проверки: gateway `node --test` book-p0-reader-path + book-catalog-service — 33/33.
- Не проверено: живой `scenes/at` на postgres/S3; устройство.

## P8 — ☰ содержание TOC/закладки/поиск · 2026-08-31 · e5641fa2

- `ReaderContentsPanel`: вкладки Оглавление / Закладки / Поиск. Темы остаются на Aa.
- `useReaderSearch` подключён к мосту WebView.
- Проверки: contents-panel contract + tsc 0. Устройство не проверено.

## P7 — Android TTS на панели ридера · 2026-08-31 · e86678d2

- JS `ReaderToolbar`: Слушать / Персонажи. iOS native toolbar не менялся.
- Проверки: toolbar contract 4/4, tsc 0.

## P6 — дефолт врезок 8 · 2026-08-31 · 6cfb68a0

- `DEFAULT_SCENE_SUGGESTION_INTERVAL = 8`. Matcher не пересобирался.
- Сохранённый выбор 3/4/выкл остаётся. Проверки: scene-suggestion 23/23.

## P4 — «Читаю сейчас» · 2026-08-31 · f09783b5

- `ReadingNowShelf` в «Мои книги»: полоска + %, page-curl из токенов deslop.
- Скрывается при теге/группе/выделении. Проверки: reading-now-books 1/1, tsc 0.

## P2 — restore врезок из scenesByBackendId · 2026-08-31 · daee4273

- `sceneInsertAnchors` принимает `scenesByBackendId`; ReaderScreen передаёт его вместе с bindings.
- Не трогали: desktop FoliateViewer, интервал 4 vs 8, matcher имён, iOS TTS.
- Проверки: vitest scene-inserts + backend-scene-* 19/19, tsc 0.

## P1 — якоря сцен на каждом CFI · 2026-08-31 · c3443f80

- `withBackendSceneIntent` больше не стирает `sceneAnchorBindings` у неканонического CFI той же `sceneKey`.
- `generateBackendReaderScene` не снимает живой слот; `display`/`replaceSceneSlot` на тапнутый CFI и на канонический, если он в DOM.
- Refinement: биндинг `sceneAnchorBindings[input.anchor] = id` сохраняется после persist/reload — слот не залипает на «Рисуем…».
- Проверки: vitest backend-scene-reader + backend-scene-state + scene-inserts + tab-navigator 20/20.
- Не проверено: живой reader (два слота одной сцены на устройстве).
- Не трогали: desktop FoliateViewer, интервал врезок 4 vs 8, Android ReaderToolbar.

## P3 — таббар 4 таба · 2026-08-31 · 3f3c192c

- `TabNavigator`: Библиотека · Читалка · Мой путь · Профиль, подписи включены.
- `ReadingTabScreen` подключён как таб 2 (последняя книга через `openMobileBook` → root Reader `fullScreenModal`).
- Бывший таб Чаты оставлен маршрутом `Chats`, подпись `tabs.myPath` («Мой путь»). `MyPathScreen` не создавался.
- Поиск убран из таббара (`tabBarSystemItem` снят) и переехал в стек Профиля (`ProfileSearch` + пункт меню).
- Проверки: vitest tab-navigator-contract 1/1, tsc app-expo 0.
- Не проверено: симулятор / устройство (холодный старт Читалки ≤ 2 c).
- Не трогали: Reader `fullScreenModal`, matcher имён, scene slots, iOS TTS, card chat CTA. Android `ReaderToolbar` по-прежнему `null` (P2).

## P1 — fanart-стиль генераций · 2026-08-31 · 9daea76f

- `ART_STYLE` возвращён к канону work order (книжная иллюстрация, не anime).
- `budgetPrompt` по-прежнему не режет стиль; юнит: портрет/сцена/обложка ≤ 950 со стилем целиком.
- `buildFanartPortraitPrompt` / `buildFanartCoverPrompt` — канонические промпты 950.
- GPT Image-портреты и каталожные обложки сохранены; хвост стиля у портрета — канон.
- Проверки: vitest 92/92 (art-style, media, cover, voice-rules, portrait-migration), tsc app-expo 0.
- Не проверено: живая генерация через gateway.

## P1 — fanart-стиль генераций · 2026-08-05 · f7591e76

- Новый `src/lib/narra/art-style.ts`: канон `ART_STYLE` из narra (фанарт, книжная
  иллюстрация, без текста), `budgetPrompt()` с лимитом 950 знаков — стиль всегда
  целиком в конце, режутся длинные части (паспорта, отрывки) по границе слова.
- `media.ts`: портрет по канону narra (анфас, светлый фон, «Внешность (соблюдать
  точно)»); сцена — только упомянутые герои, одежда из сцены важнее паспортной,
  широкая композиция не коллаж; safety-фолбэк тоже в бюджете.
- `generate-book-cover.ts`: убрана «восточноевропейская живопись», обложка в общем
  каноне серии.
- Проверки: vitest 62/62, tsc 0 ошибок, biome чисто по изменённым файлам.
  Длины промптов на примере: портрет 595, сцена 944, обложка 938 знаков.
- Не проверено: живая генерация через gateway (нужен запуск приложения).

## P2 — правила голосов озвучки · 2026-08-05 · e74f36af

- Новый `src/lib/narra/voice-rules.ts`: таблица голосов, `assignVoices()`,
  `detectFirstPerson()`, `narratorVoiceFor()`. Правила: нарратор и главгерой —
  ассистентские (Афина `Che` / Сбер `She` / Джой `Erm`), пол нарратора — настройка
  `narratorVoicePreference` в narra-store (дефолт женский); при 1-м лице главгерой
  говорит голосом нарратора, следующему по значимости — второй ассистентский;
  актёрский пул по приоритету со строгим полом; при исчерпании — повтор голоса с
  просодией; эпизодники — нарратором; кэш назначений по книге.
- Маппинг реестра `/v2/speech` (источник — staging probe в narra):
  Стерлинг `Ast`, Галустьян `Gal`, Стремпаржевская `Ste`, Цокаева `Tso`,
  Безлепкин `Bez`, Егоров `Ego`, Чернышова `Chr`, Изволов `Izv`, Сафронова `Saf`
  (приоритет детским книгам), Ковалев `Kov`. Пасхалки Марков `Mar`, Пират `Kas` —
  `autoAssign: false`, только вручную.
- TODO: Фокин `Efo` — код подтверждён, но синтез отдаёт 400/502 на staging;
  выключен из автоназначения до починки gateway. Старый нарраторский `Shi`
  в реестре не подтверждён — удалён (включая литерал в edge-плеере).
- Проверки: vitest 62/62 (12 новых юнитов voice-rules), tsc 0, biome чисто.
- Вне слайса: ручное переопределение голоса в карточке героя — UI, уйдёт в P5/P8.

## P3 — таббар 4 таба · 2026-08-05 · ed5419e9

- `TabNavigator.tsx`: Библиотека · Читалка · Мой путь · Профиль; таб «Заметки»
  убран, экран переехал в стек Профиля (`ProfileNotes`, пункт меню с иконкой).
- Новый `ReadingTabScreen.tsx`: открывает книгу с максимальным `lastOpenedAt`
  через канонический `openMobileBook()`; позиция — сохранённый `currentCfi`
  ридера. После возврата из ридера — карточка «читаю сейчас» (обложка,
  прогресс-бар с %, «Продолжить чтение»); повторный тап по табу снова открывает
  книгу. Пустая библиотека — заглушка с CTA.
- Новый `MyPathScreen.tsx`: сетка персонажей всех книг (narra-store + bundled
  фолбэк), запертые приглушены с подписью «откроется на N%», тап — переход в
  чат (bundled-персонажи предварительно кладутся в стор).
- Локализация: ключи ru/en, остальные локали — en-фолбэк.
- Проверки: tsc 0, biome чисто, vitest зелёный; grep — внешних навигаций на
  убранный таб не было.
- TODO: поиск по книгам в Профиле — готового поиска библиотеки в мобильном
  приложении нет, оставлен TODO в `ProfileScreen.tsx`; проверка глазами в
  симуляторе — перед демо.

## P4 — библиотека с прогрессом · 2026-08-05 · e2ba6248

- Новый `components/library/ReadingNowShelf.tsx`: секция «Читаю сейчас» —
  горизонтальный ряд читаемых книг (progress > 0 и < 1, сортировка по
  `lastOpenedAt`), обложка 28:41 с эффектом скрученного уголка (повёрнутый
  градиент + тень, без новых зависимостей), полоска прогресса и процент.
  Тап — канонический `openMobileBook()`.
- `LibraryScreen.tsx`: секция как `ListHeaderComponent`, скрывается при фильтре
  по тегу/группе и в режиме выделения.
- `BookCard.tsx` + `book-card-styles.ts`: прогресс-бар с процентом под автором
  (при progress > 0), accessibilityLabel «Прочитано N%».
- Прогресс — существующее поле `book.progress` (доля 0–1) из library-store,
  новых полей нет.
- Локализация в `library.json` (не common.json): namespace `library.*` спредится
  после common и затёр бы ключи; en-файл для паритета (в i18n-индексе фактически
  подключена только ru).
- Проверки: tsc 0, vitest 62/62, biome чисто.
- Не проверено: визуальный вид (уголок, тёмная тема) — глазами в симуляторе
  перед демо.

## P5 — кликабельные имена персонажей · 2026-08-05 · 17b03eb5

- Новый `src/lib/narra/character-name-matcher.ts` — один модуль на обе стороны:
  RN строит спеку открытых героев, `findCharacterNameMatches` бандлится esbuild
  в reader.html. Матчинг русских словоформ: основа (срез финального гласного) +
  допустимое окончание, строго по границам слов, слово с заглавной. Защиты:
  основы < 4 букв — только точная форма; стоп-лист титулов и омонимов («Вера»,
  «Князь»); общая основа двух героев (Малфои, Каренины) одиночно не матчится —
  только однозначная полная фраза; соседние слова героя склеиваются в один матч.
- WebView ↔ RN: команда `setCharacterNames` (при готовности и смене состава
  открытых героев), событие `characterTap`. Разметка ленивая — по `load` каждой
  секции foliate, порциями по 24 блока; подсветка тонким пунктиром без смены
  цвета текста. Запертые герои в спеку не попадают (без спойлеров).
- Новый `screens/reader/ReaderCharacterCard.tsx` — bottom-sheet: портрет
  (штатная генерация по требованию), имя, роль, черты-чипсы, «Перейти в чат»
  (bundled-персонажи предварительно кладутся в narra-store).
- Проверки: build:reader успешно, tsc 0, vitest 78/78 (16 новых юнитов матчера),
  biome — новых диагностик ноль.
- Ограничения: «оживления» (видео) в кодовой базе нет — кнопка не добавлялась;
  span-обёртки могут сдвигать CFI старых закладок на страницах с именами (тот же
  компромисс, что у ruby-инъекции); проверка глазами в симуляторе — перед демо.

## P6 — врезки «нарисовать сцену» · 2026-08-05 · 191d0fee

- Новый `src/lib/narra/scene-suggestion.ts` — чистая логика счётчика:
  `advanceSceneSuggestion()`, интервалы 5/8/15/выкл (дефолт 8). Счёт только по
  событиям relocate из foliate (без собственной пагинации): страница назад не
  считается, прыжки по оглавлению/поиску/закладкам и программная навигация
  сбрасывают счётчик; в scroll-режиме фолбэк по приросту fraction ≤ 0.08.
- `ReaderScreen.tsx`: плашка-пилюля внизу (тап → сцена, X → скрыть до
  следующего интервала), сброс при смене книги.
- Текст сцены — существующий `handleGenerateVisibleScene` (видимый текст из
  WebView), промпт строго через `buildSceneImagePrompt` (fanart-канон P1,
  паспорта героев, бюджет 950); генерация только по явному тапу.
- `NarraSceneScreen.tsx`: кнопки «Нарисовать заново» (тот же контекст) и
  «Вернуться к чтению». Настройка частоты — в `ReaderSettingsPanel`, значение
  персистится в narra-store (`sceneSuggestionInterval`).
- Проверки: tsc 0, vitest 93/93 (15 новых юнитов счётчика), biome — новых
  диагностик ноль; build:reader не требовался (webview-часть не менялась).
- Ограничения: интервал в scroll-режиме приблизительный; живая генерация через
  gateway не запускалась; вид плашки — глазами перед демо.

## P7 — озвучка из читалки по ролям · 2026-08-05 · 8b8686be

- Новый `src/lib/narra/voice-markup.ts`: сегменты озвучки делятся на реплики
  (тире-диалоги, «ёлочки») и нарратив; атрибуция реплик — глагол речи рядом с
  именем в авторской ремарке (в сегменте или в соседнем), затем ближайшее имя
  в предыдущем нарративе (матчер имён P5); безымянные — нарратором. Активный
  план «текст сегмента → голос» читается edge-плеером при синтезе чанков.
- `useReaderTTS`: play/append обёрнуты — план пересобирается синхронно перед
  каждым запуском очереди; персонажи приходят из ReaderScreen (store/bundled).
- Просодия: `synthesizeNarraSpeech` собирает SSML `<prosody rate pitch>`
  (как в narra; gateway принимает `{ssml, voice}`), скорость пользователя ×
  просодия персонажа, pitch в полутонах → проценты. Контракт gateway не менялся.
- `TTSPage`: мини-панель — пресеты скорости 0.75/1/1.25/1.5× и «Стоп»
  (play/пауза — в нативном плеере); смена скорости перезапускает синтез с
  текущей фразы (существующий respeak).
- Ручной выбор голоса (правило 3): `voiceOverride` в types/voice-rules
  (аддитивно, приоритет над авто, слоты не расходует, пасхалки доступны),
  переживает повторный анализ (domain.ts); пикер в ReaderCharacterCard
  (полный список без сломанного Фокина); учитывается в scene-audio и чате.
- Кнопка озвучки и «Озвучить» в меню выделения уже были (тулбар/menuItems);
  подсветка текущей фразы — существующий setTTSHighlight + автоцентр лирики.
- Проверки: tsc 0 (app-expo и core), vitest 112/112 (19 новых юнитов:
  разметка/атрибуция, SSML, override), biome — новых диагностик ноль;
  build:reader не требовался (webview не менялся).
- Ограничения: голос един на весь сегмент-предложение (реплика с ремаркой не
  дробится); одинаковые короткие реплики разных героев в одной очереди получают
  один голос (ключ плана — текст); смена override во время игры применяется со
  следующего запуска; живой синтез через gateway не запускался.

## P8 — единая панель читалки (Apple Books) · 2026-08-05 · 87412535

- `ReaderTOCPanel` → bottom-sheet с вкладками Оглавление · Закладки · Поиск
  (образец — ReaderNav из narra). Aa-оформление — отдельная панель, как в
  Apple Books; пункт «Оформление» добавлен в меню (вход в Aa-панель раньше
  отсутствовал вовсе — setShowSettings нигде не вызывался).
- Закладки: механизм уже был (annotation-store + useReaderBookmark) — добавлена
  кнопка «Добавить/убрать закладку на эту страницу» вверху вкладки.
- Поиск: вместо оверлея «1/N» — вкладка со списком совпадений с контекстом
  (до 100), тап — переход; webview не автопрыгает к первому результату.
- Темы страницы: Оригинал / Сепия / Тёмная — плитки в Aa-панели, новый
  `src/lib/reader/reader-themes.ts`, поле `readerTheme` в ReadSettings
  (аддитивно), цвета применяются внутри WebView через setThemeColors.
- Проверки: tsc 0, vitest 116/116 (4 новых юнита тем), build:reader успешно,
  biome — новых диагностик ноль (даже −9 к HEAD).
- Ограничения: результаты поиска без названия главы; лимит 100 совпадений;
  вид панелей глазами — перед демо.

## P9 — ударения в озвучке · 2026-08-05 · e758d7a9

- Конвенция SaluteSpeech: апостроф ПОСЛЕ ударной гласной (за'мок/замо'к),
  зафиксирована в шапках модулей со ссылкой на доку.
- Новые `stress-dictionary.ts` (~4.5 КБ: 68 имён каталога с падежными формами
  + 52 частотных слова; омографы исключены, есть тест-страж) и
  `stress-markup.ts` (applyStressMarkup: регистр, границы слов, текстовые узлы
  SSML; stressedNameForms: ударение в основе → падежные формы, ударение в
  окончании/короткая основа → только точная форма).
- Имена героев любой книги: опциональное `stressedName` из LLM-анализа глав
  (валидация parseStressedForm против галлюцинаций), переживает повторный
  анализ. Единая точка применения — `synthesizeNarraSpeech` (книга, сцены, чат).
- Проверки: tsc 0, vitest 139/139 (27 новых), biome чисто. Контракт gateway
  не менялся.
- Ограничения: живой синтез не запускался — проверить на staging один {ssml}
  с ударением (декодирование &apos;); адъективные фамилии (Вронский)
  склоняются только в именительном (общее ограничение с матчером P5).

## P10 — «Персонажи» в меню читалки · 2026-08-05 · 926f75ee

- Пункт «Персонажи» (person.2) в меню действий читалки между Поиском и
  Оформлением → экран персонажей книги.
- `NarraCharactersScreen`: показывает всех — открытые сначала (порядок
  значимости из анализа) с портретом/ролью/чертами и переходом в чат;
  закрытые приглушены (0.45), «откроется на N%», без описания и черт
  (антиспойлер), не кликабельны. Пустое состояние с CTA «Найти героев»
  сохранено.
- Проверки: tsc 0, vitest зелёный, biome — новых диагностик ноль.
- TODO: заголовок экрана NarraCharacters в RootNavigator остался «Чат»
  (исторический) — переименовать при следующем проходе.

## Статус кампании

Фазы P1–P10 выполнены и закоммичены в feat/core-loop-uiux. Не выполнено
глазами: живые генерации/синтез через gateway и визуальная проверка в
симуляторе (на маке нет Xcode) — перед демо. Ветка готова к PR.

## P11 — импорт фанфиков с Фикбука · 2026-08-05 · d340b1ad

- Новый `src/lib/book/import-ficbook.ts`: ссылка на фанфик/главу → парсинг
  (заголовок, автор, аннотация, обложка, оглавление по живой разметке) →
  главы по очереди с паузой 400 мс (мобильный UA) → минимальный валидный
  EPUB (главы в spine/toc, аннотация в dc:description для анализа, обложка).
  27 юнитов на фикстурах, сеть замокана. Ошибки 403/429/404 — человеческие.
- Риск: Cloudflare блокирует не-браузерные TLS-отпечатки (curl/node — 403,
  браузер проходит); ожидание — системный стек iPhone пройдёт; если нет —
  добавить скачивание через gateway (изменение контракта, отдельная задача).

## P12 — Мой путь, Читалка-таб, скругления · 2026-08-05 · 2be6347b

- «Мой путь» по образцу narra: секции по книгам (название серифом + прогресс),
  открытые — строки с портретом и «N сообщ.», закрытые — «ещё не знакомы».
- Читалка-таб: всегда сразу текст, выход назад — в Библиотеку (карточка-
  прослойка удалена). Обложки каталога и сетки скруглены (radius.sm).

## Приёмка глазами в симуляторе · 2026-08-05 · d75acf4a, 9f2ce98c, 3aa380e8

- Поставлен Xcode + iOS-платформа, собран dev-клиент, приложение проверено
  вживую. По фидбеку владельца: карточка героя переделана в стиль narra,
  дубли «Читаю сейчас» убраны, врезки не скрываются, эпоха в портретах,
  канон стиля переведён на полуреалистичное аниме (semi-realistic anime,
  строго без букв), 17 обложек каталога перегенерированы через gateway.

## P13 — багфиксы перед PR · 2026-08-05 · 7893d5f0

- Портреты: «ровно один человек в кадре — {имя}» первым пунктом промпта.
- Тап по герою: единая цепочка тап → карточка → чат (раньше список вёл сразу
  в чат, а до гидрации стора — в заглушку «Персонаж недоступен»).
- Приветствия: шаблоны «Привет. Я {имя}» удалены; greeting из анализа или
  генерация первого сообщения в характере героя с сохранением в историю.

## P14 — врезки сцен внутри текста · 2026-08-05 · 1d55bdd4

- Как в десктопной narra: блок «✦ Показать сцену» в потоке текста → тап →
  «Рисуем сцену… 20–60 секунд» на месте → картинка в тексте с подписью
  «Сцена — сгенерировано ИИ» и «↻ Заново». Персист по CFI-якорю,
  восстановление при повторном открытии; прозрачно для TTS и имён.
  Плавающая плашка P6 удалена. Кнопка Aa в нативном тулбаре (Swift) и
  Android-хедере открывает настройки оформления.

## P15 — карточка героя в каноне narra · 2026-08-05 · 27e56240

- Ровно два шрифта (SB Serif имя / SB Sans остальное), чипсы с рамкой без
  заливки, кнопки «Поговорить» + «Послушать голос» (синтез фразы героя его
  голосом, стоп по тапу). ↻ только в карточке. Заглушка «в манере эпохи»
  выпилена; анализ просит живую манеру речи и главу первого появления —
  герои открываются по прогрессу; тизер «Появится в главе N…» +
  «Продолжить чтение».

## Открытые хвосты (для команды)

- «Оживление» героя: на гейтвее НЕТ видео-эндпоинта (проверено, 404) —
  задача бэкенду добавить /v2/media/videos (k5-i2v), клиент подключит кнопку.
- Голос Фокина `Efo`: 400/502 на гейтвее — вне автоназначения до починки.
- Фикбук: если реальный iPhone тоже получит 403 — качать через gateway.
- Поиск по библиотеке в Профиле — в приложении нет поискового механизма.
- Живые проверки на устройстве: синтез с ударениями, LLM-приветствия,
  реальные главы появления героев от анализа.
