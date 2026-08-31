import { describe, expect, it } from "vitest";
import { selectReadingNowBooks } from "./reading-now-books";
import type { Book } from "@readany/core/types";

function book(overrides: Partial<Book> & Pick<Book, "id">): Book {
  return {
    meta: { title: overrides.id, author: "" },
    progress: 0,
    ...overrides,
  } as Book;
}

describe("selectReadingNowBooks", () => {
  it("берёт только начатые и не дочитанные, свежие сверху", () => {
    const selected = selectReadingNowBooks([
      book({ id: "done", progress: 1, lastOpenedAt: 30 }),
      book({ id: "fresh", progress: 0.4, lastOpenedAt: 20 }),
      book({ id: "old", progress: 0.1, lastOpenedAt: 10 }),
      book({ id: "new", progress: 0, lastOpenedAt: 40 }),
      book({ id: "deleted", progress: 0.5, lastOpenedAt: 50, deletedAt: 1 }),
    ]);
    expect(selected.map((item) => item.id)).toEqual(["fresh", "old"]);
  });
});
