import { normalizeBookLanguage } from "./book-language";
import type { NarraCharacter, NarraCharacterProfileDetail } from "./types";
import { VOICES, assignVoices } from "./voice-rules";

export type BackendRecord = Record<string, unknown>;
export interface BackendBookBinding {
  bookEditionId: string;
  resolution: "catalog" | "private";
  language?: string | null;
  catalogKey?: string;
  contentSha256: string;
  sourceUploaded: boolean;
  expiresAt?: string;
}
export interface BackendCharacterAsset {
  assetId: string;
  type: "primary_portrait" | "greeting_audio" | "idle_animation";
  contentHash: string;
  mimeType: string;
  byteSize: number;
  downloadPath: string;
}
export interface BackendManifestCharacter {
  key: string;
  name: string;
  fullName: string;
  firstAppearance?: number;
  provisional: boolean;
  state: "ready" | "preparing" | "unknown";
  profile: BackendRecord;
  assets: BackendCharacterAsset[];
}
export interface BackendAnalysisState {
  runId?: string;
  stage?: string;
  status?: "queued" | "running" | "ready" | "failed" | "cancelled" | "unknown";
  retryable: boolean;
  errorCode?: string;
  updatedAt?: string;
}
export interface BackendBookManifest {
  availability: "ready" | "processing" | "failed" | "cancelled" | "unavailable" | "unknown";
  analysis?: BackendAnalysisState;
  language?: string | null;
  revision?: number;
  publicationId?: string;
  contentHash?: string;
  textLength?: number;
  characters: BackendManifestCharacter[];
}

export function backendRecord(value: unknown): BackendRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as BackendRecord)
    : {};
}
const string = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const HIDDEN_PROFILE_FIELDS = new Set([
  "analysisSource",
  "chatPlaceholder",
  "gender",
  "personalitySnapshots",
  "personalityTimelineVersion",
  "unlockFraction",
  "unlockProgress",
  "voice",
]);
const SNAPSHOT_METADATA_FIELDS = new Set(["cutoffTextOffset", "status"]);
function displayProfileValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (typeof item === "number" && Number.isFinite(item)) return [String(item)];
    const record = backendRecord(item);
    return typeof record.value === "string" && record.value.trim() ? [record.value.trim()] : [];
  });
  return values.length > 0 ? values : undefined;
}

/** Return the complete public profile supplied by the backend, overlaid with its final snapshot. */
export function backendVisibleProfileDetails(
  profile: BackendRecord,
  finalSnapshot?: BackendRecord,
): NarraCharacterProfileDetail[] {
  const visible = { ...profile };
  if (finalSnapshot) {
    for (const [key, value] of Object.entries(finalSnapshot)) {
      if (!SNAPSHOT_METADATA_FIELDS.has(key)) visible[key] = value;
    }
  }
  const order = [
    "role",
    "description",
    "traits",
    "appearancePrompt",
    "speechStyle",
    "speechExamples",
    "greeting",
  ];
  return Object.entries(visible)
    .flatMap(([key, value]) => {
      if (HIDDEN_PROFILE_FIELDS.has(key)) return [];
      const displayValue = displayProfileValue(value);
      return displayValue === undefined ? [] : [{ key, value: displayValue }];
    })
    .sort((a, b) => {
      const aIndex = order.indexOf(a.key);
      const bIndex = order.indexOf(b.key);
      return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex);
    });
}

export function parseBackendBinding(value: unknown, hash: string): BackendBookBinding {
  const raw = backendRecord(value);
  if (
    (raw.resolution !== "catalog" && raw.resolution !== "private") ||
    !string(raw.book_edition_id)
  ) {
    throw new Error("Invalid backend book binding");
  }
  return {
    bookEditionId: string(raw.book_edition_id),
    resolution: raw.resolution,
    language: normalizeBookLanguage(raw.language),
    catalogKey: string(raw.catalog_key) || undefined,
    contentSha256: hash,
    sourceUploaded: raw.resolution === "catalog" || raw.source_uploaded === true,
    expiresAt: string(raw.expires_at) || undefined,
  };
}

function parseAsset(value: unknown): BackendCharacterAsset[] {
  const raw = backendRecord(value);
  const type = raw.type;
  if (type !== "primary_portrait" && type !== "greeting_audio" && type !== "idle_animation")
    return [];
  if (
    !string(raw.asset_id) ||
    !/^[a-f0-9]{64}$/i.test(string(raw.content_hash)) ||
    !Number.isSafeInteger(raw.byte_size) ||
    Number(raw.byte_size) <= 0 ||
    !string(raw.download_path).startsWith("/v2/books/") ||
    !string(raw.mime_type).startsWith(
      type === "primary_portrait" ? "image/" : type === "greeting_audio" ? "audio/" : "video/",
    )
  )
    return [];
  return [
    {
      assetId: string(raw.asset_id),
      type,
      contentHash: string(raw.content_hash).toLowerCase(),
      mimeType: string(raw.mime_type),
      byteSize: Number(raw.byte_size),
      downloadPath: string(raw.download_path),
    },
  ];
}

const CHARACTER_BUNDLE_VERSION = /^character-bundle-v3(?::r[1-9]\d*)?$/;

