import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { useNarraStore } from "@/stores/narra-store";
import { NarraServiceError } from "./errors";
import { primeCharacterStressForms } from "./stress-markup";
import type { NarraCharacter, NarraSceneAudioSegment } from "./types";
import { narratorVoiceFor } from "./voice-rules";

const MAX_SCENE_TEXT_CHARS = 12_000;
const MAX_SCENE_SEGMENTS = 24;

/** Голос нарратора — из настройки пользователя (м — Сбер, ж — Афина, дефолт женский). */
export function getNarratorVoice(): string {
  return narratorVoiceFor(useNarraStore.getState().narratorVoicePreference);
}

type ScenarioResponse = { text?: string; content?: string; error?: string };

function normalizeCharacterKey(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, "");
}

function resolveCharacter(value: unknown, characters: NarraCharacter[]): NarraCharacter | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const key = normalizeCharacterKey(value);
  return (
    characters.find((character) =>
      [character.id, character.name, character.fullName].some(
        (candidate) => normalizeCharacterKey(candidate) === key,
      ),
    ) ?? null
  );
}

export function parseNarraAudioScenario(
  value: string,
  characters: NarraCharacter[],
): NarraSceneAudioSegment[] {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || value;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Gateway returned no audio scenario");

  const raw = JSON.parse(fenced.slice(start, end + 1)) as Array<Record<string, unknown>>;
  const narratorVoice = getNarratorVoice();
  return raw
    .filter((item) => typeof item.text === "string" && item.text.trim())
    .slice(0, MAX_SCENE_SEGMENTS)
    .map((item) => {
      const character = resolveCharacter(item.character, characters);
      return {
        type: item.type === "speech" ? "speech" : "narration",
        characterId: character?.id ?? null,
        speaker: character?.name ?? "Рассказчик",
        // Безымянные эпизодники и повествование — голос нарратора;
        // ручной выбор голоса в карточке героя приоритетнее автоназначения.
        voice: character?.voiceOverride || character?.voice || narratorVoice,
        text: String(item.text).trim(),
      };
    });
}

export async function generateNarraAudioScenario(
  excerpt: string,
  characters: NarraCharacter[],
  bookEditionId?: string,
): Promise<NarraSceneAudioSegment[]> {
  const edition = typeof bookEditionId === "string" ? bookEditionId.trim() : "";
  if (!edition) {
    throw new NarraServiceError(
      "SERVICE",
      "Поиск по книге ещё не готов (SEARCH_NOT_READY). Ответ без книги недоступен.",
      undefined,
      undefined,
      "SEARCH_NOT_READY",
    );
  }
  // Словарь ударений имён книги (P9) — синтез сегментов сцены пойдёт через
  // synthesizeNarraSpeech, который читает активный словарь.
  primeCharacterStressForms(characters);
  const roster = characters.map((character) => `${character.id}: ${character.fullName}`).join("; ");
  const response = await narraGatewayRequest("/v2/ai/chat/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      book_edition_id: edition,
      messages: [
        {
          role: "system",
          content: `Разбей фрагмент на сценарий аудиокниги. Верни только JSON-массив [{"type":"narration|speech","character":"id|null","text":"дословный текст"}]. Сохрани текст и порядок. Не добавляй новые реплики. Используй только эти id персонажей: ${roster || "персонажи не определены"}.`,
        },
        { role: "user", content: excerpt.slice(0, MAX_SCENE_TEXT_CHARS) },
      ],
      temperature: 0.15,
      purpose: "structured_task",
      origin: "user",
      analytics_tier: "essential",
    }),
  });

  const body = await response.text();
  let payload: ScenarioResponse | null = null;
  try {
    payload = JSON.parse(body) as ScenarioResponse;
  } catch {
    // Some gateway adapters return plain text for chat completions.
  }
  if (!response.ok) {
    throw new Error(payload?.error || body || `AI request failed (${response.status})`);
  }

  const scenarioText = (payload ? payload.text || payload.content || "" : body).trim();
  const segments = parseNarraAudioScenario(scenarioText, characters);
  if (segments.length === 0) throw new Error("Gateway returned an empty audio scenario");
  return segments;
}
