import type { Book } from "@readany/core/types";
import { describe, expect, it } from "vitest";
import { createChatListSelector } from "./chat-list-model";
import { emptyNarraBookState, withNarraCharacters } from "./domain";
import type { NarraBookState, NarraCharacter, NarraChatMessage } from "./types";

function book(id: string, overrides: Partial<Book> = {}): Book {
  return {
    id,
    filePath: `${id}.epub`,
    format: "epub",
    meta: { title: id, author: "Author" },
    addedAt: 1,
    updatedAt: 1,
    progress: 0.5,
    isVectorized: false,
    vectorizeProgress: 0,
    tags: [],
    syncStatus: "local",
    ...overrides,
  };
}

function character(id: string, unlockProgress = 0): NarraCharacter {
  return {
    backendManaged: true,
    id,
    name: id,
    fullName: id,
    role: "Character",
    gender: "male",
    voice: "voice",
    traits: [],
    speechStyle: "",
    speechExamples: [],
    appearancePrompt: "",
    unlockProgress,
  };
}

function state(id: string, characters: NarraCharacter[]): NarraBookState {
  return { ...emptyNarraBookState(id), characters };
}

function message(id: string): NarraChatMessage {
  return { id, role: "user", content: "Synthetic test message", createdAt: 1 };
}