export function parseBackendManifest(value: unknown): BackendBookManifest {
  const raw = backendRecord(value);
  if (!Array.isArray(raw.characters)) throw new Error("Invalid backend manifest characters");
  const markup = backendRecord(raw.markup);
  const analysis = backendRecord(raw.analysis);
  const seen = new Set<string>();
  return {
    availability:
      raw.availability === "ready" ||
      raw.availability === "processing" ||
      raw.availability === "failed" ||
      raw.availability === "cancelled" ||
      raw.availability === "unavailable"
        ? raw.availability
        : "unknown",
    analysis:
      Object.keys(analysis).length > 0
        ? {
            runId: string(analysis.run_id) || undefined,
            stage: string(analysis.stage) || undefined,
            status: ["queued", "running", "ready", "failed", "cancelled"].includes(
              string(analysis.status),
            )
              ? (string(analysis.status) as BackendAnalysisState["status"])
              : "unknown",
            retryable: analysis.retryable === true,
            errorCode: /^[A-Z0-9_]{1,80}$/.test(string(analysis.error_code))
              ? string(analysis.error_code)
              : undefined,
            updatedAt: string(analysis.updated_at) || undefined,
          }
        : undefined,
    language: normalizeBookLanguage(raw.language),
    revision: finite(markup.revision) ? markup.revision : undefined,
    publicationId: string(raw.publication_id) || undefined,
    contentHash: string(raw.content_hash) || undefined,
    textLength:
      finite(markup.text_length) && markup.text_length > 0 ? markup.text_length : undefined,
    characters: raw.characters.flatMap((value) => {
      const item = backendRecord(value);
      const key = string(item.character_key);
      if (!key || !string(item.name) || seen.has(key)) return [];
      seen.add(key);
      const bundle = backendRecord(item.bundle);
      return [
        {
          key,
          name: string(item.name),
          fullName: string(item.full_name),
          firstAppearance: finite(item.first_appearance_text_offset)
            ? Math.max(0, item.first_appearance_text_offset)
            : undefined,
          provisional: item.provisional !== false,
          state: item.state === "ready" || item.state === "preparing" ? item.state : "unknown",
          profile: backendRecord(item.profile),
          assets:
            CHARACTER_BUNDLE_VERSION.test(string(bundle.version)) && Array.isArray(bundle.assets)
              ? bundle.assets.flatMap(parseAsset)
              : [],
        } satisfies BackendManifestCharacter,
      ];
    }),
  };
}

export function backendUnlockProgress(
  character: BackendManifestCharacter,
  manifest: BackendBookManifest,
): number {
  const fallback = character.profile.unlockFraction ?? character.profile.unlockProgress;
  const fraction =
    manifest.textLength && character.firstAppearance !== undefined
      ? character.firstAppearance / manifest.textLength
      : finite(fallback)
        ? fallback
        : 0;
  return Math.min(0.95, Math.max(0, fraction));
}

/** Keeps only a deliberate actor/easter-egg voice; assistant voices are gender hints. */
export function backendActorVoice(value: unknown): string {
  if (typeof value !== "string") return "";
  const info = VOICES[value];
  return info && info.type !== "assistant" ? value : "";
}

/** Characters use the complete public profile supplied by the backend. */
export function backendConfirmedCharacters(
  manifest: BackendBookManifest,
  _progress: number,
): NarraCharacter[] {
  if (manifest.availability !== "ready") return [];
  const characters: NarraCharacter[] = manifest.characters
    .filter((item) => !item.provisional && item.state !== "unknown")
    .map((item) => {
      const profile = item.profile;
      const finalSnapshot = Array.isArray(profile.personalitySnapshots)
        ? (profile.personalitySnapshots as unknown[])
            .map(backendRecord)
            .filter((snapshot) => finite(snapshot.cutoffTextOffset))
            .sort((a, b) => Number(b.cutoffTextOffset) - Number(a.cutoffTextOffset))[0]
        : undefined;
      const traits = Array.isArray(finalSnapshot?.traits)
        ? finalSnapshot.traits.flatMap((value) => {
            const trait = backendRecord(value);
            return typeof trait.value === "string" ? [trait.value] : [];
          })
        : strings(profile.traits);
      return {
        id: item.key,
        name: item.name,
        fullName: item.fullName,
        role: string(profile.role),
        description: string(profile.description),
        gender: profile.gender === "female" ? "female" : "male",
        // Бэкенд присылает «ассистентский» голос по полу (Che/She/Erm) — тот же,
        // что у нарратора, поэтому все герои звучали рассказчиком (C4-RC1).
        // Такой голос — только подсказка пола; реальный актёрский голос даёт
        // план assignVoices ниже. Явно назначенный актёр/пасхалка сохраняется.
        voice: backendActorVoice(profile.voice),
        traits,
        speechStyle: string(profile.speechStyle),
        speechExamples: strings(profile.speechExamples),
        appearancePrompt: string(profile.appearancePrompt),
        profileDetails: backendVisibleProfileDetails(profile, finalSnapshot),
        greeting: string(profile.greeting) || undefined,
        chatPlaceholder: string(profile.chatPlaceholder) || undefined,
        unlockProgress: backendUnlockProgress(item, manifest),
        backendManaged: true,
        backendAssets: item.assets,
      };
    });
  const plan = assignVoices(
    characters.map((character, index) => ({
      id: character.id,
      gender: character.gender,
      rank: characters.length - index,
    })),
  );
  return characters.map((character) => ({
    ...character,
    voice: character.voice || plan.assignments[character.id]?.voice || plan.narratorVoice,
    voiceProsody: plan.assignments[character.id]?.prosody,
  }));
}

export function shouldPollBackendManifest(
  manifest: BackendBookManifest,
  progress: number,
): boolean {
  return (
    manifest.availability === "processing" ||
    (manifest.availability === "ready" &&
      manifest.characters.some(
        (item) => item.state === "preparing" && backendUnlockProgress(item, manifest) <= progress,
      ))
  );
}
