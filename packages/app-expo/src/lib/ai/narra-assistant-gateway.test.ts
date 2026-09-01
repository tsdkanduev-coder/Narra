import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./narra-gateway-fetch", () => ({
  getNarraGatewayConfig: () => ({
    baseUrl: "https://gateway.test",
    authMode: "installation",
  }),
  narraGatewayRequest: vi.fn(),
}));

import type { AIConfig } from "@readany/core/types";
import {
  createNarraAssistantAIConfig,
  isNarraAssistantGatewayRequest,
  narraAssistantGatewayFetch,
} from "./narra-assistant-gateway";
import { narraGatewayRequest } from "./narra-gateway-fetch";

const baseConfig: AIConfig = {
  endpoints: [],
  activeEndpointId: "",
  activeModel: "",
  temperature: 0.7,
  maxTokens: 8192,
  slidingWindowSize: 8,
};

describe("Narra assistant Gateway adapter", () => {
  beforeEach(() => {
    vi.mocked(narraGatewayRequest).mockReset();
  });

  it("creates a runtime endpoint that never needs a user API key", () => {
    const config = createNarraAssistantAIConfig(baseConfig);

    expect(config.activeEndpointId).toBe("narra-gateway-assistant");
    expect(config.activeModel).toBe("narra-assistant");
    expect(config.endpoints).toHaveLength(1);
    expect(config.endpoints[0]).toMatchObject({
      provider: "custom",
      baseUrl: "https://gateway.test/v2/ai/chat/stream",
      useExactRequestUrl: true,
    });
    expect(isNarraAssistantGatewayRequest(config.endpoints[0]?.baseUrl ?? "")).toBe(true);
  });

  it("removes client provider fields and preserves tools in a streaming request", async () => {
    const response = new Response("data: [DONE]\n\n", { status: 200 });
    vi.mocked(narraGatewayRequest).mockResolvedValue(response);
    const tools = [
      {
        type: "function",
        function: {
          name: "list_books",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    await narraAssistantGatewayFetch("https://gateway.test/v2/ai/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        model: "must-not-reach-gateway",
        api_key: "must-not-reach-gateway",
        stream: true,
        max_tokens: 8192,
        messages: [{ role: "user", content: "Что я читаю?" }],
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
      }),
    });

    expect(narraGatewayRequest).toHaveBeenCalledOnce();
    const [path, init] = vi.mocked(narraGatewayRequest).mock.calls[0] ?? [];
    expect(path).toBe("/v2/ai/chat/stream");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      messages: [{ role: "user", content: "Что я читаю?" }],
      purpose: "assistant",
      origin: "user",
      analytics_tier: "essential",
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("api_key");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("uses the complete route for non-streaming memory compression", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValue(new Response("{}", { status: 200 }));

    await narraAssistantGatewayFetch("https://gateway.test/v2/ai/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [{ role: "user", content: "Summarize" }],
      }),
    });

    expect(narraGatewayRequest).toHaveBeenCalledWith(
      "/v2/ai/chat/complete",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("Narra assistant non-stream completions", () => {
  beforeEach(() => {
    vi.mocked(narraGatewayRequest).mockReset();
  });

  it("wraps /v2/ai/chat/complete as an OpenAI chat completion for LangChain", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "Краткая память треда.", request_id: "req-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await narraAssistantGatewayFetch("https://gateway.test/v2/ai/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        stream: false,
        messages: [{ role: "user", content: "Сожми историю" }],
      }),
    });

    expect(vi.mocked(narraGatewayRequest).mock.calls[0]?.[0]).toBe("/v2/ai/chat/complete");
    const completion = (await response.json()) as {
      id: string;
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    expect(completion.id).toBe("req-1");
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0]?.message).toEqual({
      role: "assistant",
      content: "Краткая память треда.",
    });
    expect(completion.choices[0]?.finish_reason).toBe("stop");
  });

  it("passes gateway errors through untouched", async () => {
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Лимит", code: "RATE" }), { status: 429 }),
    );

    const response = await narraAssistantGatewayFetch("https://gateway.test/v2/ai/chat/stream", {
      method: "POST",
      body: JSON.stringify({ stream: false, messages: [] }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Лимит", code: "RATE" });
  });
});
