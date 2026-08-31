import { readGatewayResponseBytes } from "@/lib/ai/narra-gateway-consumer";
import { consumeNarraGatewayResponse, narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { recordTelemetry } from "@/lib/analytics/telemetry";
import * as FileSystem from "expo-file-system/legacy";
import { resolveCoverGenreProfile } from "../book/cover-genre";
import { findBundledCatalogBookDefinitionByTitle } from "../catalog/bundled-book-definitions";
import { budgetPrompt } from "./art-style";
import {
  CoverJobError,
  type CoverJobRequest,
  type CoverJobSnapshot,
  coverJobDelay,
  getCoverJob,
  submitCoverJob,
} from "./cover-jobs";
import { NarraServiceError, normalizeNarraError } from "./errors";
import { type NarraGenreAnalysis, narraGenreLabel } from "./genre-analysis";
import { GROK_TTS_MODEL, GROK_TTS_SAMPLE_RATE, fetchGrokSpeechAudio } from "./grok-speech";
import { buildCharacterPortraitPrompt } from "./portrait-prompt";
import { mentionedCharacters, passportDescription } from "./scene-prompt";
import { applyActiveStressMarkup } from "./stress-markup";
import type { NarraCharacter } from "./types";
import type { NarraProsody } from "./voice-rules";

const MEDIA_DIR = `${FileSystem.documentDirectory}narra-media`;
const MEDIA_PATH_MARKER = "/Documents/narra-media/";
let speechFileSequence = 0;
const portraitRequests = new Map<string, Promise<string>>();

type MediaJobType = "image" | "cover" | "tts" | "avatar" | "video";
type MediaJobOrigin = "user" | "background";

/**
 * Провайдер озвучки. `grok` — Grok TTS напрямую в OpenRouter (дефолт),
 * `gateway` — прежний путь через `/v2/speech/synthesize` (SaluteSpeech).
 * Откат — одной переменной окружения, без пересборки логики.
 */
export type NarraTTSProvider = "grok" | "gateway";

export function getNarraTTSProvider(): NarraTTSProvider {
  return process.env.EXPO_PUBLIC_NARRA_TTS_PROVIDER?.trim() === "gateway" ? "gateway" : "grok";
}

const MEDIA_JOB_ROUTES: Record<MediaJobType, { provider: string; model: string }> = {
  image: { provider: "kandinsky", model: "k6-image-t2i" },
  cover: { provider: "openrouter", model: "gpt-image-2" },
  tts: { provider: "salutespeech", model: "salutespeech-yourvoice" },
  avatar: { provider: "openrouter", model: "gpt-image-2" },
  video: { provider: "openrouter", model: "veo-3.1-lite" },
};

function mediaJobRoute(type: MediaJobType): { provider: string; model: string } {
  if (type === "tts" && getNarraTTSProvider() === "grok") {
    return { provider: "openrouter", model: GROK_TTS_MODEL };
  }
  return MEDIA_JOB_ROUTES[type];
}

function mediaLatencyBucket(durationMs: number): string {
  if (durationMs < 1_000) return "<1s";
  if (durationMs < 5_000) return "1-4s";
  if (durationMs < 15_000) return "5-14s";
  if (durationMs < 60_000) return "15-59s";
  if (durationMs < 5 * 60_000) return "1-4m";
  return "5m+";
}

function firstAudioLatencyBucket(durationMs: number): string {
  if (durationMs < 1_000) return "<1s";
  if (durationMs < 5_000) return "1-4s";
  if (durationMs < 15_000) return "5-14s";
  return "15s+";
}

/**
 * Единая телеметрия медиа-генераций. По умолчанию provider/model гейтвейные
 * (Kandinsky/SaluteSpeech); OpenRouter-путь сцен (scene-image-openrouter.ts)
 * передаёт свои через meta, сами события и поля не меняются.
 */
export async function trackNarraMediaJob<T>(
  jobType: MediaJobType,
  origin: MediaJobOrigin,
  operation: () => Promise<T>,
  meta?: { provider: string; model: string },
): Promise<T> {
  const startedAt = Date.now();
  const route = mediaJobRoute(jobType);
  const provider = meta?.provider ?? route.provider;
  const model = meta?.model ?? route.model;
  recordTelemetry("media_job_enqueued", {
    job_type: jobType,
    provider,
    model,
    quality: "unknown",
    queue_depth_bucket: "0",
    origin,
  });
  recordTelemetry("media_job_started", {
    job_type: jobType,
    queue_wait_bucket: "<1s",
    origin,
  });
  try {
    const result = await operation();
    recordTelemetry("media_job_completed", {
      job_type: jobType,
      job_latency_bucket: mediaLatencyBucket(Date.now() - startedAt),
      cache_hit: false,
      origin,
    });
    return result;
  } catch (error) {
    const code = normalizeNarraError(error).code;
    const safeErrorCode = {
      AUTH: "AUTH",
      CONFIG: "NO_PROXY",
      CONNECTION: "NETWORK",
      RATE: "RATE",
      REQUEST: "VALIDATION",
      SERVICE: "UNKNOWN",
      TIMEOUT: "TIMEOUT",
    }[code];
    recordTelemetry("media_job_failed", {
      job_type: jobType,
      stage: "provider",
      safe_error_code: safeErrorCode,
      retry_count_bucket: "0",
      origin,
    });
    throw error;
  }
}

/** Rehomes persisted iOS file URIs after the app data-container UUID changes. */
export function normalizePersistedNarraMediaUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const markerIndex = uri.indexOf(MEDIA_PATH_MARKER);
  if (markerIndex === -1) return uri;
  const filename = uri.slice(markerIndex + MEDIA_PATH_MARKER.length);
  return `${MEDIA_DIR}/${filename}`;
}

