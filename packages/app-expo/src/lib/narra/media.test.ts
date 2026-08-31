import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NarraCharacter } from "./types";

const appStoreState = vi.hoisted(() => ({
  libraryBooks: [] as Array<{
    id: string;
    meta: { title: string; author?: string; subjects?: string[]; description?: string };
  }>,
  narraBooks: {} as Record<
    string,
    {
      genre?: {
        primary: "fanfiction";
        secondary: ["romance"];
        confidence: number;
        evidence: string;
      };
    }
  >,
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  EncodingType: { Base64: "base64" },
  getInfoAsync: vi.fn(async () => ({ exists: true, size: 46 })),
  makeDirectoryAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  deleteAsync: vi.fn(async () => {}),
  moveAsync: vi.fn(),
}));
vi.mock("@/lib/ai/narra-gateway-fetch", async () => {
  const { withGatewayConsumer } = await import("@/lib/ai/narra-gateway-consumer");
  const request = vi.fn();
  return {
    narraGatewayRequest: request,
    consumeNarraGatewayResponse: (
      path: string,
      init: RequestInit,
      consume: (
        response: Response,
        scope: import("@/lib/ai/narra-gateway-consumer").GatewayConsumerScope,
      ) => Promise<unknown>,
    ) =>
      withGatewayConsumer(
        async (scope) => consume(await request(path, { ...init, signal: scope.signal }), scope),
        { signal: init.signal, timeoutMs: 60_000 },
      ),
  };
});
vi.mock("@/lib/analytics/telemetry", () => ({ recordTelemetry: vi.fn() }));
vi.mock("@/config/bundled-ai", () => ({
  getBundledApiKey: vi.fn(() => "test-openrouter-key"),
  hasBundledOpenRouterKey: true,
}));

const speechFetchMock = vi.hoisted(() => vi.fn());
vi.mock("expo/fetch", () => ({ fetch: speechFetchMock }));
vi.mock("@/stores", () => ({
  useLibraryStore: { getState: () => ({ books: appStoreState.libraryBooks }) },
  useNarraStore: { getState: () => ({ books: appStoreState.narraBooks }) },
}));

import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import { ART_STYLE, PROMPT_CHAR_LIMIT, budgetPrompt } from "./art-style";
import {
  buildFanartPortraitPrompt,
  buildNarraSpeechSsml,
  buildSafetyFallbackSceneImagePrompt,
  buildSceneImagePrompt,
  generateBookCoverImage,
  generateCharacterPortrait,
  generateSceneImage,
  normalizePersistedNarraMediaUri,
  portraitPrompt,
  resolvePortraitGenre,
  synthesizeNarraBookSpeech,
  synthesizeNarraSpeech,
} from "./media";
import { PORTRAIT_PROMPT_CHAR_LIMIT, buildCharacterPortraitPrompt } from "./portrait-prompt";
import { applyActiveStressMarkup, primeCharacterStressForms } from "./stress-markup";

beforeEach(() => {
  vi.clearAllMocks();
  appStoreState.libraryBooks.length = 0;
  for (const bookId of Object.keys(appStoreState.narraBooks)) {
    delete appStoreState.narraBooks[bookId];
  }
});

const anna: NarraCharacter = {
  id: "anna",
  name: "Анна",
  fullName: "Анна Каренина",
  role: "Главная героиня",
  gender: "female",
  voice: "Che",
  traits: ["искренняя"],
  speechStyle: "эмоциональная",
  speechExamples: [],
  appearancePrompt: "аристократичная женщина",
  passport: {
    age: 28,
    gender: "female",
    build: "стройная",
    hair: "тёмные волосы",
    eyes: "серые глаза",
    face: "овальное лицо",
    outfit: "чёрное платье XIX века",
  },
  unlockProgress: 0,
};

const vronsky: NarraCharacter = {
  ...anna,
  id: "vronsky",
  name: "Вронский",
  fullName: "Алексей Вронский",
  gender: "male",
  passport: {
    age: 30,
    gender: "male",
    build: "атлетичный",
    hair: "светлые волосы",
    eyes: "голубые глаза",
    face: "правильные черты",
    outfit: "мундир XIX века",
  },
};

