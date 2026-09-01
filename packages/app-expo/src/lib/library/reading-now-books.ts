import type { Book } from "@readany/core/types";

/** Книги для полки «Читаю сейчас»: начаты, ещё не дочитаны, свежие сверху. */
export function selectReadingNowBooks(books: readonly Book[]): Book[] {
  return books
    .filter((book) => {
      if (book.deletedAt) return false;
      const progress = book.progress ?? 0;
      return progress > 0 && progress < 1;
    })
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
}
