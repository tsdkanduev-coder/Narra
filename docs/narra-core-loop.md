# Core Product Loop — Narra (состояние `main` / `narra/core-loop-polish`, 2026-09-01)

> Источник: 5 отчётов ридеров (navigation, reader, domain, gateway, pr51 — последний обрезан) + точечные проверки кода. Отчёты по инструментам/TTS отдельно не поступили. Факты со ссылками `file:line` проверены чтением кода; гипотезы помечены явно.

## Общая карта

```
Loop 0  Установка / auth        App.tsx bootstrap → installation token (/v2/installations/*)
Loop 1  Открытие книги          Library (Популярное | Мои книги) / Search → openMobileBook → Reader
Loop 2  Чтение                  ReaderScreen (WebView foliate-js) → relocate → progress → backend manifest
Loop 3  Персонажи               manifest.characters → unlock по progress → span в тексте → карточка
Loop 4  Сцены                   счётчик страниц → слот в тексте → POST scenes/at → polling → картинка
Loop 5  Голос                   TTS книги (/v2/speech/synthesize) | голос персонажа/сцены (Grok via OpenRouter)
Loop 6  Чат                     персонаж (/v2/ai/chat/complete) | Narra о книге (LangChain → /v2/ai/chat/stream + ragSearch)
Loop 7  Возврат                 вкладка Chats (по книгам) | % на BookCard | (шкала «Читаю сейчас» отсутствует)
```

Ключевые сторы: `library-store` (книги, progress, lastOpenedAt), `narra-store` (`readany-store/narra-interactive.json`: binding, manifest, characters, chats, memories, scenes, summaries), `settings-store`, `tts-store`, `reader-store` (почти не используется). Все сетевые вызовы — через `packages/app-expo/src/lib/ai/narra-gateway-fetch.ts`.

---

## Loop 0 — Установка, окружение, auth

**Экраны.** Нативный splash → статичная `AnimatedNarraFace` (`App.tsx:326-340`) → `Tabs`. Onboarding не показывается: `RootNavigator.tsx:122-126` ждёт только гидрацию settings и всегда рендерит `Tabs`; `OnboardingNavigator` нигде не импортируется, `settings-store.hasCompletedOnboarding` (`settings-store.ts:28,488,495`) только пишется.

**Bootstrap** (`App.tsx:143-283`): шрифты, платформенный сервис, sync adapter, `initDatabase`, i18n, тема, streaming fetch (перехват ассистентских запросов на gateway, `App.tsx:177-183`), audio mode, TrackPlayer. `void verifyNarraGatewayBackend()` (`App.tsx:186`) — GET `/health`, сравнение окружения по URL; при несовпадении только `console.error` + локальный журнал (`diagnostics.ts:54-63`), ничего не блокируется.

**Окружение.** `narra-gateway-fetch.ts:64-73`: `EXPO_PUBLIC_NARRA_ENVIRONMENT=production` → жёстко prod URL; иначе `EXPO_PUBLIC_NARRA_GATEWAY_URL` или api-test fallback (ветка CONFIG «не настроено» недостижима). Профили в `eas.json:14-99`. Переменной `EXPO_PUBLIC_OPENROUTER_API_KEY` и `EXPO_PUBLIC_NARRA_TTS_PROVIDER` нет ни в одном профиле (проверено).

**Auth.** Installation identity в SecureStore (`narra-gateway-fetch.ts:169-192`) → POST `/v2/installations/register|refresh` (`:317-382`), refresh 404 → register; 403/400 с точными русскими строками → одноразовый сброс identity; 401 с `x-narra-auth-error=installation_token` → очистка токена и один повтор (`:402-456`). Gateway: `index.mjs:1484,1540`, `security.mjs`, лимиты `index.mjs:1290-1380` (api 120/мин, ai 30/мин + 500/день, speech 60/мин + 1000/день).

