import { describe, expect, it } from "vitest";
import {
  NarraServiceError,
  emptyBookSearchCode,
  normalizeNarraError,
  searchNotReadyCode,
} from "./errors";

describe("Narra error messages", () => {
  it("separates book extraction failures from generic service failures", () => {
    expect(
      normalizeNarraError(new Error("TypeError: Load failed while extracting a book text sample")),
    ).toMatchObject({
      code: "REQUEST",
      message: "Не удалось прочитать текст книги. Попробуйте снова.",
    });
  });

  it("explains when the character response cannot be used", () => {
    expect(
      normalizeNarraError(new Error("Narra found no characters in the response")),
    ).toMatchObject({
      code: "SERVICE",
      message: "Сервис не распознал персонажей в ответе. Попробуйте снова.",
    });
  });

  it("explains a provider safety rejection", () => {
    expect(
      normalizeNarraError(
        new Error("Kandinsky: запрос или результат отклонён политикой безопасности"),
      ),
    ).toMatchObject({
      code: "SERVICE",
      message: "Сервис отклонил эту сцену по правилам безопасности. Попробуйте другую страницу.",
    });
  });

  it("keeps SEARCH_NOT_READY visible and does not fall back to a generic service line", () => {
    const fromCode = normalizeNarraError(
      new NarraServiceError("SERVICE", "index", undefined, undefined, "SEARCH_NOT_READY"),
    );
    expect(fromCode.backendCode).toBe("SEARCH_NOT_READY");
    expect(fromCode.message).toContain("SEARCH_NOT_READY");
    expect(fromCode.message).toContain("без книги недоступен");
    expect(searchNotReadyCode(fromCode)).toBe("SEARCH_NOT_READY");

    const fromText = normalizeNarraError(new Error("SEMANTIC_SEARCH_NOT_READY"));
    expect(fromText.backendCode).toBe("SEMANTIC_SEARCH_NOT_READY");
    expect(fromText.message).toContain("SEMANTIC_SEARCH_NOT_READY");
  });

  it("keeps empty book search as Ничего не найдено instead of a generic service line", () => {
    const empty = normalizeNarraError(
      new NarraServiceError("SERVICE", "index", undefined, undefined, "SEARCH_EMPTY"),
    );
    expect(empty.backendCode).toBe("SEARCH_EMPTY");
    expect(empty.message).toBe("Ничего не найдено");
    expect(emptyBookSearchCode(empty)).toBe("SEARCH_EMPTY");
  });
});
