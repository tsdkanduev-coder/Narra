import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  new URL("../../screens/reader/ReaderContentsPanel.tsx", import.meta.url),
  "utf8",
);
const sheet = readFileSync(
  new URL("../../screens/reader/reader-toc-sheet-screen.tsx", import.meta.url),
  "utf8",
);

describe("Apple Books contents panel", () => {
  it("keeps TOC, bookmarks and search in one ☰ sheet; themes stay on Aa", () => {
    expect(panel).toContain('key: "toc"');
    expect(panel).toContain('key: "bookmarks"');
    expect(panel).toContain('key: "search"');
    expect(sheet).toContain("ReaderContentsPanel");
    expect(sheet).toContain('t("reader.contents", "Содержание")');
  });

  it("shows no-results after a query, not the empty-query hint", () => {
    expect(panel).toContain('t("reader.searchNoResults", "Ничего не найдено")');
    expect(panel).toContain("session.search.query.trim()");
    expect(panel).toContain('t("reader.searchEmptyHint"');
  });
});