**Success:** пользователь сразу в Library → «Популярное» (каталог с бэкенда).
**Failure:**
- boot error → экран ошибки `App.tsx:290-324`;
- регистрация упала (429/сеть) → каждый следующий вызов снова POST `/installations/*` без backoff (`narra-gateway-fetch.ts:393`);
- keychain пережил переустановку и сервер не знает identity, а строка сообщения изменилась → перманентный AUTH без восстановления (`:286`).

---

## Loop 1 — Обнаружение книги (каталог / импорт)

**Экраны.** `LibraryScreen` = один общий `ScrollView` + `NativeSegmentedPager` «Популярное» / «Мои книги» (`LibraryScreen.tsx:1152-1222`), последняя секция в kv `library_last_section` (`:306-327`), параметр `initialSection` (`:288-291`). Header: sync (если настроен) и «+» → «Найти по ссылке» / «Выбрать файл» (`:663-765`). `SearchScreen` (нативный search bar, полки → `CatalogCategory`, результаты → reader; `SearchScreen.tsx:127-211`).

**Сторы/вызовы.** Каталог: GET `/v2/books/catalog` (только `base_ready/published`, `migrations/021:23`). Открытие: `open-mobile-book.ts:113-227` (валидация файла, `MissingBookPrompt` для повторного импорта, `navigate('Reader',{bookId,cfi})`). Каталожная книга, которой нет локально → `navigate('Reader',{bookId:'',catalogBook})`, и уже `ReaderScreen.tsx:214-362` скачивает/импортирует её под лоадером (`backend-catalog-import.ts:119-136`: signed URL, 3 попытки, sha256, затем `setBackendBinding` с `resolution:'catalog'`). Локальный импорт: `use-book-import-actions.ts:100-134` → `library-store.importBooks` → toast → пейджер переключается на «Мои книги» (`LibraryScreen.tsx:293-303`), пользователь сам тапает карточку. Для локальных книг сразу стартует `startImportedBackendBook` (5 минут сессии, `backend-book-sync.ts:329-344`): sha256 → POST `/v2/books/resolve` → POST `/v2/books/local` → PUT `/v2/books/{id}/source` (весь файл в памяти JS, `:144`) → `ensureCanonicalAnalysis` на gateway (`book-catalog-service.mjs:607`).

**Success:** карточка → Reader; для каталожной книги — Reader сам показывает `ReaderLoadingChrome`, потом текст.
**Failure:**
- импорт каталожной книги упал → `goBack` + toast (`ReaderScreen.tsx:292-349`);
- файл пропал → `MissingBookPrompt` → document picker;
- каталожная книга с `sourceKind:'catalog'` без `bookEditionId` → `bindBook` бросает, UI видит `CONNECTION` (`backend-book-sync.ts:95-96, 264`);
- в каталоге не видны книги, чей analysis run упал: edition остаётся `marking_up`, перехода в `failed` для editions нет (`book-analysis-repository.mjs:1268-1287`, повторный запуск только через CLI).

---

## Loop 2 — Чтение

**Экран.** `ReaderScreen.tsx` (2641 строк, `fullScreenModal`, `gestureEnabled:false`): WebView с бандлом foliate-js (`assets/reader/reader.html`, сборка `scripts/build-reader.js`), локальный HTTP-сервер (`local-file-server.ts`, Lighttpd/TCP fallback, `reader-host-manager.ts:18-39`). Мост `use-reader-bridge.ts`.

**Поток.** `ready` → `openBook` с `lastLocation = lastCfiRef.current || book.currentCfi` (`ReaderScreen.tsx:1830-1900`) → каждый `relocate` (`reader.template.html:1876-1910`) → `onRelocate` (`ReaderScreen.tsx:1153-1330`): `setProgress`, throttled `updateBook` 5 с (`:666-683`), счётчики сессии, `advanceSceneSuggestion`, TTS-продолжение. На unmount — прямая запись в SQLite с retry (`:1800-1818`), минуя стор.

