# Handoff — кампания «core loop polish» (Fable, 1–2 сентября 2026)

Ветка: `narra/core-loop-polish` (от `origin/main` `62a80b7`, PR #59). Рабочая копия: `/Users/tsevdnkanduev/Narra` (клон `mishanaer/Narra`, gh-аккаунт `tsdkanduev-coder`). Цель: собрать core product loop, вылизать баги чек-листа релиза, получить рабочую сборку, написать эвалы.

## Документы этой кампании

- `docs/reviews/narra-core-loop-review-2026-09-01.md` — **главный документ для Миши**: резюме P0-1…P0-10, живые факты staging, по каждому пункту чек-листа: проблема → причины с уликами `file:line` → как чинить → вердикты проверяющих; инвентарь B001–B060; аудио-UX; продуктовые развилки.
- `docs/narra-core-loop.md` — карта core loop (Loop 0…7) в состоянии `main`, с разрывами.
- `packages/app-expo/NARRA_GATEWAY.md` — переписан по реальным маршрутам `main` (агент W-D; проверить глазами, что ссылки на строки актуальны).
- `tools/narra-evals/staging-smoke.mjs`, `staging-character-dump.mjs` — рабочие пробы staging: регистрация тестовой установки → каталог → манифест → `scenes/at` → search; дамп профиля героя, TOC и первого чанка текста. Запуск: `node tools/narra-evals/staging-smoke.mjs` (Node 22, без зависимостей).

## Состояние кода в ветке

Зелёная база (до правок): app-expo `tsc` 0, vitest 827/827, gateway `node --test` 695 pass / 16 skipped.

Оставленные аддитивные правки прерванных агентов (tsc 0, тесты `src/lib/narra` и `src/lib/ai` зелёные, кроме отменённой правки `narra-gateway-fetch.ts`):
- `packages/app-expo/src/lib/narra/errors.ts` (+тест): `narraErrorFromGatewayResponse`, `narraErrorCodeForGatewayResponse`, `isNarraTimeoutError` — пока никем не вызываются (B036: подключить в `summary.ts`, `narra-chat.ts`, `scene-audio.ts`).
- `packages/app-expo/src/lib/narra/voice-rules.ts`, `character-name-matcher.ts`, `types.ts` — аддитивные помощники для назначения голосов/алиасов (C4), не подключены.
- `services/narra-gateway/provider-response.mjs` (+тест) — детект `finish_reason=length` (C2-RC6).
- В `git stash` («phase1-partial-agents») лежит отменённая версия `narra-gateway-fetch.ts` (ломала 3 теста) и конфликтующая правка `backend-book-contract.ts`; черновик `book-source-clean.mjs` — в scratchpad сессии, в дерево не попал. Stash можно удалить.

## Сборка и запуск (проверено на этой машине)

Чистый клон → `pnpm install --frozen-lockfile` (2,5 мин) → из `packages/app-expo`:

```bash
pnpm run build:reader && APP_VARIANT=development npx expo prebuild --platform ios --no-install && (cd ios && pod install) && APP_VARIANT=development node scripts/configure-native-variant.js
READANY_SIMULATOR_NAME="iPhone 17 Pro Max" READANY_ALLOW_PASTEBOARD_SYNC=1 ./script/build_and_run.sh rebuild-ios
```

Итог 1 сентября: три `BUILD SUCCEEDED`, dev-client `com.mishanaer.readany.dev` build 36 установлен на iPhone 17 Pro Max (UDID `391D4246-C13E-42B6-B7AF-15D3B7FD9DC6`), Metro на `127.0.0.1:8081`, приложение открылось без RedBox, бэкенд верифицирован как staging. Ежедневный запуск дальше: `READANY_SIMULATOR_NAME="iPhone 17 Pro Max" READANY_ALLOW_PASTEBOARD_SYNC=1 ./script/build_and_run.sh`. На машине нет симулятора «iPhone 17 Pro» (дефолт скрипта) — задавать имя явно. Pasteboard sync в Simulator включён: override только на время проверок, настройки не менялись.

Проверки: `pnpm --filter @readany/app-expo exec tsc --noEmit -p .`, `pnpm --filter @readany/app-expo test`, `cd services/narra-gateway && npm ci && npm test`, `pnpm lint` (biome).

## Что сделано / что осталось

Сделано: карта loop, ревью с локализацией на бэке, живые пробы staging, рабочая сборка симулятора, NARRA_GATEWAY.md, аддитивные помощники (см. выше).

Сделано в коде (см. ledger): P0-1 (слот сцены без бэкенда; проверено вживую — картинка сцены встала в текст), P0-2 (промоушен приоритета слота), P0-4 (описание героя после аудита), P0-3 частично (резолв героя в озвучке сцены), P0-6 (промпт сцены: бюджет gpt-image, жанр, глава, отрывок вокруг якоря), P0-7 (память треда Narra, spoiler-free по умолчанию), P0-10 (персист: карантин битого снимка, flush в фоне).

Осталось (в порядке приоритета, см. таблицу P0 в ревью):
1. P0-1 клиент: не вставлять слот сцены при `!backendSceneEnabled`, видимая рамка/подпись, явное «Сцена появится после разметки», toast при `failed` (`ReaderScreen.tsx` ~1269-1283, 742-822; `reader.template.html` `renderSceneInsert`/`configureSceneSlots`; после правки шаблона — `pnpm run build:reader`).
2. P0-2 gateway: промоушен приоритета в `ensureSceneSlot` (`postgres-book-markup-repository.mjs` ~365-441) + тест в `test/book-p0-reader-path.test.mjs`; на staging поднять `BOOK_SCENE_WORKER_REPLICAS`.
3. P0-3 голоса: `backend-book-contract.ts` (voice = подсказка пола → `assignVoices`), `scene-audio.ts` (резолв героя по имени/алиасам), `readerCastForBook` + fallback каста для импортных книг, turn-taking в `voice-markup.ts`.
4. P0-4 gateway: `normalizeProfileAuditResult`/`normalizeGroundedProfileClaim` в `internal-generation-service.mjs` — `undefined` ≠ отказ, подмножество evidence.
5. P0-6 gateway: бюджет промпта сцены по провайдеру, жанр+глава (`getBookSceneInput`), версия промпта в ключе.
6. P0-7 чат: `narra-assistant-gateway.ts` обёртка non-stream `/complete`; spoiler-free по умолчанию в `ChatScreen.tsx`.
7. P0-8 импорт: терминальные ошибки и статус в `backend-book-sync.ts`/`NarraCharactersScreen.tsx`.
8. P0-10 persist: версия + try/catch + flush на background.
9. P0-9 текст: safety-net ссылок в ридере; `normalized-text-v2` за флагом.
10. P0-5 имена: фильтр псевдо-персонажей и именительная форма на gateway.
11. Эвалы: `docs/narra-evals.md` (матрица OB/RD/CH/SC/NA/AU/RL из scratchpad `eval-design.json` — 57 кейсов) и CLI `tools/narra-evals/run.mjs` (агент не успел; заготовки — smoke-скрипты выше).
12. Аудио-UX: R1 пауза/резюм + док плеера, R2 тосты ошибок, R3 доступные настройки озвучки, R4 быстрый старт, R11 метаданные lock-screen (`docs/reviews/…` §4).
13. Перед живой проверкой фиксов бэка — задеплоить staging из `main` (сейчас там коммит `ebd6773d`, которого нет в репо).

## Правила, которые нужно соблюдать

- Направление владельца важнее work order: табы Library/Chats/Profile/Search, аниме-канон, интервал врезок 4; не переносить эти части PR #51.
- Не менять контракт gateway без правки `contracts.mjs`/парсеров (exact keys → 400), не менять схему БД без миграции, не трогать foliate vendor и deslop-primitives.
- Никаких туннелей; Simulator только через `script/build_and_run.sh`.
- Каждый фикс — отдельный коммит с русским сообщением, тесты рядом, в ledger `docs/work-orders/narra-core-loop-ledger.md` — запись «что/зачем/проверки/не проверено».
