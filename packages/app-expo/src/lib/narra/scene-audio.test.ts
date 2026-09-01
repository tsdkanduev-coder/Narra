import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateNarraAudioScenario, parseNarraAudioScenario } from "./scene-audio";
import type { NarraCharacter } from "./types";

vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));
vi.mock("@/stores/narra-store", () => ({
  useNarraStore: { getState: () => ({ narratorVoicePreference: "female" }) },
}));

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
      generateNarraAudioScenario("— Пойдём, — сказал Ши Цян.", [character]),
    ).resolves.toEqual([expect.objectContaining({ speaker: "Ши Цян", text: "Пойдём." })]);

    const [path, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/ai/chat/complete");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      purpose: "structured_task",
      origin: "user",
    });
  });
});

describe("Narra scene audio — резолв героя по словоформам", () => {
  const raskolnikov: NarraCharacter = {
    id: "character:abc",
    name: "Раскольников",
    fullName: "Родион Романович Раскольников",
    aliases: ["Родя"],
    role: "Бывший студент",
    gender: "male",
    voice: "She",
    traits: [],
    speechStyle: "",
    speechExamples: [],
    appearancePrompt: "",
    unlockProgress: 0,
  };
  const sonya: NarraCharacter = {
    ...raskolnikov,
    id: "character:def",
    name: "Соня",
    fullName: "Софья Семёновна Мармеладова",
    aliases: [],
    gender: "female",
    voice: "Che",
  };

  it("не отдаёт реплику рассказчику, если модель назвала героя не по id", () => {
    const segments = parseNarraAudioScenario(
      JSON.stringify([
        { type: "speech", character: "Раскольникова", text: "Я бывший студент." },
        { type: "speech", character: "Родя", text: "Оставь меня." },
        { type: "speech", character: "Мармеладова", text: "Что вы сделали?" },
        { type: "speech", character: "Родион Романович", text: "Ничего." },
      ]),
      [raskolnikov, sonya],
    );

    expect(segments.map((segment) => segment.speaker)).toEqual([
      "Раскольников",
      "Раскольников",
      "Соня",
      "Раскольников",
    ]);
    expect(segments.map((segment) => segment.voice)).toEqual(["She", "She", "Che", "She"]);
  });

  it("оставляет рассказчика, когда имя двусмысленно или незнакомо", () => {
    const twin: NarraCharacter = { ...sonya, id: "character:twin", name: "Мармеладов" };
    const segments = parseNarraAudioScenario(
      JSON.stringify([
        { type: "speech", character: "Мармеладов", text: "Милостивый государь…" },
        { type: "speech", character: "Незнакомец", text: "Кто здесь?" },
      ]),
      [raskolnikov, sonya, twin],
    );

    expect(segments[0]?.speaker).toBe("Мармеладов");
    expect(segments[1]?.speaker).toBe("Рассказчик");
  });
});
