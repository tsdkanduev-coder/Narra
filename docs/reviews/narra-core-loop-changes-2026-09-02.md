# Что изменено в ветке `narra/core-loop-polish` (2 сентября 2026)

База: `mishanaer/Narra` `main` = `62a80b7` (после PR #59). 12 коммитов, 77 файлов, +3862 / −872.
Диагностика и локализация проблем — в `docs/reviews/narra-core-loop-review-2026-09-01.md` (проблема → причина с `file:line` → как чинить, по каждому пункту релизного чек-листа). Эта заметка — что именно сделано и как это проверено.

Ветка заменяет draft PR #51: из него оставлены только идеи, не конфликтующие с текущим направлением `main` (таббар Library/Chats/Profile/Search, аниме-канон, интервал врезок 4 — не трогались).

## Итог по чек-листу релиза

| Пункт чек-листа | Что сделано | Статус |
|---|---|---|
| Не работают сцены | клиент: слот не вставляется без готовой разметки, неактивный слот с подписью, toast при провале; gateway: тап читателя обгоняет бэкфилл в очереди; промпт сцены под gpt-image (жанр, глава, отрывок вокруг якоря) | проверено вживую в симуляторе: слот виден, картинка встала в текст; эвалы сцен 6/6 по двум книгам |
| Неполный/противоречивый характер | gateway: аудит больше не обнуляет описание, claim с частично валидными уликами сохраняется | код готов; на staging профили «Преступления и наказания» пустые из старого прогона — нужен операторский пересинтез (у «Войны и мира» 19/19 полных) |
| Имена не нормализованы, «нарратор» вместо имени | клиент: голос бэкенд-героя не копирует голос нарратора, реплики в озвучке сцены резолвятся по словоформам и алиасам; gateway: «Рассказчик/Автор» не попадают в героев | unit-тесты; живая озвучка не проверялась |
| Фотки «Преступления и наказания» не по промпту | gateway: бюджет промпта 2500 вместо 950, отрывок вокруг якоря, жанр издания и глава в промпте, хвосты предыдущих слотов | unit; уже сгенерированные картинки перерисует только requeue после деплоя |
| Каталог не вычищен (вёрстка, ссылки) | клиент: внешние ссылки из EPUB не уводят WebView из книги, подсказка с хостом | unit; очистка текста при инжесте (`normalized-text-v2`) — план в ревью, не сделано |
| Чат с Наррой (закрыт владельцем) | клиент: память треда через `/complete` (раньше терялась при ≥12 сообщениях), spoiler-free по умолчанию | эвал ассистента 2/2 у судьи |
| Разметка на импортных книгах (закрыт владельцем) | клиент: терминальные ошибки формата/размера вместо бесконечного повтора bind/PUT | unit; статус-строка в экране героев не сделана |

Плюс: персист сторов переживает битый снимок и упавшую миграцию, `flushAllWrites` при уходе в фон (раньше терялось последнее сообщение чата).

## По коммитам

### `f284e94` docs: ревью, карта loop, handoff, smoke-пробы staging
- `docs/reviews/narra-core-loop-review-2026-09-01.md`, `docs/narra-core-loop.md`, `docs/work-orders/narra-handoff-2026-09-02.md`, `tools/narra-evals/staging-*.mjs`, `packages/app-expo/NARRA_GATEWAY.md` (сверен с реальными маршрутами `main`).

### `300e814` chore: аддитивные помощники
- `errors.ts` (`narraErrorFromGatewayResponse` и др.), заготовки в `voice-rules.ts`/`character-name-matcher.ts`/`types.ts`, `provider-response.mjs` (детект `finish_reason=length`). Пока не подключены к экранам.

### `e376bb6` fix: слот сцены, приоритет тапа, описание героя, резолв героя в озвучке
- `ReaderScreen.tsx`: `insertSceneSlot` только при `backendSceneEnabled`; toast с кодом при провале. `reader.template.html`: неактивный слот без анимации, с подписью «Сцена появится после разметки книги»; `reader.html` пересобран.
- `postgres-book-markup-repository.mjs` `ensureSceneSlot`: `UPDATE … priority = GREATEST(priority, $p), available_at = LEAST(available_at, now())` для уже поставленной задачи.
- `internal-generation-service.mjs`: `normalizeProfileAuditResult` (`undefined` ≠ отказ), `normalizeGroundedProfileClaim` (подмножество улик).
- `scene-audio.ts`: реестр с именем/полным именем/алиасами, резолв через `character-name-matcher`, потом по слову имени, потом нарратор.
- i18n: `narra.sceneSlotDisabled/Failed/FailedCode`; ревизии локалей обновлены (три были устаревшими на `main`, тест core падал).
- Тесты: gateway +4, клиент +2, контрактные тесты шаблона обновлены.

### `d10ab2b` fix: память треда Narra, spoiler-free, персист
- `narra-assistant-gateway.ts`: `wrapCompleteResponse` — `/complete` → OpenAI `chat.completion` для LangChain.
- `ChatScreen.tsx`/`NarraChat.tsx`: `defaultSpoilerFree` = есть книга.
- `persist.ts`: карантин битого снимка (`<key>.json.corrupt-<ts>`), try/catch миграции, финальный `catch`; `App.tsx`: `flushAllWrites` на `AppState` background/inactive. `src/stores` добавлен в `pnpm test`.
- Тесты: +2 (gateway-adapter), +4 (persist).

### `1cb2c2d` fix(gateway): промпт сцены под gpt-image
- `scene-generation.mjs`: `sceneGenerationPrompt(input, { promptLimit })`, `SCENE_GPT_IMAGE_PROMPT_LIMIT = 2500`, минимумы отрывка 600 / канона 300.
- `book-scenes.mjs`: `sceneExcerptAround`, `previousSceneExcerptsFromText`, `chapterTitleAtOffset`.
- `getBookSceneInput`: жанр из `book_edition_genres`, глава из `content_navigation`; `normalizeBookSceneRequest` принимает опциональные `genreId`/`chapter`.
- Тесты: +2, кейс сцены обновлён.

### `fc21d02` docs: матрица эвалов (57 кейсов)

### `95bb265` fix: голоса героев, терминальные ошибки импорта
- `backend-book-contract.ts`: `backendActorVoice` — ассистентский голос из профиля только подсказка пола; голоса даёт `assignVoices`.
- `backend-book-sync.ts`: `FORMAT_UNSUPPORTED` (не epub/fb2/txt/pdf), `SOURCE_TOO_LARGE` (> 50 МиБ), `isTerminalBackendBookError`; `backend-book-session.ts`: терминальная ошибка останавливает цикл до `retry()`.
- Тесты: +2.

### `1f968db` fix(gateway): псевдо-персонажи
- `character-display-name.mjs`: `isPseudoCharacterName`; `book-catalog-service.mjs` фильтрует в обеих ветках `v3Manifest`. Тест +1.

### `213e3ab` fix(reader): внешние ссылки
- `reader.template.html`: слушатель `external-link` гасит `globalThis.open`; `ReaderScreen.tsx`: `onShouldStartLoadWithRequest` пропускает только локальные документы (`src/lib/reader/reader-links.ts`); подсказка «Ссылка ведёт за пределы книги». Тест-контракт +1.

### `1eec167`, `31a0913`, `e854f14` feat(evals): живой eval-CLI
- `tools/narra-evals/run.mjs`, `pnpm evals:narra`: манифест, сцены (дедлайн = контракт клиента 300 с), серверный поиск (информационно), ассистент через stream + судья, профили героев, чистота текста, синтез 16 голосов, 3-ходовой чат с героем + судья. Отчёт JSON/MD.

## Проверки

- app-expo: `tsc --noEmit` 0 ошибок; vitest 849/849 (96 файлов). Gateway: `node --test` 703 pass / 16 skipped. Core i18n 9/9.
- Симулятор iPhone 17 Pro Max, dev-client собран из чистого клона (`prebuild` → `pod install` → `rebuild-ios`), staging `api-test`: приложение открывается без RedBox; «Преступление и наказание»: слот сцены виден на 8-й странице, по тапу картинка сцены встала в текст.
- Живые эвалы по «Преступлению и наказанию» и «Войне и миру»: детерминированные 15 ✅ / 1 ❌; с LLM-судьёй 5 ✅ / 1 ⏭. Единственный ❌ — пустые профили C&P на staging (старый прогон синтеза).

## Что не проверено

- Живая озвучка по ролям, импорт неподдерживаемого формата, внешняя ссылка в ридере — только unit/контракты.
- Бэкенд-фиксы (приоритет слота, аудит описаний, промпт сцены, фильтр псевдо-персонажей) не задеплоены: staging работает на коммите `ebd6773d`, которого нет в репозитории.
- Android не проверялся.

## Что нужно от владельца

1. Задеплоить ветку на staging; поднять `BOOK_SCENE_WORKER_REPLICAS` (сцены у «Войны и мира» на 10 % и 50 % генерировались 102 и 120 с).
2. Перезапустить синтез профилей «Преступления и наказания» (операторский `book-analysis-cli.mjs`), при желании — requeue сцен C&P, чтобы перерисовать их новым промптом.
3. Решить продуктовые развилки из ревью §5 (в частности `BOOK_SEARCH_ENABLED` на staging, показ закрытых героев в «Чатах», ключ OpenRouter в бинаре для голоса героев).
4. После деплоя: `NARRA_EVALS_LLM=1 pnpm evals:narra`.

## Что осталось в бэклоге ветки

Очистка текста каталога при инжесте и `normalized-text-v2`; каст и turn-taking для озвучки импортных книг; именительная форма имён и алиасы на gateway; аудио-UX (пауза/резюм, док плеера, доступные настройки, sleep-таймер — нативные методы отсутствуют в модуле); строка статуса импорта в экране героев. Всё расписано в `docs/work-orders/narra-handoff-2026-09-02.md`.
