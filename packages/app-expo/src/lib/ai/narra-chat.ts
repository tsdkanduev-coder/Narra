/**
 * Чат персонажа через Narra Gateway (`/v2/ai/chat/complete`).
 *
 * Раньше этот путь шёл прямо в OpenRouter (openrouter-chat.ts), чтобы не
 * зависеть от installation-авторизации шлюза. Теперь бэкенд снова единая точка:
 * модель и ключ живут на сервере, приложение отдаёт только сообщения.
 *
 * Отличие от прежнего контракта: `max_tokens` шлюз не принимает — длину ответа
 * задаёт сервер. Ретраи и таймауты тоже на стороне narraGatewayRequest.
 */

import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";

import { NarraServiceError, normalizeNarraError } from "../narra/errors";

export interface NarraChatMessageInput {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface NarraChatRequest {
  messages: NarraChatMessageInput[];
  temperature?: number;
  /** Назначение запроса для серверных лимитов и телеметрии. */
  purpose?: "character_chat" | "structured_task" | "summary" | "scenario" | "memory";
  origin?: "user" | "background";
  analyticsTier?: "none" | "essential";
  /** Каноническое издание для GET /v2/books/:id/search до ответа модели. */
  bookEditionId?: string;
}

type ChatCompletionResponse = {
  text?: string;
  content?: string;
  error?: string;
  code?: string;
  request_id?: string;
};

async function readCompletion(response: Response): Promise<string> {
  const body = await response.text();
  let payload: ChatCompletionResponse | null = null;
  try {
    payload = JSON.parse(body) as ChatCompletionResponse;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new NarraServiceError(
      "SERVICE",
      payload?.error || `Chat request failed (${response.status})`,
      payload?.request_id,
      undefined,
      payload?.code,
    );
  }
  const content = (payload?.text || payload?.content || (payload ? "" : body)).trim();
  if (!content) throw new NarraServiceError("SERVICE", "Сервис вернул пустой ответ.");
  return content;
}

export async function completeNarraChat(request: NarraChatRequest): Promise<string> {
  try {
    const origin = request.origin ?? "user";
    const response = await narraGatewayRequest("/v2/ai/chat/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: request.messages,
        temperature: request.temperature ?? 0.8,
        purpose: request.purpose ?? "character_chat",
        origin,
        analytics_tier: request.analyticsTier ?? (origin === "background" ? "none" : "essential"),
        ...(request.bookEditionId ? { book_edition_id: request.bookEditionId } : {}),
      }),
    });
    return await readCompletion(response);
  } catch (error) {
    throw normalizeNarraError(error);
  }
}
