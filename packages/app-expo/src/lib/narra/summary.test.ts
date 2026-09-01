import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNarraSummary } from "./summary";

vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));

const EDITION = "11111111-1111-4111-8111-111111111111";

describe("Narra summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts book_edition_id to complete and never calls stream", () => {
    const source = readFileSync(new URL("./summary.ts", import.meta.url), "utf8");
    expect(source).toContain("/v2/ai/chat/complete");
    expect(source).toContain("book_edition_id");
    expect(source).toContain("SEARCH_NOT_READY");
    expect(source).not.toContain("/v2/ai/chat/stream");
  });

  it("requests a spoiler-safe summary for the selected excerpt", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Герои встречаются у окна." }), { status: 200 }),
    );

    await expect(
      generateNarraSummary("Глава 1", "Герои встретились у окна.", "ru", EDITION),
    ).resolves.toBe("Герои встречаются у окна.");

    const [path, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/ai/chat/complete");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      purpose: "summary",
      book_edition_id: EDITION,
      messages: [
        { role: "system" },
        { role: "user", content: "Глава «Глава 1»:\nГерои встретились у окна." },
      ],
    });
  });

  it("does not call complete without a bound edition", async () => {
    await expect(generateNarraSummary("Глава 1", "Герои встретились у окна.")).rejects.toMatchObject({
      backendCode: "SEARCH_NOT_READY",
    });
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });

  it("rejects an empty completion", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "" }), { status: 200 }),
    );

    await expect(generateNarraSummary("Глава", "Текст", "ru", EDITION)).rejects.toThrow(
      "Gateway returned an empty summary",
    );
  });

  it("requests an English summary for the English interface", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "The characters meet by the window." }), { status: 200 }),
    );

    await generateNarraSummary("Chapter 1", "The characters met by the window.", "en", EDITION);

    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    const payload = JSON.parse(String(request?.body));
    expect(payload.messages[0].content).toContain("in English");
    expect(payload.messages[1].content).toBe(
      "Chapter “Chapter 1”:\nThe characters met by the window.",
    );
  });
});
