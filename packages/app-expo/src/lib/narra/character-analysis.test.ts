import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import { getChunks } from "@readany/core/db/database";
import type { Book } from "@readany/core/types";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeBookCharacters } from "./character-analysis";

const store = vi.hoisted(() => ({
  setAnalyzing: vi.fn(),
  setAnalysisError: vi.fn(),
  setCharacters: vi.fn(),
  getBookState: vi.fn(),
  appendChatMessage: vi.fn(),
  setMemory: vi.fn(),
  books: {} as Record<string, { backendBinding?: { bookEditionId: string } }>,
}));

vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));
vi.mock("@/lib/analytics/telemetry", () => ({ recordTelemetry: vi.fn() }));
vi.mock("@/stores/narra-store", () => ({
  useNarraStore: { getState: () => store },
}));
vi.mock("@readany/core/db/database", () => ({ getChunks: vi.fn() }));

const EDITION = "11111111-1111-4111-8111-111111111111";

const book = {
  id: "book-1",
  bookEditionId: EDITION,
  meta: { title: "Тестовая книга", author: "Автор" },
} as Book;

function successfulCharacterResponse() {
  return new Response(
    JSON.stringify({
      text: JSON.stringify({
        genre: {
          primary: "fanfiction",
          secondary: ["romance"],
          confidence: 0.94,
          evidence: "Персонажи публичных людей в вымышленном сюжете",
        },
        characters: [{ name: "Анна", fullName: "Анна", unlockProgress: 0.1 }],
      }),
    }),
    { status: 200 },
  );
}