async function ensureMediaDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MEDIA_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 160);
}

interface PortraitBookContext {
  description: string;
  genreId: string;
  genreLabel: string;
}

interface PortraitGenreBookMeta {
  title: string;
  description?: string;
  subjects?: string[];
}

export function resolvePortraitGenre(
  meta: PortraitGenreBookMeta,
  analyzedGenre?: NarraGenreAnalysis,
): { id: string; label: string } {
  if (analyzedGenre) {
    return {
      id: analyzedGenre.primary,
      label: narraGenreLabel(analyzedGenre.primary),
    };
  }

  const explicitlyClassic =
    Boolean(findBundledCatalogBookDefinitionByTitle(meta.title)) ||
    meta.subjects?.some((subject) => /(?:classic|классик)/iu.test(subject));
  return explicitlyClassic
    ? { id: "classic", label: "классическая литература" }
    : resolveCoverGenreProfile(meta);
}

/** Контекст книги и жанр для портретов персонажей. */
function portraitBookContext(bookId: string): PortraitBookContext | undefined {
  try {
    // Ленивый импорт, чтобы не тянуть стор в юнит-тесты чистых промптов
    const { useLibraryStore, useNarraStore } = require("@/stores") as typeof import("@/stores");
    const book = useLibraryStore.getState().books.find((item) => item.id === bookId);
    if (!book) return undefined;
    const analyzedGenre = useNarraStore.getState().books[bookId]?.genre;
    const author = book.meta.author ? ` (${book.meta.author})` : "";
    const genre = resolvePortraitGenre(book.meta, analyzedGenre);
    return {
      description: `«${book.meta.title}»${author}`,
      genreId: genre.id,
      genreLabel: genre.label,
    };
  } catch {
    return undefined;
  }
}

export function portraitPrompt(
  character: NarraCharacter,
  bookContext?: string,
  genreId = "classic",
  genreLabel = "классическая литература",
): string {
  return buildCharacterPortraitPrompt(character, { bookContext, genreId, genreLabel });
}