**Бэкенд-готовность.** `useBackendBook(book, isFocused, progress)` (`ReaderScreen.tsx:1010`) удерживает `BackendBookSession` (`backend-book-session.ts:100-147`): bind → POST `/v2/books/{id}/progress` (high-water, задержка 1.5 с) → GET `/manifest` → `applyBackendManifest` → загрузка медиа персонажей; polling 5 с пока `processing`, backoff 5·2ⁿ ≤ 60 с при ошибках. На gateway `service.manifest → v3Manifest` (`book-catalog-service.mjs:285-345`): без shadow-публикации → `processing` (202) / `failed|cancelled|unavailable` (200); v2-строки не отдаются никогда. Клиент: `availability` парсится в `backend-book-contract.ts:194`; для `unavailable` `status.error` не выставляется (`backend-book-sync.ts:250-258`, проверено) — только `NarraCharactersScreen.tsx:448` имеет отдельную ветку.

**Success:** текст открыт на сохранённом CFI, прогресс пишется, манифест `ready`, имена персонажей подсвечены, слоты сцен появляются каждые N страниц.
**Failure:**
- файл не найден → экран ошибки, «Назад» делает `navigation.reset({routes:[{name:'Tabs'}]})` (`ReaderScreen.tsx:2261`), теряя всё состояние вкладок;
- book не гидрирован на момент mount → `bookNotFound` залипает (`:1776`);
- iOS: смерть процесса WebView → один авто-retry (`:2385`); Android: `onRenderProcessGone` не подключён → пустой WebView без retry;
- открыт любой sheet (TOC, персонажи, сцена, summary, заметки) → `useBackendBook` отпускает сессию, `useBackendBookStatus.books[bookId]` удаляется (`backend-book-sync.ts:286-296`) → `backendSceneEnabled=false` → кнопки на слотах пропадают до повторного fetch манифеста (`ReaderScreen.tsx:694-697`, `reader.template.html:2901,5918-5920`);
- закладка = точное совпадение CFI (`useReaderBookmark.ts:37-41`): после смены шрифта страница «не в закладках»;
- поиск по книге: WebView умеет, но `useReaderSearch`/`onSearchComplete` не подключены (`useReaderSearch.ts:37`), в UI нет входа;
- нижний тулбар (Слушать/Персонажи) только iOS (`ReaderToolbar.tsx:1-9`, `ReaderScreen.tsx:2184`).

---

## Loop 3 — Персонажи

**Данные.** `manifest.characters` → `backendConfirmedCharacters(manifest, progress)` (`backend-book-contract.ts:262-321`): `unlockProgress = firstAppearance/textLength` (или `unlockFraction`, cap 0.95); personality-snapshot применяется только после прочтения `cutoffTextOffset`. Разблокировка чисто клиентская: `isCharacterUnlocked(progress, character)` (`domain.ts:23-32`). Медиа персонажа: `backend-character-media.ts` (2 воркера, ошибки глотаются), скачивание через GET `/v2/books/{id}/media/{assetId}/download`, где gateway повторно проверяет, дошёл ли читатель (`book-catalog-service.mjs:818`).

**Имена в тексте.** `characterNameSpecJson` из unlocked backendManaged персонажей (`ReaderScreen.tsx:704-716`, `character-name-matcher.ts:225-252`) → `bridge.setCharacterNames` (`:1487-1491`) → WebView оборачивает совпадения в `span[data-readany-character-id]` чанками по 24 блока (`reader.template.html:5536-5595`). Тап → `characterTap` (`:2876-2888`) → `onCharacterTap` (`ReaderScreen.tsx:1357-1367`): повторная проверка unlock, `publishCharacterProgress()` (немедленный `updateBook`), `navigate('NarraCharacterProfile')` (formSheet, `RootNavigator.tsx:284-299`).

