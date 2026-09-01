import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReaderStore } from "@/stores/reader-store";

import {
  formatCharacterPromptLocation,
  liveReaderPosition,
  publishLiveReaderProgress,
  resolveCharacterPromptContext,
} from "./character-chat-progress";

describe("character-chat-progress", () => {
  afterEach(() => {
    useReaderStore.setState({ tabs: {} });
    vi.restoreAllMocks();
  });

  it("не считает читалку открытой без CFI — как publishCharacterProgress", () => {
    useReaderStore.getState().initTab("book-1", "book-1");
    expect(liveReaderPosition("book-1")).toBeNull();
    expect(publishLiveReaderProgress("book-1", vi.fn())).toBe(false);
  });

  it("отдаёт живую позицию, если вкладка читалки знает CFI", () => {
    const store = useReaderStore.getState();
    store.initTab("book-1", "book-1");
    store.setProgress("book-1", 0.42, "epubcfi(/6/8!/4/2/2/1:0)");
    store.setChapter("book-1", 3, "Глава III");

    expect(liveReaderPosition("book-1")).toEqual({
      progress: 0.42,
      currentCfi: "epubcfi(/6/8!/4/2/2/1:0)",
      chapterTitle: "Глава III",
    });
    expect(liveReaderPosition("other-book")).toBeNull();
  });

  it("publishLiveReaderProgress пишет в библиотеку только progress и currentCfi", () => {
    const store = useReaderStore.getState();
    store.initTab("book-1", "book-1");
    store.setProgress("book-1", 0.5, "epubcfi(/6/10!/4)");

    const updateBook = vi.fn().mockResolvedValue(undefined);
    expect(publishLiveReaderProgress("book-1", updateBook)).toBe(true);
    expect(updateBook).toHaveBeenCalledWith("book-1", {
      progress: 0.5,
      currentCfi: "epubcfi(/6/10!/4)",
    });
  });

  it("без updateBook не пишет — каталожный мок @/stores без метода не падает", () => {
    const store = useReaderStore.getState();
    store.initTab("book-1", "book-1");
    store.setProgress("book-1", 0.5, "epubcfi(/6/10!/4)");
    expect(publishLiveReaderProgress("book-1")).toBe(false);
  });

  it("resolveCharacterPromptContext берёт живой CFI/главу, иначе library", () => {
    expect(
      resolveCharacterPromptContext("book-1", {
        progress: 0.1,
        currentCfi: "epubcfi(/6/2!/4)",
      }),
    ).toEqual({
      progress: 0.1,
      location: { currentCfi: "epubcfi(/6/2!/4)", chapter: undefined },
    });

    const store = useReaderStore.getState();
    store.initTab("book-1", "book-1");
    store.setProgress("book-1", 0.8, "epubcfi(/6/20!/4)");
    store.setChapter("book-1", 8, "Глава VIII");

    expect(
      resolveCharacterPromptContext("book-1", {
        progress: 0.1,
        currentCfi: "epubcfi(/6/2!/4)",
      }),
    ).toEqual({
      progress: 0.8,
      location: { currentCfi: "epubcfi(/6/20!/4)", chapter: "Глава VIII" },
    });
  });

  it("formatCharacterPromptLocation добавляет главу и CFI, пустые поля пропускает", () => {
    expect(formatCharacterPromptLocation("ru")).toBe("");
    expect(
      formatCharacterPromptLocation("ru", {
        chapter: "Часть первая. Глава I",
        currentCfi: "epubcfi(/6/4!/4)",
      }),
    ).toBe("Сейчас глава «Часть первая. Глава I». Текущая позиция в книге: epubcfi(/6/4!/4).");
    expect(formatCharacterPromptLocation("en", { currentCfi: "epubcfi(/6/4!/4)" })).toBe(
      "Current position in the book: epubcfi(/6/4!/4).",
    );
  });

  it("Мой путь публикует живую позицию; промпт берёт CFI и главу", () => {
    const chats = readFileSync(new URL("../../screens/ChatsScreen.tsx", import.meta.url), "utf8");
    const prompt = readFileSync(
      new URL("../../screens/NarraCharacterChatScreen.tsx", import.meta.url),
      "utf8",
    );
    const reader = readFileSync(new URL("../../screens/ReaderScreen.tsx", import.meta.url), "utf8");
    expect(chats).toContain("publishLiveReaderProgress");
    expect(prompt).toContain("formatCharacterPromptLocation");
    expect(prompt).toContain("resolveCharacterPromptContext");
    expect(reader).toContain("initTab(bookId, bookId)");
    expect(reader).toContain("setProgress(bookId, absoluteFraction, detail.cfi)");
  });
});
