import { useReaderStore } from "@/stores/reader-store";

export type LiveReaderPosition = {
  progress: number;
  currentCfi: string;
  chapterTitle?: string;
};

export type CharacterPromptLocation = {
  currentCfi?: string;
  chapter?: string;
};

/**
 * Живая позиция читалки из уже существующего reader-store.
 * Пустой CFI — как в ReaderScreen.publishCharacterProgress: без якоря не пишем.
 * Вкладку после закрытия модалки не снимаем: иначе «Мой путь» снова видит
 * только throttled library (до 5 с) и чат уходит со stale страницы.
 */
export function liveReaderPosition(bookId: string): LiveReaderPosition | null {
  if (!bookId) return null;
  const { tabs } = useReaderStore.getState();
  const tab = tabs[bookId] ?? Object.values(tabs).find((item) => item.bookId === bookId);
  const currentCfi = tab?.currentCfi?.trim();
  if (!tab || !currentCfi) return null;
  return {
    progress: tab.progress,
    currentCfi,
    chapterTitle: tab.chapterTitle?.trim() || undefined,
  };
}

/**
 * Перед чатом с «Мой путь»: если есть живой CFI — пишем его в библиотеку.
 * Поля те же, что ReaderScreen.publishCharacterProgress. Главу в Book не кладём.
 */
export function publishLiveReaderProgress(
  bookId: string,
  updateBook?: (id: string, patch: { progress: number; currentCfi: string }) => unknown,
): boolean {
  const live = liveReaderPosition(bookId);
  if (!live || typeof updateBook !== "function") return false;
  void updateBook(bookId, {
    progress: live.progress,
    currentCfi: live.currentCfi,
  });
  return true;
}

export function resolveCharacterPromptContext(
  bookId: string,
  book: { progress: number; currentCfi?: string },
): { progress: number; location: CharacterPromptLocation } {
  const live = liveReaderPosition(bookId);
  return {
    progress: live?.progress ?? book.progress,
    location: {
      currentCfi: live?.currentCfi || book.currentCfi,
      chapter: live?.chapterTitle,
    },
  };
}

export function formatCharacterPromptLocation(
  language: string,
  location?: CharacterPromptLocation,
): string {
  const chapter = location?.chapter?.trim();
  const currentCfi = location?.currentCfi?.trim();
  if (!chapter && !currentCfi) return "";
  if (language === "ru") {
    return [
      chapter ? `Сейчас глава «${chapter}».` : "",
      currentCfi ? `Текущая позиция в книге: ${currentCfi}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    chapter ? `Current chapter: "${chapter}".` : "",
    currentCfi ? `Current position in the book: ${currentCfi}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