**Карточка.** `NarraCharacterProfileScreen` → встроенный `ReaderCharacterCard` (голосовой сэмпл через `NarraAudioPlayer`, независимо от TrackPlayer); «Поговорить» → `navigation.replace('NarraCharacterChat')` или `goBack` при `openedFromChat` (`NarraCharacterProfileScreen.tsx:46-52`); «Продолжить читать» → `goBack` + `openMobileBook` (`:54-57`). Список персонажей из ридера: `NarraCharacters` (iOS — sheet, в который встраивается чат вместо навигации, `NarraCharactersScreen.tsx:60,244-292,352-388`; Android — навигация). Заблокированные персонажи в `NarraCharactersScreen` показываются, в Chats — нет (`chat-list-model.ts:81`).

**Success:** имя подсвечено → карточка с портретом/приветствием → чат.
**Failure:**
- v2-only каталожная книга → манифест `unavailable`, `characters: []`, никаких подсветок, у ридера нет error-state (см. Loop 2);
- после `unmark` без `normalize()` многословные имена могут не подсвечиваться до перезагрузки секции (`reader.template.html:5580`);
- прогресс в `library-store` отстаёт до 5 с/до перезапуска, если ридер закрыт быстро (`ReaderScreen.tsx:1807` пишет напрямую в БД) → персонаж «ещё закрыт» из библиотеки/Chats;
- `character_media_bundles` могут навсегда остаться `running`/«preparing» из-за бесконечного перезахвата jobs (`postgres-book-markup-repository.mjs:2314`).

---

## Loop 4 — Сцены

**Вставка слота.** `advanceSceneSuggestion` (`scene-suggestion.ts`: первый через 2 перелистывания, затем каждые `DEFAULT_SCENE_SUGGESTION_INTERVAL=4`, `:12`) → `bridge.insertSceneSlot()` (`ReaderScreen.tsx:1269-1283`) без проверки `backendSceneEnabled`. WebView выбирает последний видимый блок, считает CFI с `sceneCfiFilter` (вставки REJECT, span-ы имён SKIP), вставляет квадратный слот (`reader.template.html:6179-6231`).

**Генерация.** Тап → `sceneSlotTap` → `runSceneSlotGeneration` (`ReaderScreen.tsx:742-822`): gate `isBackendSceneReady(edition, availability)` = `Boolean(edition) && availability==='ready'` (`backend-scene.ts:32-37`), иначе `retryBackendBookSync` + toast MARKUP_PROCESSING/MARKUP_FAILED; intent (`sceneRequests[page:anchor]` или свежий) → `generateBackendReaderScene` (`backend-scene-reader.ts:38-162`): `setSceneRequest` → POST `/v2/books/{edition}/scenes/at {progress_fraction}` → polling `resolveBackendScene` (≥250 мс, дедлайн 5 мин, terminal на 4xx / `SCENE_SLOT_CHANGED`) → скачивание signed URL в `narra-media/backend-scene-<sha256>` (60 с) → `setBackendScene` (`scenesByBackendId` + `sceneAnchorBindings`) → `replaceSceneSlot` (data URI).

**Gateway.** `sceneAt` (`book-catalog-service.mjs:835`) → `ensureLatestMediaProjection` на каждый вызов → `loadSceneContext` (`postgres-book-markup-repository.mjs:258`: только v3 markup + shadow publication + `normalized_text_object_key`; иначе `processing` 202 / `failed` 409 / null → 404) → слот 6000 символов (`book-scenes.mjs:53`) → `ensureSceneSlot` (`:365`, priority 70, `failed` → `queued attempts=0`, `:401`) → воркер `claimGenerationJob` (`:2290`, lease 300 с) → `/internal/v1/book-scenes` → gpt-image-2 → nano banana fallback (`index.mjs generateInternalScene`) → `publishBookScene` (`:2729`). Промпт строится без жанра/главы/предыдущих сцен (`internal-generation-service.mjs:2507-2516`). Прогрев: только при старте gateway (`index.mjs:1228`, каталог — весь текст, приватные — 10 %); `advanceProgress` фронтир не двигает (`book-catalog-service.mjs:987`).