/** Портрет по канону work order: погрудный кадр + паспорт + ART_STYLE, бюджет 950. */
export function buildFanartPortraitPrompt(character: NarraCharacter): string {
  return budgetPrompt([
    "Погрудный портрет: голова и плечи, строго анфас, ровный светлый фон.",
    `Выражение лица: ${character.expression || "естественное, в характере"}.`,
    `Внешность (соблюдать точно): ${passportDescription(character)}.`,
  ]);
}

function imagePayload(payload: unknown): { base64?: string; url?: string; error?: string } {
  if (!payload || typeof payload !== "object") return {};
  const value = payload as {
    image?: string;
    b64_json?: string;
    url?: string;
    error?: string;
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const image = value.image;
  if (image?.startsWith("http://") || image?.startsWith("https://")) return { url: image };
  return {
    base64:
      image?.replace(/^data:image\/[^;]+;base64,/, "") ||
      value.b64_json ||
      value.data?.[0]?.b64_json,
    url: value.url || value.data?.[0]?.url,
    error: value.error,
  };
}

// passportDescription/mentionedCharacters переехали в scene-prompt.ts (P16) —
// единый источник для гейтвей- и OpenRouter-промптов.

const KANDINSKY_SAFETY_REJECTION =
  /политик[А-Яа-яЁё]* безопасности|safety|content policy|moderation/iu;

function neutralizeSensitiveSceneText(excerpt: string): string {
  const narration = excerpt
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("—"))
    .join(" ");
  const visualSource = narration.length >= 120 ? narration : excerpt;
  return visualSource
    .replace(/восстани[А-Яа-яЁё]*/giu, "собрание")
    .replace(/борьб[А-Яа-яЁё]*/giu, "настойчивые усилия")
    .replace(/перебьют/giu, "остановят")
    .replace(/командующ[А-Яа-яЁё]*/giu, "руководитель")
    .replace(/подпольн[А-Яа-яЁё]*/giu, "закрытого")
    .replace(/революц[А-Яа-яЁё]*/giu, "общественного")
    .replace(/политич[А-Яа-яЁё]*/giu, "общественного")
    .replace(/убий[А-Яа-яЁё]*/giu, "конфликт")
    .replace(/убил[А-Яа-яЁё]*/giu, "остановил")
    .replace(/оруж[А-Яа-яЁё]*/giu, "предметы")
    .replace(/выстрел[А-Яа-яЁё]*/giu, "резкие звуки")
    .replace(/кров[А-Яа-яЁё]*/giu, "следы")
    .replace(/террор[А-Яа-яЁё]*/giu, "опасность")
    .replace(/насили[А-Яа-яЁё]*/giu, "конфликт")
    .replace(/кулак/giu, "руку")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSceneImagePrompt(
  chapter: string,
  excerpt: string,
  characters: NarraCharacter[],
): string {
  const canon = mentionedCharacters(excerpt, characters)
    .map((character) => `${character.fullName}: ${passportDescription(character)}`)
    .join("; ");
  return budgetPrompt([
    `Иллюстрация сцены из главы «${chapter}».`,
    canon
      ? `В кадре только эти герои, внешность соблюдать точно: ${canon}. Одежда из сцены важнее паспортной.`
      : "",
    `Сцена: ${excerpt}`,
    "Широкая общая композиция в едином пространстве, НЕ коллаж. Не добавляй отсутствующих героев.",
  ]);
}

export function buildSafetyFallbackSceneImagePrompt(
  excerpt: string,
  characters: NarraCharacter[],
): string {
  const canon = mentionedCharacters(excerpt, characters)
    .map((character) => `${character.fullName}: ${passportDescription(character)}`)
    .join("; ");
  return budgetPrompt([
    "Нейтральная книжная иллюстрация спокойного момента.",
    canon ? `В кадре только эти герои, внешность соблюдать точно: ${canon}.` : "",
    `Сцена: ${neutralizeSensitiveSceneText(excerpt)}`,
    "Покажи окружение, свет и одежду персонажей. Без символики. Не добавляй отсутствующих героев и лишних людей.",
  ]);
}

function isKandinskySafetyRejection(error?: string): boolean {
  return !!error && KANDINSKY_SAFETY_REJECTION.test(error);
}

/**
 * Низкоуровневый запрос картинки к шлюзу. Размеры задают серверный
 * aspectRatio: 1024×1024 → 1:1 (сцены), 768×1024 → 3:4 (портреты).
 */
export async function requestNarraGatewayImage(
  prompt: string,
  options: { width: number; height: number; engine: "kandinsky" | "openrouter" },
): Promise<{
  response: Response;
  payload: { base64?: string; url?: string; error?: string };
}> {
  const response = await narraGatewayRequest("/v2/media/images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt,
      width: options.width,
      height: options.height,
      engine: options.engine,
    }),
  });
  return {
    response,
    payload: imagePayload(await response.json().catch(() => null)),
  };
}

