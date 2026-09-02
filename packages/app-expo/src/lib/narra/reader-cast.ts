/**
 * Состав героев для читалки (озвучка и кликабельные имена) — C4-RC2.
 *
 * Раньше ReaderScreen отдавал в TTS только бэкенд-героев, поэтому у импортных
 * и bundled-книг каст был пустым и каждая реплика звучала нарратором.
 * Правило: пока бэкенд-манифест не готов (или все его герои provisional),
 * читалка работает с локальным составом книги — bundled-героями каталога или
 * результатом клиентского анализа (оба живут в narra-store.books[id].characters).
 * Готовый бэкенд-состав вытесняет локальный.
 */

import type { BackendBookManifest } from "./backend-book-contract";
import type { NarraBookState, NarraCharacter } from "./types";

const EMPTY_CAST: readonly NarraCharacter[] = [];

/** Бэкенд-герои, подтверждённые готовым и непровизорным манифестом. */
function backendReaderCast(
  characters: readonly NarraCharacter[],
  manifest: BackendBookManifest | undefined,
): NarraCharacter[] {
  if (manifest?.availability !== "ready") return [];
  const confirmed = new Set(
    manifest.characters
      .filter((item) => !item.provisional && item.state !== "unknown")
      .map((item) => item.key),
  );
  return characters.filter((character) => character.backendManaged && confirmed.has(character.id));
}

/**
 * Каст читалки из состава книги и её манифеста. Чистая функция для useMemo:
 * ссылки на входы стабильны в сторе, а результат не пересобирается на каждом
 * рендере.
 */
export function readerCastForCharacters(
  characters: readonly NarraCharacter[] | undefined,
  manifest: BackendBookManifest | undefined,
): readonly NarraCharacter[] {
  if (!characters || characters.length === 0) return EMPTY_CAST;
  const backend = backendReaderCast(characters, manifest);
  if (backend.length > 0) return backend;
  const local = characters.filter((character) => !character.backendManaged);
  return local.length > 0 ? local : EMPTY_CAST;
}

/** Селектор по стору: бэкенд-каст, если манифест готов, иначе локальный. */
export function readerCastForBook(
  state: { books: Record<string, NarraBookState | undefined> },
  bookId: string,
): readonly NarraCharacter[] {
  const book = state.books[bookId];
  return readerCastForCharacters(book?.characters, book?.backendManifest);
}
