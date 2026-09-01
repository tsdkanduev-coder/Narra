import { useLibraryStore } from "@/stores/library-store";
import { useNarraStore } from "@/stores/narra-store";
import { getPlatformService } from "@readany/core/services";
import type { Book } from "@readany/core/types";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";
import {
  BackendBookError,
  backendBookPath,
  backendBookRequest,
  backendJsonPost,
  postBackendAnalysisRetry,
  postBackendProgress,
} from "./backend-book-api";
import {
  type BackendBookManifest,
  parseBackendBinding,
  parseBackendManifest,
} from "./backend-book-contract";
import { BackendBookSession } from "./backend-book-session";
import { loadBackendCharacterMedia } from "./backend-character-media";
import { sha256BackendFile } from "./backend-file-hash";
import { normalizeBookLanguage } from "./book-language";

interface SyncStatus {
  manifest?: BackendBookManifest;
  error?: string;
  identityError?: string;
  analysisRetrying?: boolean;
}
/** Provisional rows are deliberately never written to the persisted Narra store. */
export const useBackendBookStatus = create<{ books: Record<string, SyncStatus> }>(() => ({
  books: {},
}));
function status(bookId: string, update: Partial<SyncStatus>) {
  useBackendBookStatus.setState((state) => ({
    books: { ...state.books, [bookId]: { ...state.books[bookId], ...update } },
  }));
}

const sessions = new Map<string, { session: BackendBookSession; consumers: number }>();
const expiredEditions = new Set<string>();
const bindings = new Map<
  string,
  Promise<NonNullable<ReturnType<typeof useNarraStore.getState>["books"][string]["backendBinding"]>>
>();

async function sourcePath(book: Book) {
  const original = useNarraStore.getState().books[book.id]?.backendOriginalSource;
  if (original) return `${FileSystem.documentDirectory}${original.path}`;
  const path = book.filePath;
  if (path.startsWith("/") || path.startsWith("file://")) return path;
  const platform = getPlatformService();
  return platform.joinPath(await platform.getAppDataDir(), path);
}

/** Keep original bytes before a local TXT/UMD conversion changes the file identity. */
export async function preserveBackendOriginalSource(
  bookId: string,
  source: string,
  format: string,
) {
  const directory = `${FileSystem.documentDirectory}narra-backend-sources`;
  const hash = await sha256BackendFile(source);
  const path = `narra-backend-sources/${encodeURIComponent(bookId)}.${format}`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await FileSystem.copyAsync({ from: source, to: `${FileSystem.documentDirectory}${path}` });
  useNarraStore.getState().setBackendOriginalSource(bookId, { path, format, hash });
}

/** Форматы, которые gateway принимает в POST /v2/books/local (BOOK_FORMATS). */
const SUPPORTED_BACKEND_FORMATS = new Set(["epub", "fb2", "txt", "pdf"]);
/** BOOK_UPLOAD_MAX_MIB на gateway по умолчанию. */
const MAX_BACKEND_SOURCE_BYTES = 50 * 1024 * 1024;
const TERMINAL_BACKEND_CODES = new Set([
  "FORMAT_UNSUPPORTED",
  "SOURCE_TOO_LARGE",
  "UPLOAD_INTEGRITY",
  "VALIDATION",
]);

/** Повтор не поможет: неверный формат/размер/целостность или отклонённый запрос. */
export function isTerminalBackendBookError(error: unknown): boolean {
  if (!(error instanceof BackendBookError)) return false;
  if ([400, 413, 422].includes(error.status)) return true;
  return Boolean(error.backendCode && TERMINAL_BACKEND_CODES.has(error.backendCode));
}

const mimeTypes: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  txt: "text/plain",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/zip",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook",
  cbz: "application/vnd.comicbook+zip",
  umd: "application/octet-stream",
};