function requestSceneImage(prompt: string): Promise<{
  response: Response;
  payload: { base64?: string; url?: string; error?: string };
}> {
  return requestNarraGatewayImage(prompt, { width: 1024, height: 1024, engine: "kandinsky" });
}

async function persistGeneratedImage(
  path: string,
  payload: { base64?: string; url?: string },
): Promise<string> {
  const temporaryPath = `${path}.${Date.now()}.tmp`;
  if (payload.base64) {
    await FileSystem.writeAsStringAsync(temporaryPath, payload.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else if (payload.url) {
    await FileSystem.downloadAsync(payload.url, temporaryPath);
  } else {
    throw new Error("Image response is empty");
  }
  await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: temporaryPath, to: path });
  return path;
}

/**
 * Абсолютный file://-путь нового файла в narra-media (каталог создаётся при
 * необходимости). Используется видео-оживлением (animate-openrouter.ts):
 * downloadAsync пишет напрямую в целевой путь, единое именование с картинками.
 */
export async function narraMediaTargetPath(key: string, extension: string): Promise<string> {
  await ensureMediaDir();
  return `${MEDIA_DIR}/${safeKey(key)}.${extension}`;
}

/**
 * Сохраняет base64-картинку сцены в narra-media и возвращает file://-путь.
 * Используется OpenRouter-путём (scene-image-openrouter.ts); именование файла
 * то же, что у гейтвей-сцен, чтобы restore/normalize работали одинаково.
 */
export async function persistSceneImageBase64(
  bookId: string,
  base64: string,
  extension: "png" | "jpg" = "jpg",
): Promise<string> {
  await ensureMediaDir();
  const path = `${MEDIA_DIR}/${safeKey(`${bookId}-scene-${Date.now()}`)}.${extension}`;
  return persistGeneratedImage(path, { base64 });
}

async function generateCharacterPortraitRequest(
  bookId: string,
  character: NarraCharacter,
): Promise<string> {
  const book = portraitBookContext(bookId);
  // Портреты идут через гейтвей: 768×1024 даёт серверный aspectRatio 3:4, а
  // engine=openrouter оставляет ту же модель, что была в приложении, — ключ
  // при этом больше не уезжает в бандл.
  const response = await narraGatewayRequest("/v2/media/images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: portraitPrompt(character, book?.description, book?.genreId, book?.genreLabel),
      width: 768,
      height: 1024,
      engine: "openrouter",
    }),
  });
  const payload = imagePayload(await response.json().catch(() => null));
  if (!response.ok || (!payload.base64 && !payload.url)) {
    throw new Error(payload.error || `Portrait generation failed (${response.status})`);
  }
  await ensureMediaDir();
  const path = `${MEDIA_DIR}/${safeKey(`${bookId}-${character.id}-portrait`)}.jpg`;
  return persistGeneratedImage(path, payload);
}