describe("portrait prompt", () => {
  it("follows the narra canon, genre and portrait framing", () => {
    const prompt = portraitPrompt(anna);

    expect(prompt).toContain("Вертикальный портрет до талии в среднем плане, строго анфас");
    expect(prompt).toContain("Камера отдалена");
    expect(prompt).toContain("лицо не доминирует в кадре");
    expect(prompt).toContain("ровно 10% высоты кадра");
    expect(prompt).toContain("По сторонам плеч остаётся спокойное свободное пространство");
    expect(prompt).toContain("Не делать headshot");
    expect(prompt).not.toContain("55%");
    expect(prompt).toContain("классический живописный портрет");
    expect(prompt).toContain("Внешность (соблюдать точно):");
    expect(prompt).toContain("тёмные волосы");
    expect(prompt).not.toContain("semi-realistic anime");
    expect(prompt).toContain(ART_STYLE);
    expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(PORTRAIT_PROMPT_CHAR_LIMIT);
  });

  it("demands exactly one named person first and keeps it within budget", () => {
    const prompt = portraitPrompt(vronsky);

    expect(prompt.startsWith("Ровно один человек в кадре — Алексей Вронский, никого больше")).toBe(
      true,
    );
    expect(prompt).toContain("без второстепенных персонажей");
    expect(prompt.length).toBeLessThanOrEqual(PORTRAIT_PROMPT_CHAR_LIMIT);

    const verbose: NarraCharacter = {
      ...vronsky,
      appearancePrompt: `статный офицер, ${"выразительные детали мундира и осанки, ".repeat(40)}`,
    };
    const longPrompt = portraitPrompt(verbose, "«Анна Каренина» (Лев Толстой)");
    expect(longPrompt).toContain("Ровно один человек в кадре — Алексей Вронский");
    expect(longPrompt).toContain("классический живописный портрет");
    expect(longPrompt.length).toBeLessThanOrEqual(PORTRAIT_PROMPT_CHAR_LIMIT);
  });

  it("adds the non-sexual female body direction only for adult manga and fanfiction heroines", () => {
    const fanfictionPrompt = portraitPrompt(
      anna,
      "«Фанфик»",
      "fanfiction",
      "fanfiction or transformative fiction",
    );
    const mangaPrompt = portraitPrompt(anna, "«Манга»", "manga", "manga");
    const classicPrompt = portraitPrompt(anna);
    const malePrompt = portraitPrompt(vronsky);
    const withoutPassportPrompt = portraitPrompt({ ...anna, passport: undefined });
    const minorPrompt = portraitPrompt({
      ...anna,
      passport: anna.passport ? { ...anna.passport, age: 17 } : undefined,
    });

    expect(fanfictionPrompt).toContain("огромной грудью");
    expect(fanfictionPrompt).toContain("под полностью закрытой одеждой");
    expect(fanfictionPrompt).toContain("строго несексуализированный");
    expect(mangaPrompt).toContain("огромной грудью");
    expect(classicPrompt).not.toContain("огромной грудью");
    expect(withoutPassportPrompt).not.toContain("огромной грудью");
    expect(minorPrompt).not.toContain("огромной грудью");
    expect(malePrompt).not.toContain("огромной грудью");
  });

  it("keeps the genre restriction with an explicit adult override", () => {
    const catalogHeroine = { ...anna, passport: undefined };
    const classicPrompt = buildCharacterPortraitPrompt(catalogHeroine, {
      bookContext: "«Анна Каренина» (Лев Толстой)",
      assumeAdultFemale: true,
    });
    const mangaPrompt = buildCharacterPortraitPrompt(catalogHeroine, {
      bookContext: "«Манга»",
      genreId: "manga",
      genreLabel: "манга",
      assumeAdultFemale: true,
    });

    expect(classicPrompt).not.toContain("огромной грудью");
    expect(mangaPrompt).toContain("огромной грудью");
  });

  it("routes character portraits through the gateway on the OpenRouter engine", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ image: "AQID", mime_type: "image/jpeg" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(generateCharacterPortrait("book-1", anna)).resolves.toContain(
      "book-1-anna-portrait.jpg",
    );

    const [path, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/media/images");
    expect(JSON.parse(String(request?.body))).toEqual({
      prompt: expect.stringContaining("Анна Каренина"),
      width: 768,
      height: 1024,
      engine: "openrouter",
    });
  });

  it("prefers the persisted LLM genre for a character portrait", () => {
    const genre = resolvePortraitGenre(
      { title: "Запятая" },
      {
        primary: "fanfiction",
        secondary: ["romance"],
        confidence: 0.94,
        evidence: "Публичные люди в новом вымышленном сюжете",
      },
    );
    const prompt = portraitPrompt(anna, "«Запятая» (Gooos)", genre.id, genre.label);

    expect(prompt).toContain("жанра «фанфик или трансформативная проза»");
    expect(prompt).toContain("полуреалистичная аниме-иллюстрация момента");
  });
});

