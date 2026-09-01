import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNarraAudioScenario, parseNarraAudioScenario } from "./scene-audio";
import type { NarraCharacter } from "./types";

vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));
vi.mock("@/stores/narra-store", () => ({
  useNarraStore: { getState: () => ({ narratorVoicePreference: "female" }) },
}));

const EDITION = "11111111-1111-4111-8111-111111111111";

const character: NarraCharacter = {
  id: "shi-qiang",
  name: "Ши Цян",
  fullName: "Ши Цян",
  role: "Следователь",
  gender: "male",
  voice: "Che",
  traits: ["прямолинейный"],
  speechStyle: "резкий",
  speechExamples: [],
  appearancePrompt: "",
  unlockProgress: 0,
};

describe("Narra scene audio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts book_edition_id to complete and never calls stream", () => {
    const source = readFileSync(new URL("./scene-audio.ts", import.meta.url), "utf8");
    expect(source).toContain("/v2/ai/chat/complete");
    expect(source).toContain("book_edition_id");
    expect(source).toContain("SEARCH_NOT_READY");
    expect(source).not.toContain("/v2/ai/chat/stream");
  });

  it("matches character names and uses the narrator for unknown speakers", () => {
    const segments = parseNarraAudioScenario(
      '```json\n[{"type":"speech","character":"Ши Цян","text":"Пойдём."},{"type":"narration","character":null,"text":"Они вышли."},{"type":"speech","character":"unknown","text":"Стойте."}]\n```',
      [character],
    );

    expect(segments).toEqual([
      expect.objectContaining({ characterId: "shi-qiang", speaker: "Ши Цян", voice: "Che" }),
      // Нарратор по настройке пользователя (женский дефолт — Афина).
      expect.objectContaining({ characterId: null, speaker: "Рассказчик", voice: "Che" }),
      expect.objectContaining({ characterId: null, speaker: "Рассказчик", voice: "Che" }),
    ]);
  });

  it("requests a verbatim structured scenario", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          text: '[{"type":"speech","character":"shi-qiang","text":"Пойдём."}]',
        }),
        { status: 200 },
      ),
    );

    await expect(
      generateNarraAudioScenario("— Пойдём, — сказал Ши Цян.", [character], EDITION),
    ).resolves.toEqual([expect.objectContaining({ speaker: "Ши Цян", text: "Пойдём." })]);

    const [path, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/ai/chat/complete");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      purpose: "structured_task",
      origin: "user",
      book_edition_id: EDITION,
    });
  });

  it("does not call complete without a bound edition", async () => {
    await expect(
      generateNarraAudioScenario("— Пойдём, — сказал Ши Цян.", [character]),
    ).rejects.toMatchObject({
      backendCode: "SEARCH_NOT_READY",
    });
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });
});