export function generateCharacterPortrait(
  bookId: string,
  character: NarraCharacter,
): Promise<string> {
  return trackNarraMediaJob("avatar", "background", () =>
    generateCharacterPortraitRequest(bookId, character),
  );
}

/** Shares portrait work between background catalog preloading and the chat screen. */
export function ensureCharacterPortrait(
  bookId: string,
  character: NarraCharacter,
): Promise<string> {
  if (character.portraitUri) {
    return Promise.resolve(normalizePersistedNarraMediaUri(character.portraitUri));
  }
  if (character.backendManaged) {
    // A missing server asset is never a request to generate another portrait.
    return Promise.reject(new Error("Backend portrait is not available locally yet"));
  }

  const key = `${bookId}:${character.id}`;
  const inFlight = portraitRequests.get(key);
  if (inFlight) return inFlight;

  const request = generateCharacterPortrait(bookId, character).finally(() => {
    portraitRequests.delete(key);
  });
  portraitRequests.set(key, request);
  return request;
}

async function generateSceneImageRequest(
  bookId: string,
  chapter: string,
  excerpt: string,
  characters: NarraCharacter[],
): Promise<string> {
  let { response, payload } = await requestSceneImage(
    buildSceneImagePrompt(chapter, excerpt, characters),
  );
  if (!response.ok && isKandinskySafetyRejection(payload.error)) {
    ({ response, payload } = await requestSceneImage(
      buildSafetyFallbackSceneImagePrompt(excerpt, characters),
    ));
  }
  if (!response.ok || (!payload.base64 && !payload.url)) {
    throw new Error(payload.error || `Scene generation failed (${response.status})`);
  }
  await ensureMediaDir();
  const path = `${MEDIA_DIR}/${safeKey(`${bookId}-scene-${Date.now()}`)}.png`;
  return persistGeneratedImage(path, payload);
}

export function generateSceneImage(
  bookId: string,
  chapter: string,
  excerpt: string,
  characters: NarraCharacter[],
): Promise<string> {
  return trackNarraMediaJob("image", "user", () =>
    generateSceneImageRequest(bookId, chapter, excerpt, characters),
  );
}

export interface GeneratedCoverImage {
  base64: string;
  mimeType: string;
  jobId: string;
}

async function generateBookCoverImageRequest(
  request: CoverJobRequest,
  options: {
    requestId: string;
    jobId?: string;
    nextPollAt?: number;
    signal?: AbortSignal;
    onJob: (job: CoverJobSnapshot) => Promise<void>;
  },
): Promise<GeneratedCoverImage> {
  await coverJobDelay((options.nextPollAt ?? 0) - Date.now(), options.signal);
  let job = options.jobId
    ? await getCoverJob(options.jobId, options.signal)
    : await submitCoverJob(request, options.requestId, options.signal);
  while (true) {
    // Persist the real server ID before waiting or touching the image.
    await options.onJob(job);
    if (job.status === "failed")
      throw new CoverJobError(
        job.errorMessage || "Cover generation failed",
        job.errorCode || "FAILED",
      );
    if (job.status === "completed") {
      // Earlier gateways omit image on an idempotent POST. Fetch that same job.
      if (!job.base64) {
        job = await getCoverJob(job.jobId, options.signal);
        await options.onJob(job);
      }
      if (
        job.status !== "completed" ||
        !job.base64 ||
        !job.mimeType ||
        !["image/jpeg", "image/png", "image/webp"].includes(job.mimeType)
      ) {
        throw new CoverJobError("Invalid cover image result", "INVALID_IMAGE");
      }
      return { base64: job.base64, mimeType: job.mimeType, jobId: job.jobId };
    }
    await coverJobDelay(job.nextPollAt - Date.now(), options.signal);
    job = await getCoverJob(job.jobId, options.signal);
  }
}