**Восстановление.** `sceneInsertAnchors()` (`scene-inserts.ts:26-45`) → `setSceneAnchors` → на load секции `applySceneInserts` → `sceneSlotRestored` → RN отдаёт data URI / `error` / `idle` (`ReaderScreen.tsx:826-852`). После 1e5819a каждый tap-anchor хранит своё связывание; одна картинка может стоять в нескольких слотах одного интервала. Инвалидация при смене markupIdentity (`narra-store.ts:105-135`).

**Success:** после нескольких страниц появляется слот «Сгенерировать сцену» → «Рисуем сцену…» → картинка в тексте, сохраняется при перезаходе; regen — «Заново».
**Failure:**
- книга не `ready` (локальная в анализе, v2-only, офлайн) → пустой анимированный квадрат без кнопки, тап — no-op (`reader.template.html:5920`);
- открытие любого sheet → кнопки на слотах временно пропадают (gate flap, Loop 2);
- `SCENE_SLOT_CHANGED` → слот навсегда в `error`, повторный тап переиспользует тот же intent (`ReaderScreen.tsx:770`);
- v2-only каталожная книга → `scenes/at` 404 (`book-catalog-service.mjs:844`);
- постоянно падающий слот (CENSOR/VALIDATION) переставляется в очередь каждым тапом, 3 попытки за раз, без потолка стоимости (`postgres-book-markup-repository.mjs:401`);
- зависший воркер → job перезахватывается каждые ~300 с без ограничения attempts (`:2314`);
- приватная книга: любая сцена дальше 10 % — полная генерация «по требованию» (минуты).

---

## Loop 5 — Голос (TTS по ролям)

**Чтение книги.** `tts-store.ts:69/216` → `TrackPlayerEdgeTTSPlayer` (`track-player-edge-player.ts:695-712`): голос из voice-markup плана (per-role) или `getNarratorVoice()` → `synthesizeNarraBookSpeech` → POST `/v2/speech/synthesize {ssml|text, voice}` (`media.ts:671-760`, 60 с, WAV валидация, retry-after) → gateway SaluteSpeech (`index.mjs:1950`). Входы: меню «speak» и iOS-тулбар (`ReaderScreen.tsx:1660-1665, 2200-2208`), выделение → `startSelectionTTS`, параметр `openTTS`. Мини-плеер `TTSMiniPlayer.tsx:84` использует `pushRoute('Reader')`.

**Голос персонажа / озвучка сцены.** `synthesizeNarraSpeech` (`media.ts:640-660`) → `getNarraTTSProvider()` = `grok` по умолчанию (`media.ts:39-41`) → прямой POST на `https://openrouter.ai/api/v1/audio/speech` с `getBundledApiKey('openrouter')` (`grok-speech.ts:107-146`, `bundled-ai.ts:3,33`). Сценарий озвучки сцены: `scene-audio.ts:61-102` (LLM `structured_task`, ≤24 сегментов, голоса по ролям).

**Success:** книга читается вслух нужными голосами через gateway; карточка персонажа проигрывает приветствие; сцена проигрывается по ролям.
**Failure:**
- ключ OpenRouter не задан в EAS (проверено: нет в `eas.json`/`.env*`) → голос персонажа/сцены падает с CONFIG «Озвучка не настроена в этой сборке»; если задан — провайдерский ключ лежит в бинаре, минуя квоты gateway;
- TTS-настройки (`TTSSettings`) недостижимы из UI (`RootNavigator.tsx:315-393`, `ProfileScreen.tsx:414-452`);
- 401 без заголовка не сбрасывает токен → до 15 мин AUTH (`narra-gateway-fetch.ts:443`).

---

## Loop 6 — Чат

