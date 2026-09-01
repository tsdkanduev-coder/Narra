export type NarraErrorCode =
  | "AUTH"
  | "CONFIG"
  | "CONNECTION"
  | "RATE"
  | "REQUEST"
  | "SERVICE"
  | "TIMEOUT";

export class NarraServiceError extends Error {
  constructor(
    public readonly code: NarraErrorCode,
    message: string,
    public readonly requestId?: string,
    public readonly technicalDetail?: string,
    /**
     * Машинный код бэкенда (`VALIDATION`, `NOT_FOUND`, `DOWNLOAD_UNAVAILABLE`
     * и другие). В отличие от `technicalDetail` пользователю не
     * показывается: он нужен, чтобы вызывающий код мог отличить «этого нет
     * совсем» от «сейчас недоступно» и решить, повторять ли попытку.
     */
    public readonly backendCode?: string,
  ) {
    super(message);
    this.name = "NarraServiceError";
  }
}

export function narraBackendCode(error: unknown): string | undefined {
  return error instanceof NarraServiceError ? error.backendCode : undefined;
}

export function searchNotReadyCode(
  error: unknown,
): "SEARCH_NOT_READY" | "SEMANTIC_SEARCH_NOT_READY" | undefined {
  const backend = narraBackendCode(error);
  if (backend === "SEARCH_NOT_READY" || backend === "SEMANTIC_SEARCH_NOT_READY") {
    return backend;
  }
  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (/SEMANTIC_SEARCH_NOT_READY/.test(detail)) return "SEMANTIC_SEARCH_NOT_READY";
  if (/SEARCH_NOT_READY/.test(detail)) return "SEARCH_NOT_READY";
  return undefined;
}

export function emptyBookSearchCode(error: unknown): "SEARCH_EMPTY" | undefined {
  if (narraBackendCode(error) === "SEARCH_EMPTY") return "SEARCH_EMPTY";
  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (/SEARCH_EMPTY|Ничего не найдено/.test(detail)) return "SEARCH_EMPTY";
  return undefined;
}

function searchNotReadyError(
  code: "SEARCH_NOT_READY" | "SEMANTIC_SEARCH_NOT_READY",
  requestId?: string,
  technicalDetail?: string,
): NarraServiceError {
  return new NarraServiceError(
    "SERVICE",
    `Поиск по книге ещё не готов (${code}). Ответ без книги недоступен.`,
    requestId,
    technicalDetail,
    code,
  );
}

export function normalizeNarraError(error: unknown): NarraServiceError {
  if (error instanceof NarraServiceError) {
    const readyCode = searchNotReadyCode(error);
    if (readyCode) {
      return searchNotReadyError(readyCode, error.requestId, error.technicalDetail);
    }
    if (emptyBookSearchCode(error)) {
      return new NarraServiceError(
        "SERVICE",
        "Ничего не найдено",
        error.requestId,
        error.technicalDetail,
        "SEARCH_EMPTY",
      );
    }
    return error;
  }
  const readyCode = searchNotReadyCode(error);
  if (readyCode) {
    const detail = error instanceof Error ? error.message : String(error);
    return searchNotReadyError(readyCode, undefined, detail);
  }
  if (emptyBookSearchCode(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    return new NarraServiceError("SERVICE", "Ничего не найдено", undefined, detail, "SEARCH_EMPTY");
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (/NARRA_GATEWAY_URL|not configured/i.test(detail)) {
    return new NarraServiceError("CONFIG", "Сервис Narra не настроен в этой сборке.");
  }
  if (/^TIMEOUT$|timeout|timed out|aborted/i.test(detail)) {
    return new NarraServiceError("TIMEOUT", "Сервис отвечает дольше обычного. Попробуйте ещё раз.");
  }
  if (/^NETWORK$|xhr|status 0|network request failed|failed to fetch|network error/i.test(detail)) {
    return new NarraServiceError(
      "CONNECTION",
      "Не удалось связаться с сервисом Narra. Проверьте подключение.",
    );
  }
  if (/^AUTH$|401|403|authoriz|auth/i.test(detail)) {
    return new NarraServiceError("AUTH", "Сервис Narra отклонил авторизацию.");
  }
  if (/^RATE$|429|rate|quota|лимит/i.test(detail)) {
    return new NarraServiceError("RATE", "Слишком много запросов. Попробуйте немного позже.");
  }
  if (/^VALIDATION$|validation|400\b/i.test(detail)) {
    return new NarraServiceError("REQUEST", "Не удалось подготовить запрос.");
  }
  if (
    /No text could be extracted|extracting a book text sample|book contains no readable|Failed to fetch|Load failed|No book data/i.test(
      detail,
    )
  ) {
    return new NarraServiceError("REQUEST", "Не удалось прочитать текст книги. Попробуйте снова.");
  }
  if (/AI response contains no character JSON|found no characters/i.test(detail)) {
    return new NarraServiceError(
      "SERVICE",
      "Сервис не распознал персонажей в ответе. Попробуйте снова.",
    );
  }
  if (/политик[А-Яа-яЁё]* безопасности|safety|content policy|moderation/iu.test(detail)) {
    return new NarraServiceError(
      "SERVICE",
      "Сервис отклонил эту сцену по правилам безопасности. Попробуйте другую страницу.",
    );
  }
  return new NarraServiceError("SERVICE", "Не получилось. Попробуйте снова.");
}

export function reportNarraError(scope: string, error: unknown): NarraServiceError {
  const normalized = normalizeNarraError(error);
  const detail = error instanceof Error ? error.message : String(error);
  console.warn("[NarraError]", {
    scope,
    code: normalized.code,
    backendCode: normalized.backendCode,
    detail,
    requestId: normalized.requestId,
  });
  return normalized.technicalDetail || error === normalized
    ? normalized
    : new NarraServiceError(
        normalized.code,
        normalized.message,
        normalized.requestId,
        detail,
        normalized.backendCode,
      );
}
