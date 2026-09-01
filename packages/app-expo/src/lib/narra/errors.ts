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
    /** Bounded server hint used only by retry-capable callers. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NarraServiceError";
  }
}

export function narraBackendCode(error: unknown): string | undefined {
  return error instanceof NarraServiceError ? error.backendCode : undefined;
}

const USER_MESSAGES: Record<NarraErrorCode, string> = {
  AUTH: "Сервис Narra отклонил авторизацию.",
  CONFIG: "Сервис Narra не настроен в этой сборке.",
  CONNECTION: "Не удалось связаться с сервисом Narra. Проверьте подключение.",
  RATE: "Слишком много запросов. Попробуйте немного позже.",
  REQUEST: "Не удалось подготовить запрос.",
  SERVICE: "Не получилось. Попробуйте снова.",
  TIMEOUT: "Сервис отвечает дольше обычного. Попробуйте ещё раз.",
};

export function narraErrorMessageForCode(code: NarraErrorCode): string {
  return USER_MESSAGES[code];
}

interface GatewayErrorBody {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  request_id?: unknown;
  retry_after_ms?: unknown;
}

function gatewayErrorBody(payload: unknown): GatewayErrorBody {
  return payload && typeof payload === "object" ? (payload as GatewayErrorBody) : {};
}

/** Maps the machine code + HTTP status of a gateway error response to a client code. */
export function narraErrorCodeForGatewayResponse(
  status: number,
  backendCode?: string,
): NarraErrorCode {
  const code = (backendCode ?? "").toUpperCase();
  if (status === 401 || status === 403 || code === "AUTH") return "AUTH";
  if (status === 429 || code === "RATE" || code === "RATE_LIMIT") return "RATE";
  if (status === 408 || status === 504 || code === "TIMEOUT" || code === "UPSTREAM_TIMEOUT") {
    return "TIMEOUT";
  }
  if (status === 400 || status === 413 || status === 422 || code === "VALIDATION") {
    return "REQUEST";
  }
  return "SERVICE";
}

/**
 * Builds a NarraServiceError from a non-OK gateway response without losing the
 * backend code, HTTP status and request id (B036). The user-facing message is
 * chosen by code; the raw gateway text stays in `technicalDetail` for logs.
 */
export function narraErrorFromGatewayResponse(options: {
  status: number;
  payload?: unknown;
  bodyText?: string;
  requestId?: string | null;
}): NarraServiceError {
  const body = gatewayErrorBody(options.payload);
  const backendCode = typeof body.code === "string" && body.code.trim() ? body.code : undefined;
  const code = narraErrorCodeForGatewayResponse(options.status, backendCode);
  const rawMessage =
    (typeof body.error === "string" && body.error) ||
    (typeof body.message === "string" && body.message) ||
    (options.bodyText ?? "").trim().slice(0, 300) ||
    `HTTP ${options.status}`;
  const requestId =
    (typeof body.request_id === "string" && body.request_id) || options.requestId || undefined;
  const retryAfterMs =
    typeof body.retry_after_ms === "number" && Number.isFinite(body.retry_after_ms)
      ? body.retry_after_ms
      : undefined;
  return new NarraServiceError(
    code,
    narraErrorMessageForCode(code),
    requestId,
    `${backendCode ?? "HTTP"} ${options.status}: ${rawMessage}`,
    backendCode,
    retryAfterMs,
  );
}

/** True when the error (or anything in its `cause` chain) is a Narra timeout. */
export function isNarraTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof NarraServiceError && current.code === "TIMEOUT") return true;
    if (typeof current === "object") {
      const named = current as { name?: unknown; code?: unknown; cause?: unknown };
      if (named.name === "TimeoutError" || named.code === "TIMEOUT") return true;
      current = named.cause;
    } else {
      break;
    }
  }
  return false;
}

export function normalizeNarraError(error: unknown): NarraServiceError {
  if (error instanceof NarraServiceError) return error;
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
        normalized.retryAfterMs,
      );
}