describe("P1 acceptance: fanart portrait, scene and cover", () => {
  it("собирает три промпта короче 950 знаков со стилем целиком", () => {
    const excerpt = `Анна вошла в зал. ${"Свет свечей дрожал на паркете, гости расступались. ".repeat(60)}`;
    const portrait = buildFanartPortraitPrompt(anna);
    const scene = buildSceneImagePrompt("Бал", excerpt, [anna, vronsky]);
    const cover = budgetPrompt([
      "Обложка книги «Анна Каренина».",
      "Автор: Лев Толстой.",
      `Тема: ${"Роман о семье, любви и давлении общества. ".repeat(30)}`,
      "Вертикальная книжная обложка, единая серия с портретами и сценами героев.",
    ]);

    for (const prompt of [portrait, scene, cover]) {
      expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_LIMIT);
      expect(prompt).toContain(ART_STYLE);
      expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
    }
  });
});

describe("scene image prompt", () => {
  it("fits the Kandinsky budget with the full style on a long excerpt", () => {
    const excerpt = `Анна вошла в зал. ${"Свет свечей дрожал на паркете, гости расступались. ".repeat(60)}`;
    const prompt = buildSceneImagePrompt("Бал", excerpt, [anna, vronsky]);

    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_LIMIT);
    expect(prompt).toContain(ART_STYLE);
    expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
    expect(prompt).toContain("Анна Каренина");
  });

  it("adds passport canon only for characters mentioned in the excerpt", () => {
    const prompt = buildSceneImagePrompt("Бал", "Анна вошла в зал и остановилась у двери.", [
      anna,
      vronsky,
    ]);

    expect(prompt).toContain("Анна Каренина");
    expect(prompt).toContain("тёмные волосы");
    expect(prompt).not.toContain("Алексей Вронский");
    expect(prompt).toContain("Не добавляй отсутствующих героев");
  });

  it("routes square scene illustrations through Kandinsky", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "stop after request inspection" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(generateSceneImage("book-1", "Бал", "Анна вошла в зал.", [anna])).rejects.toThrow(
      "stop after request inspection",
    );

    const [, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      width: 1024,
      height: 1024,
      engine: "kandinsky",
    });
  });

  it("retries a safety rejection with a neutral visual prompt", async () => {
    vi.mocked(narraGatewayRequest)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Kandinsky: запрос или результат отклонён политикой безопасности",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "fallback inspected" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );

    const excerpt = [
      "— Мы должны продолжать борьбу!",
      "— Восстание откроет миру глаза.",
      "Ван поднял глаза. Мир стал черно-белым, и в зал вошла Е Вэньцзе.",
      "Окруженная спутниками, она остановилась посередине прохода.",
    ].join("\n");

    await expect(generateSceneImage("book-1", "Отступники", excerpt, [])).rejects.toThrow(
      "fallback inspected",
    );

    expect(narraGatewayRequest).toHaveBeenCalledTimes(2);
    const [, fallbackRequest] = vi.mocked(narraGatewayRequest).mock.calls[1] ?? [];
    const fallbackPrompt = JSON.parse(String(fallbackRequest?.body)).prompt as string;
    expect(fallbackPrompt).toContain("Ван поднял глаза");
    expect(fallbackPrompt).not.toContain("борьбу");
    expect(fallbackPrompt).not.toContain("Восстание");
  });

  it("builds a neutral fallback from narration while keeping character canon", () => {
    const prompt = buildSafetyFallbackSceneImagePrompt(
      "— Поднять восстание!\nАнна вошла в зал и спокойно остановилась у двери.",
      [anna],
    );

    expect(prompt).toContain("Анна Каренина");
    expect(prompt).toContain("Анна вошла в зал");
    expect(prompt).not.toContain("восстание");
    expect(prompt).toContain("Не добавляй отсутствующих героев и лишних людей");
  });
});

