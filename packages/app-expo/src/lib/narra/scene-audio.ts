import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { useNarraStore } from "@/stores/narra-store";
import { buildCharacterNameMatcherSpec, findCharacterNameMatches } from "./character-name-matcher";
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
  const exact = characters.find((character) =>
    [character.id, character.name, character.fullName, ...(character.aliases ?? [])].some(
      (candidate) => candidate && normalizeCharacterKey(candidate) === key,
    ),
  );
  if (exact) return exact;
  // Модель часто возвращает имя не в той форме, что в реестре: косвенный
  // падеж («Раскольникова»), уменьшительное или часть полного имени. Раньше
  // такая реплика уходила «Рассказчику» — теперь ищем по словоформам тем же
  // матчером, что подсвечивает имена в тексте.
  const matches = findCharacterNameMatches(value.trim(), buildCharacterNameMatcherSpec(characters));
  const matchedId = matches[0]?.characterId;
  if (matchedId && matches.every((match) => match.characterId === matchedId)) {
    return characters.find((character) => character.id === matchedId) ?? null;
  }
  // Последняя попытка: одно из слов ответа совпадает с отдельным словом имени
  // (фамилия без имени, имя без отчества), и такой персонаж ровно один.
  const words = new Set(
    value
      .split(/[^\p{L}\p{N}]+/u)
      .map(normalizeCharacterKey)
      .filter((word) => word.length >= 3),
  );
  const byWord = characters.filter((character) =>
    [character.name, character.fullName, ...(character.aliases ?? [])]
      .filter(Boolean)
      .flatMap((candidate) => candidate.split(/[^\p{L}\p{N}]+/u))
      .map(normalizeCharacterKey)
      .some((word) => word.length >= 3 && words.has(word)),
  );
  return byWord.length === 1 ? byWord[0] : null;
}

function rosterEntry(character: NarraCharacter): string {
  const names = [character.name, character.fullName, ...(character.aliases ?? [])]
    .map((item) => item?.trim())
    .filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index);
  return `${character.id}: ${names.join(" / ")}`;
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
): Promise<NarraSceneAudioSegment[]> {
  // Словарь ударений имён книги (P9) — синтез сегментов сцены пойдёт через
  // synthesizeNarraSpeech, который читает активный словарь.
  primeCharacterStressForms(characters);
  const roster = characters.map(rosterEntry).join("; ");
  const response = await narraGatewayRequest("/v2/ai/chat/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
