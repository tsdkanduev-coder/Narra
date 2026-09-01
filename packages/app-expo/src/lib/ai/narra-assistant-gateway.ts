import type { AIConfig, AIEndpoint } from "@readany/core/types";
import { getNarraGatewayConfig, narraGatewayRequest } from "./narra-gateway-fetch";

const NARRA_ASSISTANT_ENDPOINT_ID = "narra-gateway-assistant";
const NARRA_ASSISTANT_MODEL = "narra-assistant";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.clone().text();
  }
  throw new Error("Narra assistant request has no JSON body");
}

export function createNarraAssistantAIConfig(base: AIConfig): AIConfig {
  const endpoint: AIEndpoint = {
    id: NARRA_ASSISTANT_ENDPOINT_ID,
    name: "Narra Gateway",
    provider: "custom",
    // This is a non-secret marker required by the generic OpenAI client.
    // The fetch adapter replaces it with the installation token server-side.
    apiKey: "gateway-managed",
    baseUrl: `${getNarraGatewayConfig().baseUrl}/v2/ai/chat/stream`,
    useExactRequestUrl: true,
    models: [NARRA_ASSISTANT_MODEL],
    modelsFetched: true,
  };

  return {
    ...base,
    endpoints: [endpoint],
    activeEndpointId: endpoint.id,
    activeModel: NARRA_ASSISTANT_MODEL,
  };
}

export function isNarraAssistantGatewayRequest(input: RequestInfo | URL): boolean {
  const expected = `${getNarraGatewayConfig().baseUrl}/v2/ai/chat/stream`;
  return requestUrl(input).replace(/\/+$/, "") === expected;
}

/**
 * Adapts the OpenAI-compatible payload emitted by LangChain to Narra Gateway.
 * Provider/model selection and credentials stay server-side; tool calls remain
 * available so Narra can search the user's local library between LLM turns.
 */
export async function narraAssistantGatewayFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const source = JSON.parse(await requestBody(input, init)) as Record<string, unknown>;
  const stream = source.stream !== false;
  const body = {
    messages: source.messages,
    purpose: "assistant",
    origin: "user",
    analytics_tier: "essential",
    ...(source.tools === undefined ? {} : { tools: source.tools }),
    ...(source.tool_choice === undefined ? {} : { tool_choice: source.tool_choice }),
    ...(source.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: source.parallel_tool_calls }),
  };

  const response = await narraGatewayRequest(
    stream ? "/v2/ai/chat/stream" : "/v2/ai/chat/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal:
        init?.signal ??
        (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined),
    },
  );
  if (stream || !response.ok) return response;
  return wrapCompleteResponse(response);
}

/**
 * `/v2/ai/chat/complete` отвечает `{ text }`, а LangChain ждёт OpenAI
 * chat.completion. Без обёртки non-stream вызовы (сжатие памяти треда при
 * ≥12 сообщениях) получали пустой ответ: лишний полный вызов LLM на каждое
 * сообщение, а память треда никогда не сохранялась (C3-1).
 */
export async function wrapCompleteResponse(response: Response): Promise<Response> {
  const raw = await response.text();
  let payload: { text?: unknown; request_id?: unknown } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    payload = { text: raw };
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  const id =
    typeof payload.request_id === "string" && payload.request_id
      ? payload.request_id
      : `narra-${Date.now()}`;
  const completion = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: NARRA_ASSISTANT_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(completion), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