describe("book cover generation", () => {
  it("routes covers through the gateway and records telemetry", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          job_id: "b42e5309-0d9f-49b3-89cf-87fc08ee381b",
          status: "completed",
          image: "aGVsbG8=",
          mime_type: "image/jpeg",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(
      generateBookCoverImage(
        { book: { title: "Книга" } },
        { requestId: "request-1", onJob: vi.fn() },
      ),
    ).resolves.toEqual({
      base64: "aGVsbG8=",
      mimeType: "image/jpeg",
      jobId: "b42e5309-0d9f-49b3-89cf-87fc08ee381b",
    });

    const [path, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/media/cover/jobs");
    expect(JSON.parse(String(request?.body))).toEqual({
      book: { title: "Книга" },
      request_id: "request-1",
    });
    expect(recordTelemetry).toHaveBeenCalledWith(
      "media_job_enqueued",
      expect.objectContaining({
        job_type: "cover",
        provider: "openrouter",
        model: "gpt-image-2",
        origin: "background",
      }),
    );
    expect(recordTelemetry).toHaveBeenCalledWith(
      "media_job_completed",
      expect.objectContaining({ job_type: "cover", origin: "background" }),
    );
  });

  it("surfaces the gateway error and reports a failed cover job", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Лимит на сегодня исчерпан" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      generateBookCoverImage(
        { book: { title: "Книга" } },
        { requestId: "request-1", onJob: vi.fn() },
      ),
    ).rejects.toThrow("Лимит на сегодня исчерпан");

    expect(recordTelemetry).toHaveBeenCalledWith(
      "media_job_failed",
      expect.objectContaining({ job_type: "cover", origin: "background" }),
    );
  });
});

describe("persisted Narra media URI", () => {
  it("moves an iOS URI from an old app container into the current document directory", () => {
    expect(
      normalizePersistedNarraMediaUri(
        "file:///var/mobile/Containers/Data/Application/OLD/Documents/narra-media/book-hero.png",
      ),
    ).toBe("file:///documents/narra-media/book-hero.png");
  });

  it("leaves remote and unrelated local URIs untouched", () => {
    expect(normalizePersistedNarraMediaUri("https://cdn.example/hero.png")).toBe(
      "https://cdn.example/hero.png",
    );
    expect(normalizePersistedNarraMediaUri("file:///documents/covers/book.png")).toBe(
      "file:///documents/covers/book.png",
    );
  });
});

