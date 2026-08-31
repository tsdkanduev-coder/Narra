import type { Book } from "@readany/core/types";
import { isCharacterUnlocked } from "./domain";
import type { NarraBookState, NarraCharacter } from "./types";

export interface ChatListBook {
  id: string;
  title: string;
}

export interface ChatListRow {
  bookId: string;
  bookTitle: string;
  character: NarraCharacter;
  unlocked: boolean;
  messageCount: number;
  fromBundledCatalog: boolean;
}

export interface ChatListModel {
  books: readonly ChatListBook[];
  rowsByBook: ReadonlyMap<string, readonly ChatListRow[]>;
  allRows: readonly ChatListRow[];
}

interface BookCache {
  book: ChatListBook;
  characters?: readonly NarraCharacter[];
  chats?: NarraBookState["chats"];
  progress?: number;
  fromBundledCatalog?: boolean;
  rows: readonly ChatListRow[];
}

const EMPTY_CHARACTERS: readonly NarraCharacter[] = [];
const EMPTY_CHATS: NarraBookState["chats"] = {};

function retainItems<T>(previous: readonly T[], next: readonly T[]): readonly T[] {
  return previous.length === next.length && previous.every((item, index) => item === next[index])
    ? previous
    : next;
}

/**
 * A selector instance belongs to one mounted screen. It keeps only current
 * library books and preserves unchanged page/row identities across updates to
 * portraits, messages, covers and unrelated Narra state.
 */
export function createChatListSelector() {
  let cache = new Map<string, BookCache>();
  let model: ChatListModel = { books: [], rowsByBook: new Map(), allRows: [] };
  let previousBooks: readonly Book[] | undefined;
  let previousNarraBooks: Record<string, NarraBookState> | undefined;

  return (books: readonly Book[], narraBooks: Record<string, NarraBookState>): ChatListModel => {
    if (books === previousBooks && narraBooks === previousNarraBooks) return model;
    const nextCache = new Map<string, BookCache>();
    const available: { book: ChatListBook; rows: readonly ChatListRow[]; openedAt: number }[] = [];

    for (const book of books) {
      if (book.deletedAt) continue;
      const previous = cache.get(book.id);
      const title = book.meta.title;
      const entry: BookCache = previous ?? { book: { id: book.id, title }, rows: [] };
      const titleChanged = entry.book.title !== title;
      if (titleChanged) entry.book = { id: book.id, title };
      const state = narraBooks[book.id];
      const storedCharacters = state?.characters ?? EMPTY_CHARACTERS;
      const fromBundledCatalog = false;
      const characters = storedCharacters;
      const chats = state?.chats ?? EMPTY_CHATS;
      const progress = book.progress ?? 0;

      if (
        titleChanged ||
        entry.characters !== characters ||
        entry.chats !== chats ||
        !Object.is(entry.progress, progress) ||
        entry.fromBundledCatalog !== fromBundledCatalog
      ) {
        const previousRows = new Map(entry.rows.map((row) => [row.character.id, row]));
        const rows: ChatListRow[] = [];
        for (const character of characters) {
          const unlocked = isCharacterUnlocked(progress, character);
          const messageCount = chats[character.id]?.length ?? 0;
          const row = previousRows.get(character.id);
          rows.push(
            row &&
              row.bookTitle === title &&
              row.character === character &&
              row.unlocked === unlocked &&
              row.messageCount === messageCount &&
              row.fromBundledCatalog === fromBundledCatalog
              ? row
              : {
                  bookId: book.id,
                  bookTitle: title,
                  character,
                  unlocked,
                  messageCount,
                  fromBundledCatalog,
                },
          );
        }
        rows.sort((left, right) => Number(right.unlocked) - Number(left.unlocked));
        entry.rows = retainItems(entry.rows, rows);
        entry.characters = characters;
        entry.chats = chats;
        entry.progress = progress;
        entry.fromBundledCatalog = fromBundledCatalog;
      }

      nextCache.set(book.id, entry);
      if (characters.length > 0) {
        available.push({ book: entry.book, rows: entry.rows, openedAt: book.lastOpenedAt ?? 0 });
      }
    }
    cache = nextCache;
    available.sort((a, b) => b.openedAt - a.openedAt);

    const nextBooks = retainItems(
      model.books,
      available.map((entry) => entry.book),
    );
    const allRows = retainItems(
      model.allRows,
      available.flatMap((entry) => entry.rows),
    );
    const unchangedPages =
      model.rowsByBook.size === available.length &&
      available.every((entry) => model.rowsByBook.get(entry.book.id) === entry.rows);
    const rowsByBook = unchangedPages
      ? model.rowsByBook
      : new Map(available.map((entry) => [entry.book.id, entry.rows]));

    if (nextBooks !== model.books || allRows !== model.allRows || rowsByBook !== model.rowsByBook) {
      model = { books: nextBooks, rowsByBook, allRows };
    }
    previousBooks = books;
    previousNarraBooks = narraBooks;
    return model;
  };
}