**Чат с персонажем.** `NarraCharacterChatScreen.tsx`: только `backendManaged` и unlocked (`:116-118,125`); system prompt = имя, титул, черты, роль, стиль речи, % прогресса, память (`:50-78`) + последние 18 сообщений → `completeNarraChat` → POST `/v2/ai/chat/complete {messages, temperature, purpose:'character_chat', origin, analytics_tier, request_id}` (`narra-chat.ts:48-66`) — без `book_edition_id`, ключа персонажа и прогресса. Побочные вызовы: placeholder (`:154-185`), приветствие (`:215-273`), память каждые 4 сообщения (`:275-310`, ошибки глотаются). Хранение: `withNarraChatMessage` ≤ 80 сообщений (`domain.ts`), persist с debounce 500 мс (`persist.ts:27`). На gateway — чистый прокси (`index.mjs:1859`, `contracts.mjs:93-97` отвергает `book_edition_id`), серверного grounding нет.

**Narra о книге.** `ChatScreen.tsx:80-115`: LangChain + `useStreamingChat`; `createNarraAssistantAIConfig` → `/v2/ai/chat/stream` (`narra-assistant-gateway.ts:54-80`, purpose `assistant`). Grounding — инструмент `ragSearch` → GET `/v2/books/{edition}/search` только если `narraChatMode` index-first и известен `bookEditionId`; на 404/409 (`SEARCH_NOT_READY`) и большинство ошибок молча падает на локальный индекс/файл (`narra-book-search.ts:110-132`). На gateway роутер поиска монтируется только при `BOOK_SEARCH_ENABLED=true` (`index.mjs:1697-1699`, `.env.example` — false), индексы создаёт только оператор через CLI (`book-search-operator.mjs`).

**Summary.** `NarraSummaryScreen.tsx:21-55` → `summary.ts:6-53` (`purpose:'summary'`, отрывок ≤30k), кэш в `narra-store.summaries`.

**Success:** персонаж отвечает «в роли» с учётом % прогресса; Narra отвечает по книге со сниппетами (если индекс включён и построен).
**Failure:**
- сервер не может проверить спойлерную границу и идентичность персонажа — всё держится на клиентском промпте;
- grounding Narra фактически выключен по умолчанию: 409/HTML-404 → локальный fallback без сигнала пользователю;
- `response.text()` без дедлайна → «Печатает…» может висеть бесконечно (`narra-chat.ts:62`, `summary.ts:38`, `scene-audio.ts:87`);
- код ошибки gateway выбрасывается, классификация по regex текста (`summary.ts:46`, `errors.ts:35-79`);
- kill приложения в течение 500 мс после сообщения → сообщение потеряно (`flushAllWrites` нигде не вызывается, проверено).

---

## Loop 7 — Возврат

**Chats tab.** `ChatsScreen.tsx:39-49` → `createChatListSelector` (`chat-list-model.ts:59-114`): книги без `deletedAt`, только unlocked backendManaged персонажи, сортировка по `lastOpenedAt` desc; пейджер «Все» + по книгам; первая строка — Narra (→ `Chat` / `BookChat`), персонажи → `NarraCharacterChat` (`ChatsScreen.tsx:77-97`). Пустое состояние (ни у одной книги нет персонажей) → CTA в каталог (`:99-127`). Книга с только заблокированными персонажами показывается с одной строкой Narra без объяснения.

**Библиотека.** Прогресс — только % чип на `BookCard`; `ReadingNowShelf.tsx` не подключён (удалён из `LibraryScreen` в be0f33a; ledger `docs/work-orders/narra-core-loop-ledger.md:60-66` устарел). `lastOpenedAt` выставляется при импорте (`library-store.ts:1450`), поэтому только что импортированная книга сортируется как «недавно открытая».

**Deep links.** Отсутствуют: `NavigationContainer` без `linking` (`App.tsx:403`), scheme в `app.config.js:116` не используется.

**Success:** пользователь возвращается через Chats → персонаж/Narra, либо Library → карточка с %.
**Failure:** нет точки входа «продолжить читать»; переключение секций библиотеки всегда скроллит наверх (`native-segmented-pager.tsx:139-155` → `LibraryScreen.tsx:1165-1176`); мерцание секции при запуске (`LibraryScreen.tsx:306`); повторный CTA из Chats не переключает на каталог (`:288`).

