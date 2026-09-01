import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import { useNarraStore } from "@/stores/narra-store";
import { getChunks } from "@readany/core/db/database";
import type { Book } from "@readany/core/types";
import { characterCountBucket, durationBucket } from "../analytics/contract";
import {
  normalizeCharacterAnalysisResponse,
  normalizeGenreAnalysisResponse,
  parseNarraStreamText,
} from "./character-normalization";
import { NarraServiceError, normalizeNarraError, reportNarraError } from "./errors";
import {
  NARRA_MOCK_CHARACTERS,
  NARRA_MOCK_CHARACTER_ID,
  createNarraMockMessages,
} from "./mock-characters";
import type { NarraCharacter } from "./types";
import { detectFirstPerson } from "./voice-rules";

const MAX_ANALYSIS_TEXT_LENGTH = 48_000;
const SEARCH_NOT_READY_MESSAGE =
  "Поиск по книге ещё не готов (SEARCH_NOT_READY). Ответ без книги недоступен.";

export type CharacterAnalysisTextFallback = string | (() => Promise<string>);
export interface CharacterAnalysisOptions {
  origin?: "user" | "background";
}

export function resolveAnalysisBookEditionId(book: Book): string | undefined {
  if (typeof book.bookEditionId === "string" && book.bookEditionId.trim()) {
    return book.bookEditionId.trim();
  }
  const bound = useNarraStore.getState().books?.[book.id]?.backendBinding?.bookEditionId;
  return typeof bound === "string" && bound.trim() ? bound.trim() : undefined;
}

const activeAnalyses = new Map<string, Promise<NarraCharacter[]>>();

export function createAnalysisExcerpt(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MAX_ANALYSIS_TEXT_LENGTH) return normalized;
  const sectionLength = Math.floor(MAX_ANALYSIS_TEXT_LENGTH / 3);
  const middleStart = Math.max(0, Math.floor(normalized.length / 2 - sectionLength / 2));
  return [
    normalized.slice(0, sectionLength),
    normalized.slice(middleStart, middleStart + sectionLength),
    normalized.slice(-sectionLength),
  ]
    .join("\n\n[…]\n\n")
    .slice(0, MAX_ANALYSIS_TEXT_LENGTH);
}

async function responseText(response: Response): Promise<string> {
  const body = await response.text();
  if (body.includes("data:")) return parseNarraStreamText(body);
  try {
    const payload = JSON.parse(body) as { text?: string; content?: string };
    return payload.text || payload.content || body;
  } catch {
    return body;
  }
}