/** Обложка генерируется на гейтвее: ключ и модель остаются на сервере. */
export function generateBookCoverImage(
  request: CoverJobRequest,
  options: {
    requestId: string;
    jobId?: string;
    nextPollAt?: number;
    signal?: AbortSignal;
    onJob: (job: CoverJobSnapshot) => Promise<void>;
  },
): Promise<GeneratedCoverImage> {
  return trackNarraMediaJob("cover", "background", () =>
    generateBookCoverImageRequest(request, options),
  );
}

export interface NarraSpeechOptions {
  /** Просодия голоса персонажа из voice-rules (pitch — полутоны, rate — множитель). */
  prosody?: NarraProsody;
  /** Пользовательская скорость воспроизведения (0.5–2, дефолт 1). */
  rate?: number;
}

function escapeSsmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * SSML для /v2/speech/synthesize (SaluteSpeech поддерживает <prosody rate pitch>,
 * см. синтез в narra). Скорость пользователя и просодия персонажа перемножаются;
 * pitch в полутонах переводится в проценты (~4% на полутон). Без отклонений от
 * дефолта возвращается null — синтез идёт обычным текстом.
 */
export function buildNarraSpeechSsml(
  text: string,
  prosody?: NarraProsody,
  rate?: number,
): string | null {
  const ratePercent = clamp(Math.round((rate ?? 1) * (prosody?.rate ?? 1) * 100), 50, 200);
  const pitchPercent = clamp(Math.round((prosody?.pitch ?? 0) * 4), -40, 40);
  if (ratePercent === 100 && pitchPercent === 0) return null;
  const pitch = `${pitchPercent >= 0 ? "+" : ""}${pitchPercent}%`;
  return `<speak><prosody rate="${ratePercent}%" pitch="${pitch}">${escapeSsmlText(text)}</prosody></speak>`;
}