---

## Разрывы (где цикл рвётся или деградирует)

1. **Каталог обещает больше, чем отдаёт.** v2-only editions видны в каталоге (`ready` по статусу edition), но манифест `unavailable` и `scenes/at` 404 (`postgres-book-markup-repository.mjs:258`, `book-catalog-service.mjs:285-345, 844`). Клиент не считает это ошибкой (`backend-book-sync.ts:250-258`), ридер показывает пустые анимированные квадраты (`ReaderScreen.tsx:1277`, `reader.template.html:5920`). Loop 1 → Loop 3/4 рвётся молча.
2. **Готовность бэкенда «мигает».** Любой sheet поверх ридера сбрасывает статус (`backend-book-sync.ts:286-296`) → кнопки на слотах исчезают; офлайн — до возврата сети (`ReaderScreen.tsx:1010`).
3. **Сцены без контекста и с бесконечными повторами.** Промпт без жанра/главы (`internal-generation-service.mjs:2510`); failed-job переочередь на каждый тап (`repo:401`); dead-lease без потолка (`repo:2314`); фронтир не двигается по прогрессу (`book-catalog-service.mjs:987`); `SCENE_SLOT_CHANGED` без восстановления (`ReaderScreen.tsx:770`).
4. **Чат без сервера.** Ни один LLM-вызов, кроме ассистента, не несёт идентичность книги (`narra-chat.ts:51`); grounding Narra выключен флагом и отсутствием индексов (`index.mjs:1697`, `ChatScreen.tsx:102`).
5. **Голос вне gateway.** Персонажи/сцены озвучиваются через OpenRouter с ключом в бинаре, которого нет в EAS (`media.ts:40`, `grok-speech.ts:26`, `bundled-ai.ts:3`).
6. **Потеря состояния.** Persist без версии и без try/catch (`persist.ts:107`) может навсегда оставить `_hasHydrated=false`; debounce 500 мс без flush (`persist.ts:27`); unmount ридера пишет мимо стора (`ReaderScreen.tsx:1807`).
7. **Возврат без «Читаю сейчас».** `ReadingNowShelf` осиротел, deep links нет, onboarding мёртв, ~10 настроечных экранов недостижимы (`RootNavigator.tsx:315`).
8. **Android — вторая лига.** Нет тулбара (`ReaderToolbar.tsx:1-9`), нет `onRenderProcessGone` (`ReaderScreen.tsx:2385`).
9. **Документация врёт коду.** `narra-core-loop-ledger.md` (ReadingNow/ReadingTab/MyPath), `packages/app-expo/NARRA_GATEWAY.md` (39-строчная заглушка без scenes/at, progress, manifest, search), README gateway про «Kandinsky routing» и «failed jobs не дублируются».

---

## Что не входит в core loop

- WebDAV / sync (`SyncSettings`, `useAutoSync`, `WebDavImportBrowser`) — унаследовано от ReadAny.
- Статистика/heatmap (`ProfileScreen`, `Stats`, `Badges`) — `Stats`/`Badges` недостижимы.
- Заметки (`ProfileNotes`, `ManualNote`, `FullScreenNotes`), аннотации/подсветки.
- `Skills`, `AISettings`, `TranslationSettings`, `FontSettings`, `AppearanceSettings`, `About` — зарегистрированы, но без входа из UI.
- Векторизация/локальный RAG (`useVectorizationQueue`, `VectorModelSettings`) — используется только как fallback ассистента.
- Клиентский LLM-анализ персонажей (`character-analysis.ts`, `character-analysis-queue.ts`, bundled/mock characters) — по grep без вызовов из экранов (гипотеза: мёртвый код).
- Легаси-маршруты gateway: `/v2/media/scene/jobs`, `/v2/media/cover`, `/local-markup`, `ReadingTabScreen`, параметр `catalogBookId`.
- Update checker (Android-only GitHub release), Storybook (DEV).