async function runBookCharacterAnalysis(
  book: Book,
  textFallback?: CharacterAnalysisTextFallback,
  options: CharacterAnalysisOptions = {},
): Promise<NarraCharacter[]> {
  const origin = options.origin ?? "user";
  const startedAt = Date.now();
  const store = useNarraStore.getState();
  store.setAnalyzing(book.id);
  store.setAnalysisError(book.id);
  recordTelemetry("book_analysis_started", { analysis_version: "v1", origin });
  try {
    if (__DEV__ && process.env.EXPO_PUBLIC_NARRA_USE_MOCKS === "1") {
      store.setCharacters(book.id, NARRA_MOCK_CHARACTERS);
      const mockBook = useNarraStore.getState().books[book.id];
      if ((mockBook?.chats[NARRA_MOCK_CHARACTER_ID]?.length ?? 0) === 0) {
        for (const message of createNarraMockMessages()) {
          store.appendChatMessage(book.id, NARRA_MOCK_CHARACTER_ID, message);
        }
      }
      store.setMemory(
        book.id,
        NARRA_MOCK_CHARACTER_ID,
        "Читатель старается проверять необычные наблюдения и не торопится с выводами.",
      );
      recordTelemetry("book_analysis_completed", {
        analysis_version: "v1",
        character_count_bucket: characterCountBucket(NARRA_MOCK_CHARACTERS.length),
        duration_bucket: durationBucket(Date.now() - startedAt),
        pov: "unknown",
        confidence_bucket: "unknown",
        origin,
      });
      return NARRA_MOCK_CHARACTERS;
    }
    const chunks = await getChunks(book.id);
    const chunkText = chunks
      .slice(0, 28)
      .map((chunk) => `${chunk.chapterTitle}\n${chunk.content}`.trim())
      .filter(Boolean)
      .join("\n\n");
    // Число глав книги — для перевода appearanceChapter в долю открытия героя.
    const totalChapters =
      new Set(chunks.map((chunk) => chunk.chapterTitle).filter(Boolean)).size || undefined;
    let fallbackText = "";
    if (!chunkText) {
      fallbackText =
        typeof textFallback === "function" ? await textFallback() : (textFallback ?? "");
    }
    const content = chunkText || fallbackText;
    const excerpt = createAnalysisExcerpt(content);
    if (!excerpt) throw new Error("No text could be extracted from the book");
    const bookEditionId = resolveAnalysisBookEditionId(book);
    if (!bookEditionId) {
      throw new NarraServiceError(
        "SERVICE",
        SEARCH_NOT_READY_MESSAGE,
        undefined,
        undefined,
        "SEARCH_NOT_READY",
      );
    }
    const response = await narraGatewayRequest("/v2/ai/chat/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        book_edition_id: bookEditionId,
        messages: [
          {
            role: "system",
            content:
              "Ты анализируешь художественную книгу для Narra. Выдели до 6 главных персонажей. " +
              'Верни только JSON: {"genre":{"primary":"fanfiction","secondary":["romance"],"confidence":0.94,"evidence":"краткое основание по тексту"},' +
              '"characters":[{"id":"latin-slug","name":"короткое имя",' +
              '"fullName":"полное имя","stressedName":"имя с ударением","role":"роль","gender":"male|female",' +
              '"traits":["до 3 коротких черт"],"speechStyle":"манера речи","speechExamples":["2–3 реплики"],' +
              '"greeting":"приветствие читателю","appearanceChapter":1,"unlockFraction":0.0,' +
              '"appearancePrompt":"внешность одной фразой",' +
              '"passport":{"age":25,"build":"телосложение","hair":"волосы","eyes":"глаза",' +
              '"face":"черты лица","outfit":"одежда"}}]}. ' +
              "Жанр определяй по самому тексту, а не только по названию и метаданным. " +
              "primary и secondary выбирай только из: classic, manga, fanfiction, children, poetry, drama, mystery-thriller, science-fiction, adventure, fantasy, horror, romance, historical-fiction, biography-memoir, philosophy, psychology-self-help, business-economics, science-technology, history-politics, literary-fiction. " +
              "Если текст использует персонажей, реальных публичных людей или мир уже существующего произведения в новом вымышленном сюжете, выбирай fanfiction основным жанром, даже если слово «фанфик» отсутствует. Manga выбирай для манги и произведений, явно построенных в традиции манги/аниме. " +
              "confidence — число от 0 до 1, evidence — одно короткое основание без спойлеров. " +
              "appearancePrompt и passport — внешность строго по тексту книги: возраст и приметы бери из " +
              "прямых описаний, обращений и деталей повествования. Если возраст прямо не назван — оцени его " +
              "по тексту (положение, род занятий, как о герое говорят другие), а не по экранизациям и " +
              "не по расхожему образу этой книги. passport.age — целое число лет; поля одежды и причёски " +
              "описывают эпоху и мир книги. " +
              "speechStyle — живая манера речи именно этого героя: темп, лексика, интонации, 1–2 предложения " +
              "(например «Говорит быстро, по делу, чеканя аргументы; на сантименты язвит»); " +
              "без общих формул вроде «говорит в манере эпохи». " +
              "speechExamples — 2–3 короткие реплики, звучащие в точности как он. " +
              "appearanceChapter — номер главы первого значимого появления героя (1 — первая глава); " +
              "unlockFraction — доля книги до этого места от 0 до 0.95 (0 — герой есть с самого начала). " +
              "stressedName — то же короткое имя, но с апострофом сразу после ударной гласной " +
              '(например "Одинцо\'ва"); если в ударении не уверен — опусти это поле. ' +
              "greeting — первое сообщение героя читателю от первого лица, в его характере и манере речи, 1–2 предложения, без спойлеров. Всё текстовое — по-русски.",
          },
          {
            role: "user",
            content: `Книга «${book.meta.title}», автор ${book.meta.author || "неизвестен"}.\n\n${excerpt}`,
          },
        ],
        temperature: 0.3,
        purpose: "structured_task",
        origin,
        analytics_tier: origin === "background" ? "none" : "essential",
      }),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        code?: string;
        error?: string;
        request_id?: string;
      } | null;
      if (response.status >= 500 && error?.code === "AUTH") {
        const technicalDetail = [
          `HTTP ${response.status}`,
          error.error,
          error.request_id ? `request_id=${error.request_id}` : undefined,
        ]
          .filter(Boolean)
          .join("; ");
        throw new NarraServiceError(
          "SERVICE",
          "AI-провайдер Narra сейчас недоступен. Попробуйте немного позже.",
          error.request_id,
          technicalDetail,
        );
      }
      const normalized = normalizeNarraError(
        error?.code || error?.error || `HTTP ${response.status}`,
      );
      throw new NarraServiceError(
        normalized.code,
        normalized.message,
        error?.request_id,
        undefined,
        error?.code || normalized.backendCode,
      );
    }
    const rawAnalysis = await responseText(response);
    const genre = normalizeGenreAnalysisResponse(rawAnalysis);
    const characters = normalizeCharacterAnalysisResponse(rawAnalysis, {
      bookId: book.id,
      narratorPreference: useNarraStore.getState().narratorVoicePreference,
      firstPerson: detectFirstPerson(content),
      totalChapters,
    });
    if (characters.length === 0) {
      throw new Error(
        `Narra found no characters in the response: ${rawAnalysis.slice(0, 800) || "<empty>"}`,
      );
    }
    store.setCharacters(book.id, characters, genre);
    recordTelemetry("book_analysis_completed", {
      analysis_version: "v1",
      character_count_bucket: characterCountBucket(characters.length),
      duration_bucket: durationBucket(Date.now() - startedAt),
      pov: "unknown",
      confidence_bucket: "unknown",
      origin,
    });
    return characters;
  } catch (error) {
    const normalized = reportNarraError("character_analysis", error);
    const safeErrorCode = {
      AUTH: "AUTH",
      CONFIG: "NO_PROXY",
      CONNECTION: "NETWORK",
      RATE: "RATE",
      REQUEST: "VALIDATION",
      SERVICE: "UNKNOWN",
      TIMEOUT: "TIMEOUT",
    }[normalized.code];
    recordTelemetry("book_analysis_failed", {
      analysis_version: "v1",
      stage: "character_markup",
      safe_error_code: safeErrorCode,
      origin,
    });
    store.setAnalysisError(book.id, normalized.message);
    throw normalized;
  } finally {
    store.setAnalyzing(null);
  }
}

export function analyzeBookCharacters(
  book: Book,
  textFallback?: CharacterAnalysisTextFallback,
  options: CharacterAnalysisOptions = {},
): Promise<NarraCharacter[]> {
  const active = activeAnalyses.get(book.id);
  if (active) return active;

  const analysis = runBookCharacterAnalysis(book, textFallback, options).finally(() => {
    if (activeAnalyses.get(book.id) === analysis) activeAnalyses.delete(book.id);
  });
  activeAnalyses.set(book.id, analysis);
  return analysis;
}