describe("Narra character analysis", () => {
  it("posts structured analysis to complete with book_edition_id, not stream", () => {
    const source = readFileSync(new URL("./character-analysis.ts", import.meta.url), "utf8");
    expect(source).toContain("/v2/ai/chat/complete");
    expect(source).toContain("book_edition_id");
    expect(source).toContain("resolveAnalysisBookEditionId");
    expect(source).not.toContain("/v2/ai/chat/stream");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__DEV__", false);
    vi.mocked(narraGatewayRequest).mockResolvedValue(successfulCharacterResponse());
    store.books = {};
  });

  it("uses existing chunks before asking for a text fallback", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава из базы", content: "Анна вошла в комнату." },
    ] as Awaited<ReturnType<typeof getChunks>>);
    const fallback = vi.fn(async () => "Текст из WebView");

    await analyzeBookCharacters(book, fallback);

    expect(fallback).not.toHaveBeenCalled();
    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body));
    expect(narraGatewayRequest).toHaveBeenCalledWith(
      "/v2/ai/chat/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(body.book_edition_id).toBe(EDITION);
    expect(body.purpose).toBe("structured_task");
    expect(body.messages[1].content).toContain("Глава из базы\nАнна вошла в комнату.");
    expect(body.messages[1].content).not.toContain("Текст из WebView");
    expect(request?.headers).not.toMatchObject({ accept: "text/event-stream" });
  });

  it("does not call stream and refuses analysis without a book edition", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Текст" },
    ] as Awaited<ReturnType<typeof getChunks>>);
    const unbound = { id: "local-1", meta: { title: "Локальная", author: "Автор" } } as Book;

    await expect(analyzeBookCharacters(unbound)).rejects.toMatchObject({
      backendCode: "SEARCH_NOT_READY",
      message: expect.stringContaining("SEARCH_NOT_READY"),
    });
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });

  it("takes book_edition_id from the backend binding when the library book has none", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Анна вошла в комнату." },
    ] as Awaited<ReturnType<typeof getChunks>>);
    store.books = { "local-1": { backendBinding: { bookEditionId: EDITION } } };
    const unbound = { id: "local-1", meta: { title: "Локальная", author: "Автор" } } as Book;

    await analyzeBookCharacters(unbound);

    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body)).book_edition_id).toBe(EDITION);
  });

  it("keeps SEARCH_NOT_READY from complete so analysis cannot answer off-book", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Текст" },
    ] as Awaited<ReturnType<typeof getChunks>>);
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "SEARCH_NOT_READY",
          error: "Поисковый индекс книги ещё не готов",
          request_id: "req-analysis",
        }),
        { status: 409 },
      ),
    );

    await expect(analyzeBookCharacters(book)).rejects.toMatchObject({
      backendCode: "SEARCH_NOT_READY",
      requestId: "req-analysis",
    });
    expect(store.setAnalysisError).toHaveBeenLastCalledWith(
      book.id,
      expect.stringContaining("SEARCH_NOT_READY"),
    );
  });

  it("asks for appearance and age from the book text, not from adaptations", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Текст" },
    ] as Awaited<ReturnType<typeof getChunks>>);

    await analyzeBookCharacters(book);

    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    const systemPrompt = String(JSON.parse(String(request?.body)).messages[0].content);
    for (const field of [
      "appearancePrompt",
      "passport",
      "age",
      "build",
      "hair",
      "eyes",
      "face",
      "outfit",
    ]) {
      expect(systemPrompt).toContain(field);
    }
    expect(systemPrompt).toContain("экранизаци");
    expect(systemPrompt).toContain("primary и secondary выбирай только из");
    expect(systemPrompt).toContain("реальных публичных людей");
    expect(store.setCharacters).toHaveBeenCalledWith(
      book.id,
      expect.any(Array),
      expect.objectContaining({ primary: "fanfiction", secondary: ["romance"] }),
    );
  });

  it("loads and bounds a fallback sample when chunks are unavailable", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([]);
    const fallback = vi.fn(async () => "Начало ".repeat(10_000));

    await analyzeBookCharacters(book, fallback);

    expect(fallback).toHaveBeenCalledOnce();
    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body));
    const userContent = String(body.messages[1].content);
    const excerpt = userContent.slice(userContent.indexOf("\n\n") + 2);
    expect(excerpt.length).toBeLessThanOrEqual(48_000);
    expect(excerpt).toContain("[…]");
  });

  it("reads an error body without cloning the response", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Текст" },
    ] as Awaited<ReturnType<typeof getChunks>>);
    const response = new Response(JSON.stringify({ error: "Сервис недоступен" }), { status: 503 });
    const clone = vi.spyOn(response, "clone");
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response);

    await expect(analyzeBookCharacters(book)).rejects.toThrow();

    expect(clone).not.toHaveBeenCalled();
  });

  it("does not present an upstream provider rejection as installation authorization", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Текст" },
    ] as Awaited<ReturnType<typeof getChunks>>);
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "AUTH",
          error: "openrouter 403: Access denied by security policy",
          request_id: "5dfc919d-f119-4b2b-b46b-5fa4c657abca",
        }),
        { status: 502 },
      ),
    );

    await expect(analyzeBookCharacters(book)).rejects.toMatchObject({
      code: "SERVICE",
      message: "AI-провайдер Narra сейчас недоступен. Попробуйте немного позже.",
      requestId: "5dfc919d-f119-4b2b-b46b-5fa4c657abca",
      technicalDetail: expect.stringContaining("openrouter 403"),
    });
    expect(store.setAnalysisError).toHaveBeenLastCalledWith(
      book.id,
      "AI-провайдер Narra сейчас недоступен. Попробуйте немного позже.",
    );
  });

  it("sends gateway-compatible analytics for background analysis", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Анна вошла в комнату." },
    ] as Awaited<ReturnType<typeof getChunks>>);

    await analyzeBookCharacters(book, undefined, { origin: "background" });

    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      origin: "background",
      analytics_tier: "none",
      book_edition_id: EDITION,
    });
    expect(vi.mocked(recordTelemetry)).toHaveBeenCalledWith(
      "book_analysis_started",
      expect.objectContaining({ origin: "background" }),
    );
  });

  it("reuses an active analysis for the same book", async () => {
    vi.mocked(getChunks).mockResolvedValueOnce([
      { chapterTitle: "Глава", content: "Анна вошла в комнату." },
    ] as Awaited<ReturnType<typeof getChunks>>);

    const first = analyzeBookCharacters(book);
    const second = analyzeBookCharacters(book);

    expect(second).toBe(first);
    await first;
    expect(narraGatewayRequest).toHaveBeenCalledOnce();
  });
});