describe("chat list model", () => {
  it("preserves book order, unlock rules and per-book message order", () => {
    const select = createChatListSelector();
    const a = state("a", [
      character("first", 0.1),
      character("active", 0.3),
      character("locked", 0.8),
    ]);
    a.chats.active = [message("1")];
    const model = select(
      [book("a", { lastOpenedAt: 2 }), book("b", { lastOpenedAt: 3 }), book("empty")],
      { a, b: state("b", [character("b")]) },
    );
    expect(model.books.map((item) => item.id)).toEqual(["b", "a"]);
    expect(model.allRows.map((row) => row.character.id)).toEqual(["b", "first", "active", "locked"]);
    expect(model.allRows.find((row) => row.character.id === "locked")?.unlocked).toBe(false);
  });

  it("retains the exact model for no-op and unrelated metadata updates", () => {
    const select = createChatListSelector();
    const books = [book("a")];
    const narraBooks = { a: state("a", [character("a")]) };
    const first = select(books, narraBooks);
    expect(select(books, narraBooks)).toBe(first);
    expect(
      select([{ ...books[0], meta: { ...books[0].meta, coverUrl: "file:///new-cover" } }], {
        a: {
          ...narraBooks.a,
          memories: { a: "changed" },
          characters: [...narraBooks.a.characters],
        },
      }),
    ).toBe(first);
  });

  it("changes only the affected row and book page when one portrait completes", () => {
    const select = createChatListSelector();
    const books = [book("a"), book("b"), book("c")];
    const narraBooks = {
      a: state("a", [character("a1"), character("a2")]),
      b: state("b", [character("b")]),
      c: state("c", [character("c")]),
    };
    const first = select(books, narraBooks);
    const next = select(books, {
      ...narraBooks,
      a: {
        ...narraBooks.a,
        characters: [
          { ...narraBooks.a.characters[0], portraitUri: "file:///portrait" },
          narraBooks.a.characters[1],
        ],
      },
    });
    expect(next.books).toBe(first.books);
    expect(next.rowsByBook.get("a")).not.toBe(first.rowsByBook.get("a"));
    expect(next.rowsByBook.get("b")).toBe(first.rowsByBook.get("b"));
    expect(next.rowsByBook.get("c")).toBe(first.rowsByBook.get("c"));
    expect(next.allRows[0]).not.toBe(first.allRows[0]);
    for (let index = 1; index < next.allRows.length; index += 1) {
      expect(next.allRows[index]).toBe(first.allRows[index]);
    }
  });

  it("keeps its complete model after equal setCharacters inputs and analysis metadata updates", () => {
    const select = createChatListSelector();
    const books = [book("a"), book("b")];
    const narraBooks = {
      a: { ...state("a", [character("a1"), character("a2")]), analysisError: "old" },
      b: state("b", [character("b")]),
    };
    const first = select(books, narraBooks);
    const reanalyzed = withNarraCharacters(
      { ...narraBooks.a, memories: { a1: "Updated unrelated memory" } },
      narraBooks.a.characters.map((item) => ({
        ...item,
        traits: [...item.traits],
        speechExamples: [...item.speechExamples],
      })),
      200,
    );
    expect(reanalyzed).not.toBe(narraBooks.a);
    expect(reanalyzed.analyzedAt).toBe(200);
    expect(reanalyzed.analysisError).toBeUndefined();
    expect(select(books, { ...narraBooks, a: reanalyzed })).toBe(first);
  });

  it("exposes the current full character after an actual non-list field changes", () => {
    const select = createChatListSelector();
    const books = [book("a"), book("b")];
    const narraBooks = { a: state("a", [character("a1")]), b: state("b", [character("b")]) };
    const first = select(books, narraBooks);
    const reanalyzed = withNarraCharacters(
      narraBooks.a,
      [{ ...narraBooks.a.characters[0], appearancePrompt: "Updated portrait instructions" }],
      200,
    );
    const next = select(books, { ...narraBooks, a: reanalyzed });
    expect(next.allRows[0]).not.toBe(first.allRows[0]);
    expect(next.allRows[0].character).toBe(reanalyzed.characters[0]);
    expect(next.allRows[0].character.appearancePrompt).toBe("Updated portrait instructions");
    expect(next.rowsByBook.get("b")).toBe(first.rowsByBook.get("b"));
  });

  it("ignores changed message content when the count and ordering stay the same", () => {
    const select = createChatListSelector();
    const books = [book("a")];
    const a = { ...state("a", [character("a")]), chats: { a: [message("1")] } };
    const first = select(books, { a });
    expect(select(books, { a: { ...a, chats: { a: [message("2")] } } })).toBe(first);
  });

  it("never seeds profiles from titles, but keeps private and locked heroes", () => {
    const select = createChatListSelector();
    expect(select([book("a")], {}).allRows).toEqual([]);
    const privateLocked = select([book("a", { progress: 0 })], {
      a: state("a", [{ ...character("legacy", 0.8), backendManaged: false }]),
    }).allRows;
    expect(privateLocked).toHaveLength(1);
    expect(privateLocked[0]?.unlocked).toBe(false);
    expect(privateLocked[0]?.character.backendManaged).toBe(false);
  });

  it("keeps locked rows grey and unlocks them when progress changes", () => {
    const select = createChatListSelector();
    const books = [book("a", { progress: 0 })];
    const narraBooks = { a: state("a", [character("a", 0.5)]) };
    const first = select(books, narraBooks);
    expect(first.books).toHaveLength(1);
    expect(first.allRows).toHaveLength(1);
    expect(first.allRows[0]?.unlocked).toBe(false);
    const next = select([{ ...books[0], progress: 0.5 }], narraBooks);
    expect(next.books).toBe(first.books);
    expect(next.allRows).toHaveLength(1);
    expect(next.allRows[0]?.unlocked).toBe(true);
  });

  it("reorders existing pages without rebuilding them and removes deleted books", () => {
    const select = createChatListSelector();
    const books = [book("a", { lastOpenedAt: 1 }), book("b", { lastOpenedAt: 2 })];
    const narraBooks = { a: state("a", [character("a")]), b: state("b", [character("b")]) };
    const first = select(books, narraBooks);
    const reordered = select([{ ...books[0], lastOpenedAt: 3 }, books[1]], narraBooks);
    expect(reordered.books.map((item) => item.id)).toEqual(["a", "b"]);
    expect(reordered.rowsByBook).toBe(first.rowsByBook);
    const deleted = select([{ ...books[0], deletedAt: 4 }, books[1]], narraBooks);
    expect(deleted.books.map((item) => item.id)).toEqual(["b"]);
    expect(deleted.rowsByBook.has("a")).toBe(false);
  });

  it("drops cached rows for removed books", () => {
    const select = createChatListSelector();
    const books = [book("a")];
    const data = { a: state("a", [character("a")]) };
    const first = select(books, data);
    select([], {});
    expect(select(books, data).allRows[0]).not.toBe(first.allRows[0]);
  });
});