describe("speech SSML (просодия и скорость)", () => {
  it("returns null for default rate and pitch — plain text synthesis", () => {
    expect(buildNarraSpeechSsml("Привет.")).toBeNull();
    expect(buildNarraSpeechSsml("Привет.", {}, 1)).toBeNull();
  });

  it("multiplies user rate by character prosody and converts pitch to percent", () => {
    expect(buildNarraSpeechSsml("Привет.", { pitch: 2, rate: 0.9 }, 1.5)).toBe(
      '<speak><prosody rate="135%" pitch="+8%">Привет.</prosody></speak>',
    );
    expect(buildNarraSpeechSsml("Привет.", { pitch: -2 })).toBe(
      '<speak><prosody rate="100%" pitch="-8%">Привет.</prosody></speak>',
    );
  });

  it("clamps extreme values and escapes XML", () => {
    const ssml = buildNarraSpeechSsml('Он сказал: "меньше & лучше" <тихо>.', { pitch: 20 }, 3);
    expect(ssml).toContain('rate="200%"');
    expect(ssml).toContain('pitch="+40%"');
    expect(ssml).toContain("&quot;меньше &amp; лучше&quot; &lt;тихо&gt;");
  });

  it("экранирует апостроф-ударение как &apos;, не ломая теги", () => {
    const marked = applyActiveStressMarkup("Базаров звонит");
    expect(marked).toBe("База'ров звони'т");
    const ssml = buildNarraSpeechSsml(marked, { pitch: 2 });
    expect(ssml).toBe(
      '<speak><prosody rate="100%" pitch="+8%">База&apos;ров звони&apos;т</prosody></speak>',
    );
  });
});

describe("synthesizeNarraSpeech — разметка ударений (P9)", () => {
  beforeEach(() => {
    vi.stubEnv("EXPO_PUBLIC_NARRA_TTS_PROVIDER", "gateway");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    primeCharacterStressForms([]);
  });

  it("применяет активный словарь к тексту запроса в /v2/speech/synthesize", async () => {
    primeCharacterStressForms([{ ...anna, stressedName: "А'нна" }]);
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "stop after request inspection" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(synthesizeNarraSpeech("Анна звонит Хлестакову.", "Che")).rejects.toThrow(
      "stop after request inspection",
    );

    const [path, request] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/speech/synthesize");
    expect(JSON.parse(String(request?.body))).toEqual({
      text: "А'нна звони'т Хлестако'ву.",
      voice: "Che",
    });
  });
});

describe("speech telemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records first-audio readiness from the gateway sample-rate contract", async () => {
    vi.stubEnv("EXPO_PUBLIC_NARRA_TTS_PROVIDER", "gateway");
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "x-audio-sample-rate": "48000" },
      }),
    );

    await expect(synthesizeNarraSpeech("Привет", "Che")).resolves.toContain(
      "file:///documents/narra-media/speech-",
    );

    expect(recordTelemetry).toHaveBeenCalledWith(
      "tts_first_audio_ready",
      expect.objectContaining({ sample_rate: 48_000, origin: "user" }),
    );
  });
});

