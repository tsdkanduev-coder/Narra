import { budgetPrompt } from "@/lib/narra/art-style";
import { generateBookCoverImage } from "@/lib/narra/media";
import { generateId } from "@readany/core/utils";
import {
  CoverJobError,
  acknowledgeCoverJob,
  boundedCoverBookFacts,
  coverJobDelay,
} from "../narra/cover-jobs";
import { normalizeNarraError } from "../narra/errors";
import coverGenerationConfig from "./cover-generation-config.json";
import { resolveCoverGenreProfile } from "./cover-genre";
import { validateCoverImage } from "./cover-image";
import {
  deleteLocalCoverJob,
  getLocalCoverJob,
  getOrCreateLocalCoverJob,
  updateLocalCoverJob,
} from "./cover-job-repository";
import { inCoverForeground } from "./cover-job-session";
import { generatedCoverBackgroundColor } from "./cover-text-contrast";

const MAX_THEME_CHARS = 800;
const COVER_PROMPT_TEMPLATE = coverGenerationConfig.promptParagraphs.join("\n\n");

export interface GeneratedBookCover {
  bytes: Uint8Array;
  mimeType: string;
  jobId: string;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function coverPrompt(input: {
  title: string;
  author?: string;
  description?: string;
  excerpt?: string;
  subjects?: string[];
  metaphor?: string;
  imageType?: string;
  accentColor1?: string;
  accentColor2?: string;
}) {
  const title = input.title.trim() || "Untitled book";
  const author = input.author?.trim() || "Unknown author";
  const themeSource = input.description?.trim() || input.excerpt?.trim();
  const theme = themeSource
    ? themeSource.replace(/\s+/gu, " ").slice(0, MAX_THEME_CHARS)
    : "Infer the central idea, mood, symbols and historical context from the title and author without reproducing their names as text.";
  const genre = resolveCoverGenreProfile(input);

  const backgroundColor =
    input.accentColor1?.trim() || generatedCoverBackgroundColor({ title, author });

  const replacements: Record<string, string> = {
    "{{BOOK_TITLE}}": title,
    "{{AUTHOR}}": author,
    "{{BOOK_DESCRIPTION}}": theme,
    "{{BOOK_GENRE}}": genre.label,
    "{{GENRE_ART_DIRECTION}}": genre.artDirection,
    "{{BACKGROUND_COLOR}}": backgroundColor,
  };

  return Object.entries(replacements).reduce(
    (prompt, [placeholder, value]) => prompt.replaceAll(placeholder, value),
    COVER_PROMPT_TEMPLATE,
  );
}

/**
 * Fanart-обложка в каноне work order: тот же ART_STYLE, бюджет 950.
 * Каталожный `coverPrompt` остаётся отдельным GPT Image-пайплайном
 * (типографика названия) — его контракт не ломаем.
 */
export function buildFanartCoverPrompt(input: {
  title: string;
  author?: string;
  description?: string;
}): string {
  const title = input.title.trim() || "Untitled book";
  const author = input.author?.trim();
  const theme = input.description?.trim();
  return budgetPrompt([
    `Обложка книги «${title}».`,
    author ? `Автор: ${author}.` : "",
    theme ? `Тема: ${theme}` : "",
    "Вертикальная книжная обложка, единая серия с портретами и сценами героев. Без текста и надписей на изображении.",
  ]);
}

async function runBookCoverJob(input: {
  bookId: string;
  title: string;
  author?: string;
  description?: string;
  excerpt?: string;
  subjects?: string[];
}): Promise<GeneratedBookCover> {
  await getOrCreateLocalCoverJob({
    bookId: input.bookId,
    requestId: generateId(),
    request: { book: boundedCoverBookFacts(input) },
  });
  return inCoverForeground(async (signal) => {
    for (let attempt = 0; ; attempt++) {
      const localJob = await getLocalCoverJob(input.bookId);
      if (!localJob) throw new CoverJobError("Cover intent removed", "CANCELLED");
      if (localJob.status === "failed")
        throw new CoverJobError(
          localJob.lastErrorMessage || "Cover job failed",
          localJob.lastErrorCode || "FAILED",
        );
      try {
        const generated = await generateBookCoverImage(
          localJob.request ?? { prompt: localJob.prompt },
          {
            requestId: localJob.requestId,
            jobId: localJob.jobId,
            nextPollAt: localJob.nextPollAt,
            signal,
            onJob: async (job) => {
              if (!(await updateLocalCoverJob(input.bookId, job)))
                throw new CoverJobError("Cover intent removed", "CANCELLED");
            },
          },
        );
        const bytes = decodeBase64(generated.base64);
        validateCoverImage(bytes, generated.mimeType);
        return { bytes, mimeType: generated.mimeType, jobId: generated.jobId };
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof CoverJobError && error.status === 404) {
          // A later library pass rechecks embedded covers before creating a fresh ID.
          await deleteLocalCoverJob(input.bookId);
          throw error;
        }
        const current = await getLocalCoverJob(input.bookId);
        if (!current || current.status === "failed") throw error;
        const transient =
          error instanceof TypeError ||
          (error instanceof Error && error.name === "AbortError") ||
          ["CONNECTION", "TIMEOUT"].includes(normalizeNarraError(error).code) ||
          (error instanceof CoverJobError && error.status >= 500);
        const nextPollAt = transient
          ? Date.now() + Math.min(30_000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 1000)
          : 0;
        await updateLocalCoverJob(input.bookId, {
          status:
            error instanceof CoverJobError && [400, 409, 429].includes(error.status)
              ? "failed"
              : current.status,
          nextPollAt,
          errorCode: error instanceof CoverJobError ? error.code : "NETWORK_OR_STORAGE",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (!transient || attempt >= 3) throw error;
        await coverJobDelay(nextPollAt - Date.now(), signal);
      }
    }
  });
}

/**
 * Durable server generation. The persisted request and job ID survive reloads.
 * Each book has at most one local submission/polling loop.
 */
const coverRequests = new Map<string, Promise<GeneratedBookCover>>();
export function generateBookCover(input: {
  bookId: string;
  title: string;
  author?: string;
  description?: string;
  excerpt?: string;
  subjects?: string[];
}): Promise<GeneratedBookCover> {
  const existing = coverRequests.get(input.bookId);
  if (existing) return existing;
  const pending = runBookCoverJob(input).finally(() => coverRequests.delete(input.bookId));
  coverRequests.set(input.bookId, pending);
  return pending;
}

/** Verify disk + DB before deleting server data, then remove the local intent. */
export async function acknowledgeGeneratedBookCover(
  bookId: string,
  verifySavedCover: () => Promise<void>,
  knownJobId?: string,
): Promise<void> {
  const localJob = await getLocalCoverJob(bookId);
  if (!localJob) return;
  const jobId = knownJobId ?? localJob.jobId;
  if (!jobId) return;
  if (localJob.jobId !== jobId || !["completed", "failed"].includes(localJob.status))
    throw new Error("Cover job is not ready for acknowledgement");
  await inCoverForeground(async (signal) => {
    await verifySavedCover();
    await acknowledgeCoverJob(jobId, signal);
  });
  await deleteLocalCoverJob(bookId);
}