async function bindBook(book: Book, signal: AbortSignal) {
  const store = useNarraStore.getState();
  const original = store.books[book.id]?.backendOriginalSource;
  let binding = store.books[book.id]?.backendBinding;
  if (binding && expiredEditions.has(binding.bookEditionId)) binding = undefined;
  // A cancelled upload can have reached the server without its response reaching
  // the client. Resolve again before repeating PUT for a retained uncertain binding.
  if (binding?.resolution === "private" && !binding.sourceUploaded) binding = undefined;
  if (!binding && book.sourceKind === "catalog") {
    if (!book.bookEditionId || !book.contentHash)
      throw new Error("Catalog book has no server identity");
    binding = {
      bookEditionId: book.bookEditionId,
      resolution: "catalog" as const,
      language: normalizeBookLanguage(book.meta.language),
      catalogKey: book.catalogKey,
      contentSha256: book.contentHash,
      sourceUploaded: true,
    };
  }
  if (!binding) {
    const path = await sourcePath(book);
    const hash = original?.hash ?? book.contentHash ?? (await sha256BackendFile(path));
    if (signal.aborted) throw new Error("Book binding cancelled");
    // Persist once; subsequent resolve/open never hashes unchanged bytes again.
    if (!book.contentHash)
      await useLibraryStore.getState().updateBook(book.id, { contentHash: hash });
    let response = await backendBookRequest(
      "/v2/books/resolve",
      backendJsonPost({ source: "local", content_sha256: hash }, signal),
    );
    if (response.resolution === "local_registration_required") {
      const uploadFormat = original?.format ?? book.format;
      if (!SUPPORTED_BACKEND_FORMATS.has(uploadFormat)) {
        // Раньше gateway отвечал 400 VALIDATION, а сессия повторяла bind
        // каждые 5–60 с до дедлайна — без единого сообщения читателю.
        throw new BackendBookError(400, {
          code: "FORMAT_UNSUPPORTED",
          error: `Формат ${uploadFormat} не поддерживается разметкой книги`,
        });
      }
      response = await backendBookRequest(
        "/v2/books/local",
        backendJsonPost(
          {
            content_sha256: hash,
            title: book.meta.title,
            author: book.meta.author,
            format: original?.format ?? book.format,
            ...(normalizeBookLanguage(book.meta.language)
              ? { language: normalizeBookLanguage(book.meta.language) }
              : {}),
          },
          signal,
        ),
      );
    }
    binding = parseBackendBinding(response, hash);
  }
  if (signal.aborted) throw new Error("Book binding cancelled");
  store.setBackendBinding(book.id, binding);
  await applyBookLanguage(book.id, binding.language);
  if (binding.resolution === "private" && !binding.sourceUploaded) {
    // Passing expo-file-system's File directly makes expo/fetch normalize the
    // Blob before it creates the native request. On iOS that conversion can
    // stall, leaving the private edition registered but with no source bytes.
    // Read the file explicitly so fetch receives an unambiguous binary body.
    const sourceFile = new File(await sourcePath(book));
    const sourceBytes = await sourceFile.bytes();
    if (sourceBytes.byteLength === 0) throw new Error("Book source is empty");
    if (sourceBytes.byteLength > MAX_BACKEND_SOURCE_BYTES) {
      // Зеркало BOOK_UPLOAD_MAX_MIB на gateway: иначе PUT получал 413 и файл
      // отправлялся заново на каждом повторе сессии.
      throw new BackendBookError(413, {
        code: "SOURCE_TOO_LARGE",
        error: "Файл больше 50 МиБ — сервер не примет его для разметки",
      });
    }
    const response = await backendBookRequest(backendBookPath(binding.bookEditionId, "source"), {
      method: "PUT",
      headers: {
        "content-type": mimeTypes[original?.format ?? book.format] ?? "application/octet-stream",
      },
      body: sourceBytes,
      signal,
    });
    if (signal.aborted) throw new Error("Source upload cancelled");
    binding = {
      ...binding,
      sourceUploaded: true,
      expiresAt: typeof response.expires_at === "string" ? response.expires_at : binding.expiresAt,
    };
    store.setBackendBinding(book.id, binding);
  }
  if (binding.resolution === "catalog" && book.sourceKind !== "catalog") {
    await useLibraryStore.getState().updateBook(book.id, {
      sourceKind: "catalog",
      bookEditionId: binding.bookEditionId,
      catalogKey: binding.catalogKey,
      contentHash: binding.contentSha256,
      revisionId: binding.contentSha256,
    });
  }
  return binding;
}

async function applyBookLanguage(bookId: string, language: unknown) {
  const normalized = normalizeBookLanguage(language);
  const current = useLibraryStore.getState().books.find((item) => item.id === bookId);
  // Old/null responses must not erase a language read from the local file.
  if (normalized && current && !current.deletedAt && current.meta.language !== normalized)
    await useLibraryStore
      .getState()
      .updateBook(bookId, { meta: { ...current.meta, language: normalized } });
}

