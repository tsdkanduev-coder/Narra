import { completeNarraChat } from "@/lib/ai/narra-chat";
import { setNarraGatewayAdapter } from "@/lib/ai/narra-gateway-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-crypto", () => ({}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

const adapter = vi.fn<(path: string, init: RequestInit) => Promise<Response>>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("completeNarraChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNarraGatewayAdapter(adapter);
  });
  afterEach(() => setNarraGatewayAdapter(null));

  it("posts book_edition_id to /v2/ai/chat/complete", async () => {
    adapter.mockResolvedValueOnce(jsonResponse({ text: "Анна открыла дверь." }));
    await expect(
      completeNarraChat({
        messages: [{ role: "user", content: "Что сказала Анна?" }],
        purpose: "character_chat",
        bookEditionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBe("Анна открыла дверь.");
    expect(adapter).toHaveBeenCalledWith(
      "/v2/ai/chat/complete",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(adapter.mock.calls[0]?.[1]?.body));
    expect(body.book_edition_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.purpose).toBe("character_chat");
  });

  it("preserves SEARCH_NOT_READY so the UI can refuse an off-book answer", async () => {
    adapter.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "Поисковый индекс книги ещё не готов",
          code: "SEARCH_NOT_READY",
          request_id: "req-1",
        },
        409,
      ),
    );
    await expect(
      completeNarraChat({
        messages: [{ role: "user", content: "Что сказала Анна?" }],
        bookEditionId: "book-1",
      }),
    ).rejects.toMatchObject({
      name: "NarraServiceError",
      backendCode: "SEARCH_NOT_READY",
      requestId: "req-1",
    });
  });
});