describe("synthesizeNarraSpeech — Grok TTS через OpenRouter", () => {
  beforeEach(() => {
    speechFetchMock.mockReset();
    primeCharacterStressForms([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    primeCharacterStressForms([]);
  });

  function audioResponse(): Response {
    return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  }

  it("идёт в OpenRouter по умолчанию, минуя гейтвей", async () => {
    speechFetchMock.mockResolvedValueOnce(audioResponse());

    await expect(synthesizeNarraSpeech("Привет", "Che")).resolves.toContain(
      "file:///documents/narra-media/speech-",
    );

    expect(narraGatewayRequest).not.toHaveBeenCalled();
    const [url, request] = speechFetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "x-ai/grok-voice-tts-1.0",
      input: "Привет",
      voice: "aurora",
      response_format: "mp3",
    });
  });

  it("пишет mp3, а не wav", async () => {
    speechFetchMock.mockResolvedValueOnce(audioResponse());
    await expect(synthesizeNarraSpeech("Привет", "Che")).resolves.toMatch(/\.mp3$/);
  });

  it("переводит код персонажа в голос Grok и сохраняет пол", async () => {
    speechFetchMock.mockResolvedValueOnce(audioResponse());
    await synthesizeNarraSpeech("Реплика", "Bez");
    expect(JSON.parse(String(speechFetchMock.mock.calls[0]?.[1]?.body)).voice).toBe("perseus");
  });

  it("разрешает просодию в другой голос — pitch/rate у Grok нет", async () => {
    speechFetchMock.mockResolvedValueOnce(audioResponse());
    await synthesizeNarraSpeech("Реплика", "Bez", { prosody: { pitch: -2 } });
    const body = JSON.parse(String(speechFetchMock.mock.calls[0]?.[1]?.body));
    expect(body.voice).not.toBe("perseus");
    // Скорость и высота в запрос не уходят — они не поддерживаются.
    expect(body).not.toHaveProperty("speed");
    expect(String(body.input)).not.toContain("<prosody");
  });

  it("применяет словарь ударений и не собирает SSML", async () => {
    primeCharacterStressForms([{ ...anna, stressedName: "А'нна" }]);
    speechFetchMock.mockResolvedValueOnce(audioResponse());

    await synthesizeNarraSpeech("Анна звонит.", "Che", { rate: 1.5 });

    const body = JSON.parse(String(speechFetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe("А'нна звони'т.");
    expect(body.input).not.toContain("<speak>");
  });

  it("сообщает телеметрии частоту дискретизации Grok", async () => {
    speechFetchMock.mockResolvedValueOnce(audioResponse());
    await synthesizeNarraSpeech("Привет", "Che");
    expect(recordTelemetry).toHaveBeenCalledWith(
      "tts_first_audio_ready",
      expect.objectContaining({ sample_rate: 24_000, origin: "user" }),
    );
  });

  it("повторяет запрос один раз на ошибке сервиса", async () => {
    speechFetchMock
      .mockResolvedValueOnce(new Response("upstream boom", { status: 502 }))
      .mockResolvedValueOnce(audioResponse());

    await expect(synthesizeNarraSpeech("Привет", "Che")).resolves.toMatch(/\.mp3$/);
    expect(speechFetchMock).toHaveBeenCalledTimes(2);
  });

  it("не повторяет запрос на ошибке запроса", async () => {
    speechFetchMock.mockResolvedValue(new Response("bad voice", { status: 404 }));
    await expect(synthesizeNarraSpeech("Привет", "Che")).rejects.toThrow();
    expect(speechFetchMock).toHaveBeenCalledTimes(1);
  });

  it("падает с ошибкой конфигурации на пустом теле ответа", async () => {
    speechFetchMock.mockResolvedValue(new Response(new Uint8Array(), { status: 200 }));
    await expect(synthesizeNarraSpeech("Привет", "Che")).rejects.toThrow();
  });
});

describe("book TTS backend contract", () => {
  it("rejects an oversized binary response while streaming, before any file is written", async () => {
    const fs = await import("expo-file-system/legacy");
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(new Uint8Array(16 * 1024 * 1024 + 1), {
        headers: { "content-type": "audio/wav", "x-audio-sample-rate": "48000" },
      }),
    );
    await expect(synthesizeNarraBookSpeech("Text.", "Che")).rejects.toMatchObject({
      code: "SERVICE",
    });
    expect(fs.writeAsStringAsync).not.toHaveBeenCalled();
  });
  it("removes a partially written file when storage fails", async () => {
    const fs = await import("expo-file-system/legacy");
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response());
    vi.mocked(fs.writeAsStringAsync).mockRejectedValueOnce(new Error("storage full"));
    await expect(synthesizeNarraBookSpeech("Text.", "Che")).rejects.toThrow("storage full");
    expect(fs.deleteAsync).toHaveBeenCalledWith(expect.stringMatching(/speech-.*\.wav$/), {
      idempotent: true,
    });
  });
  it("rejects oversized escaped SSML without issuing a request", async () => {
    await expect(
      synthesizeNarraBookSpeech("&".repeat(12_000), "Che", { rate: 1.1 }),
    ).rejects.toMatchObject({ code: "REQUEST" });
    expect(narraGatewayRequest).not.toHaveBeenCalled();
  });

  function wav() {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"));
    view.setUint32(4, 38, true);
    bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 96000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, 2, true);
    return bytes;
  }
  function response(body = wav()) {
    return new Response(body, {
      headers: { "content-type": "audio/wav", "x-audio-sample-rate": "48000" },
    });
  }
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    primeCharacterStressForms([]);
  });

  it("uses Gateway even if other Narra speech uses Grok; sends only text and voice and saves WAV", async () => {
    vi.stubEnv("EXPO_PUBLIC_NARRA_TTS_PROVIDER", "grok");
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response());
    await expect(synthesizeNarraBookSpeech("Текст.", "Che")).resolves.toMatch(/speech-.*\.wav$/);
    expect(narraGatewayRequest).toHaveBeenCalledWith(
      "/v2/speech/synthesize",
      expect.objectContaining({ body: JSON.stringify({ text: "Текст.", voice: "Che" }) }),
    );
    expect(speechFetchMock).not.toHaveBeenCalled();
    expect(recordTelemetry).toHaveBeenCalledWith(
      "media_job_enqueued",
      expect.objectContaining({ provider: "salutespeech" }),
    );
  });
  it("combines rate/prosody with stress marks, sending SSML instead of text", async () => {
    primeCharacterStressForms([{ ...anna, stressedName: "А'нна" }]);
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response());
    await synthesizeNarraBookSpeech("Анна.", "Ast", { rate: 1.1, prosody: { pitch: -2 } });
    const body = JSON.parse(String(vi.mocked(narraGatewayRequest).mock.lastCall?.[1]?.body));
    expect(body).toEqual({
      voice: "Ast",
      ssml: '<speak><prosody rate="110%" pitch="-8%">А&apos;нна.</prosody></speak>',
    });
  });
  it.each([new Uint8Array(), new Uint8Array(46)])(
    "does not write empty/non-WAV bytes",
    async (body) => {
      const fs = await import("expo-file-system/legacy");
      vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response(body));
      await expect(synthesizeNarraBookSpeech("Текст.", "Che")).rejects.toMatchObject({
        code: "SERVICE",
      });
      expect(fs.writeAsStringAsync).not.toHaveBeenCalled();
    },
  );
  it("rejects a missing local file instead of enqueueing it", async () => {
    const fs = await import("expo-file-system/legacy");
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response());
    vi.mocked(fs.getInfoAsync)
      .mockResolvedValueOnce({
        exists: true,
        isDirectory: true,
        uri: "file:///documents/narra-media",
        size: 0,
        modificationTime: 0,
      })
      .mockResolvedValueOnce({ exists: false, isDirectory: false, uri: "file:///missing" });
    await expect(synthesizeNarraBookSpeech("Текст.", "Che")).rejects.toMatchObject({
      code: "SERVICE",
    });
    expect(fs.deleteAsync).toHaveBeenCalled();
  });
  it("bounds the full response body to 60 seconds and cancels a stalled native stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull: () => new Promise(() => {}), cancel });
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(stream, {
        headers: { "content-type": "audio/wav", "x-audio-sample-rate": "48000" },
      }),
    );
    const pending = synthesizeNarraBookSpeech("Текст.", "Che");
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("deletes a WAV whose write finishes after Stop", async () => {
    const fs = await import("expo-file-system/legacy");
    const controller = new AbortController();
    let finish!: () => void;
    const write = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(fs.writeAsStringAsync).mockReturnValueOnce(write);
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(response());
    const pending = synthesizeNarraBookSpeech("Текст.", "Che", { signal: controller.signal });
    const assertion = expect(pending).rejects.toBeDefined();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(fs.writeAsStringAsync).toHaveBeenCalled();
    controller.abort();
    await assertion;
    finish();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(fs.deleteAsync).toHaveBeenCalledWith(expect.stringMatching(/speech-.*\.wav$/), {
      idempotent: true,
    });
  });
  it.each([400, 401, 429, 503])(
    "propagates HTTP %i without switching to another provider",
    async (status) => {
      vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
        new Response("private body", { status }),
      );
      await expect(synthesizeNarraBookSpeech("Текст.", "Che")).rejects.toMatchObject({
        code:
          status === 400
            ? "REQUEST"
            : status === 401
              ? "AUTH"
              : status === 429
                ? "RATE"
                : "SERVICE",
      });
      expect(speechFetchMock).not.toHaveBeenCalled();
    },
  );
});