function createSession(book: Book, progress: number) {
  return new BackendBookSession(
    {
      bind: async (signal) => {
        // All screens for a book share one upload and one request sequence.
        let active = bindings.get(book.id);
        if (active) {
          try {
            await active;
          } catch {
            /* A previous session may have been cancelled. */
          }
        }
        if (signal.aborted) throw new Error("Book binding cancelled");
        const current =
          useLibraryStore.getState().books.find((item) => item.id === book.id) ?? book;
        active = bindBook(current, signal);
        bindings.set(book.id, active);
        try {
          return await active;
        } finally {
          if (bindings.get(book.id) === active) bindings.delete(book.id);
        }
      },
      progress: (binding, value, signal) =>
        postBackendProgress(binding.bookEditionId, value, signal),
      manifest: async (binding, signal) =>
        parseBackendManifest(
          await backendBookRequest(backendBookPath(binding.bookEditionId, "manifest"), { signal }),
        ),
      identity: async (binding, signal) => {
        const result = await backendBookRequest(
          backendBookPath(binding.bookEditionId, "identity"),
          { signal },
        );
        if (signal.aborted) return { pending: false, delay: 5000 };
        if (
          result.status === "ready" &&
          typeof result.title === "string" &&
          typeof result.author === "string"
        ) {
          const current = useLibraryStore.getState().books.find((item) => item.id === book.id);
          if (
            current &&
            !current.deletedAt &&
            (current.meta.title !== result.title || current.meta.author !== result.author)
          )
            await useLibraryStore.getState().updateBook(book.id, {
              meta: { ...current.meta, title: result.title, author: result.author },
            });
        }
        if (result.status === "failed")
          status(book.id, { identityError: String(result.error_code ?? "IDENTITY_FAILED") });
        return {
          pending: result.status === "processing",
          delay: typeof result.poll_after_ms === "number" ? result.poll_after_ms : 5000,
        };
      },
      publish: (manifest, value) => {
        const current = useLibraryStore.getState().books.find((item) => item.id === book.id);
        if (!current || current.deletedAt) return;
        void applyBookLanguage(book.id, manifest.language).catch(() => {
          console.warn("[Backend books] Could not persist book language");
        });
        useNarraStore.getState().applyBackendManifest(book.id, manifest, value);
        status(book.id, {
          manifest,
          error:
            manifest.availability === "unknown"
              ? "UNKNOWN_MANIFEST_STATE"
              : manifest.availability === "failed" || manifest.availability === "cancelled"
                ? (manifest.analysis?.errorCode ??
                  `ANALYSIS_${manifest.availability.toUpperCase()}`)
                : undefined,
        });
        if (current.sourceKind === "catalog" && manifest.availability === "processing")
          console.warn("[Backend books] Catalog manifest is unexpectedly processing");
      },
      media: (_manifest, value, signal) => loadBackendCharacterMedia(book.id, value, signal),
      error: (error) =>
        status(book.id, {
          error:
            error instanceof BackendBookError
              ? (error.backendCode ?? `HTTP_${error.status}`)
              : "CONNECTION",
        }),
      expired: (binding) => expiredEditions.add(binding.bookEditionId),
      isNotFound: (error) => error instanceof BackendBookError && error.status === 404,
      isTerminal: isTerminalBackendBookError,
    },
    progress,
  );
}

export function retainBackendBookSync(book: Book, progress = book.progress): () => void {
  let entry = sessions.get(book.id);
  if (!entry) {
    const session = createSession(book, progress);
    entry = { session, consumers: 0 };
    sessions.set(book.id, entry);
    session.start();
  }
  entry.consumers++;
  return () => {
    if (--entry.consumers === 0) {
      entry.session.stop();
      if (sessions.get(book.id) === entry) sessions.delete(book.id);
      useBackendBookStatus.setState((state) => {
        const books = { ...state.books };
        delete books[book.id];
        return { books };
      });
    }
  };
}
export function updateBackendBookProgress(bookId: string, progress: number) {
  sessions.get(bookId)?.session.update(progress);
}
export function retryBackendBookSync(bookId: string) {
  sessions.get(bookId)?.session.retry();
}

export async function retryBackendBookAnalysis(bookId: string): Promise<void> {
  const binding = useNarraStore.getState().books[bookId]?.backendBinding;
  if (!binding || binding.resolution !== "private") {
    status(bookId, { error: "ANALYSIS_RETRY_UNAVAILABLE", analysisRetrying: false });
    return;
  }
  status(bookId, { error: undefined, analysisRetrying: true });
  try {
    await postBackendAnalysisRetry(binding.bookEditionId, Crypto.randomUUID());
    status(bookId, { error: undefined, analysisRetrying: false });
    sessions.get(bookId)?.session.retry();
  } catch (error) {
    status(bookId, {
      error:
        error instanceof BackendBookError
          ? (error.backendCode ?? `HTTP_${error.status}`)
          : "CONNECTION",
      analysisRetrying: false,
    });
    throw error;
  }
}

const IMPORTED_BOOK_SYNC_DEADLINE_MS = 5 * 60_000;

/** Start server work for an explicitly imported file without blocking its local reader. */
export function startImportedBackendBook(book: Book): void {
  const stop = () => {
    clearTimeout(deadline);
    unsubscribe?.();
    release?.();
  };
  const deadline = setTimeout(stop, IMPORTED_BOOK_SYNC_DEADLINE_MS);
  const release = retainBackendBookSync(book);
  const unsubscribe = useBackendBookStatus.subscribe((state) => {
    const current = state.books[book.id];
    if (current?.manifest?.availability === "ready") stop();
  });
}