async function writeSpeechFile(bytes: Uint8Array, extension: "wav" | "mp3"): Promise<string> {
  await ensureMediaDir();
  const path = `${MEDIA_DIR}/speech-${Date.now()}-${speechFileSequence++}.${extension}`;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  try {
    await FileSystem.writeAsStringAsync(path, btoa(binary), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return path;
  } catch (error) {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
    throw error;
  }
}

/** Прежний путь: гейтвей Narra + SaluteSpeech, SSML с prosody rate/pitch. */
async function synthesizeViaGateway(
  trimmed: string,
  voice: string,
  options: NarraSpeechOptions | undefined,
  startedAt: number,
): Promise<string> {
  const ssml = buildNarraSpeechSsml(trimmed, options?.prosody, options?.rate);
  const response = await narraGatewayRequest("/v2/speech/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ssml ? { ssml, voice } : { text: trimmed, voice }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Speech synthesis failed (${response.status})`);
  }
  const sampleRate = Number(response.headers.get("x-audio-sample-rate"));
  if (sampleRate === 24_000 || sampleRate === 48_000) {
    recordTelemetry("tts_first_audio_ready", {
      sample_rate: sampleRate,
      first_audio_latency_bucket: firstAudioLatencyBucket(Date.now() - startedAt),
      origin: "user",
    });
  }
  return writeSpeechFile(new Uint8Array(await response.arrayBuffer()), "wav");
}

/**
 * Grok TTS через OpenRouter. Просодия персонажа уходит в подбор голоса
 * (grok-voices), пользовательская скорость — на плеер: API Grok не принимает
 * ни rate, ни pitch, поэтому SSML здесь не собирается.
 */
async function synthesizeViaGrok(
  trimmed: string,
  voice: string,
  options: NarraSpeechOptions | undefined,
  startedAt: number,
): Promise<string> {
  const bytes = await fetchGrokSpeechAudio(trimmed, voice, { prosody: options?.prosody });
  recordTelemetry("tts_first_audio_ready", {
    sample_rate: GROK_TTS_SAMPLE_RATE,
    first_audio_latency_bucket: firstAudioLatencyBucket(Date.now() - startedAt),
    origin: "user",
  });
  return writeSpeechFile(bytes, "mp3");
}

async function synthesizeNarraSpeechRequest(
  text: string,
  voice: string,
  options?: NarraSpeechOptions,
): Promise<string> {
  const startedAt = Date.now();
  // Ударения (P9) размечаются здесь — в единой точке всей озвучки (книга,
  // сцены, чат) — до сборки SSML, чтобы работать и в {text}, и в {ssml}.
  const trimmed = applyActiveStressMarkup(text.slice(0, 12_000));
  return getNarraTTSProvider() === "grok"
    ? synthesizeViaGrok(trimmed, voice, options, startedAt)
    : synthesizeViaGateway(trimmed, voice, options, startedAt);
}

export function synthesizeNarraSpeech(
  text: string,
  voice: string,
  options?: NarraSpeechOptions,
): Promise<string> {
  return trackNarraMediaJob("tts", "user", () =>
    synthesizeNarraSpeechRequest(text, voice, options),
  );
}

/** Book reading always uses the authenticated backend, independently of chat/scene TTS. */
export function synthesizeNarraBookSpeech(
  text: string,
  voice: string,
  options: NarraSpeechOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  return trackNarraMediaJob(
    "tts",
    "user",
    async () => {
      const startedAt = Date.now();
      const prepared = applyActiveStressMarkup(text.slice(0, 12_000)).slice(0, 12_000).trim();
      const ssml = buildNarraSpeechSsml(prepared, options.prosody, options.rate);
      if (!prepared || (ssml && ssml.length > 24_000))
        throw new NarraServiceError("REQUEST", "Не удалось подготовить фрагмент для озвучки.");
      return consumeNarraGatewayResponse(
        "/v2/speech/synthesize",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ssml ? { ssml, voice } : { text: prepared, voice }),
          signal: options.signal,
        },
        async (response, scope) => {
          if (!response.ok) {
            // Do not log provider bodies: they may echo the book text.
            throw new NarraServiceError(
              response.status === 401 || response.status === 403
                ? "AUTH"
                : response.status === 429
                  ? "RATE"
                  : response.status >= 500 || response.status === 408
                    ? "SERVICE"
                    : "REQUEST",
              "Не удалось озвучить фрагмент.",
              undefined,
              `Speech HTTP ${response.status}`,
            );
          }
          const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
          const sampleRate = Number(response.headers.get("x-audio-sample-rate"));
          if (
            !["audio/wav", "audio/x-wav"].includes(mime ?? "") ||
            ![24_000, 48_000].includes(sampleRate)
          )
            throw new NarraServiceError(
              "SERVICE",
              "Сервис вернул неподдерживаемый формат озвучки.",
            );
          const bytes = await readGatewayResponseBytes(response, scope, 16 * 1024 * 1024);
          if (
            bytes.length <= 44 ||
            String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
            String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE"
          )
            throw new NarraServiceError("SERVICE", "Сервис вернул пустой или повреждённый звук.");
          scope.throwIfAborted();
          // Writing can finish after cancellation. Always observe it and remove a late file.
          const saving = writeSpeechFile(bytes, "wav").then(async (uri) => {
            try {
              scope.throwIfAborted();
              const info = await FileSystem.getInfoAsync(uri);
              scope.throwIfAborted();
              if (!info.exists || info.isDirectory || info.size !== bytes.byteLength)
                throw new NarraServiceError("SERVICE", "Не удалось сохранить звук на устройстве.");
              return uri;
            } catch (error) {
              await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
              throw error;
            }
          });
          const uri = await scope.wait(saving);
          recordTelemetry("tts_first_audio_ready", {
            sample_rate: sampleRate,
            first_audio_latency_bucket: firstAudioLatencyBucket(Date.now() - startedAt),
            origin: "user",
          });
          return uri;
        },
      );
    },
    MEDIA_JOB_ROUTES.tts,
  );
}
