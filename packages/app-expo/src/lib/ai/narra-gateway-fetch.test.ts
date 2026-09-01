import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGatewayResponseText } from "./narra-gateway-consumer";

const secureValues = vi.hoisted(() => new Map<string, string>());
const secureStore = vi.hoisted(() => ({
  deleteItemAsync: vi.fn(async (key: string) => {
    secureValues.delete(key);
  }),
  getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureValues.set(key, value);
  }),
}));
const cryptoMock = vi.hoisted(() => ({
  getRandomBytesAsync: vi.fn(async () => new Uint8Array(32).fill(7)),
  randomUUID: vi.fn(() => "22222222-2222-4222-8222-222222222222"),
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("expo-crypto", () => cryptoMock);
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

const INSTALLATION_ID_KEY = "narra.gateway.installation-id";
const INSTALLATION_SECRET_KEY = "narra.gateway.installation-secret";
const INSTALLATION_TOKEN_KEY = "narra.gateway.installation-token";
const INSTALLATION_TOKEN_EXPIRY_KEY = "narra.gateway.installation-token-expires-at";

function jsonResponse(status: number, payload: object, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function expoJsonResponse(status: number, payload: object): Response {
  const response = jsonResponse(status, payload);
  Object.defineProperty(response, "clone", {
    value: () => {
      throw new Error("Not implemented");
    },
  });
  return response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function pendingNativeBody(status = 200) {
  const body = deferred<ReadableStreamReadResult<Uint8Array>>();
  const cancellation = deferred<void>();
  const reader = {
    read: vi.fn(() => body.promise),
    cancel: vi.fn(() => cancellation.promise),
    releaseLock: vi.fn(),
  };
  const response = new Response(null, { status });
  Object.defineProperty(response, "body", { value: { getReader: () => reader } });
  return { response, reader, body, cancellation };
}

describe("Narra gateway installation recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    secureValues.clear();
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_URL = "https://gateway.test";
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "installation";
  });

  it("replaces a persisted identity rejected during refresh and retries once", async () => {
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "stale-secret");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(403, { code: "AUTH", error: "Installation proof отклонён" }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { token: "fresh-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    const response = await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v2\/installations\/refresh$/);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/v2\/installations\/register$/);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_ID_KEY);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_SECRET_KEY);
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer fresh-token",
    );
  });

  it("recovers when a previously valid token can no longer be refreshed", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, { token: "first-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(
        jsonResponse(401, { code: "AUTH", error: "Нужен действующий installation token" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(404, {
          code: "INSTALLATION_NOT_FOUND",
          error: "Установка больше не зарегистрирована",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { token: "second-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });
    const response = await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_TOKEN_KEY);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_TOKEN_EXPIRY_KEY);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalledWith(INSTALLATION_ID_KEY);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalledWith(INSTALLATION_SECRET_KEY);
    expect(String(fetchMock.mock.calls[3]?.[0])).toMatch(/\/v2\/installations\/refresh$/);
    expect(String(fetchMock.mock.calls[4]?.[0])).toMatch(/\/v2\/installations\/register$/);
    expect(new Headers(fetchMock.mock.calls[5]?.[1]?.headers).get("authorization")).toBe(
      "Bearer second-token",
    );
  });

  it("uses the gateway auth header when the human-readable error text changes", async () => {
    const tokenRejection = jsonResponse(401, {
      code: "AUTH",
      error: "Token expired",
    });
    tokenRejection.headers.set("x-narra-auth-error", "installation_token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, { token: "first-token", expires_in: 900 }))
      .mockResolvedValueOnce(tokenRejection)
      .mockResolvedValueOnce(jsonResponse(201, { token: "second-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    const response = await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("authorization")).toBe(
      "Bearer second-token",
    );
  });

  it("does not keep rotating identities after the recovery attempt fails", async () => {
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "stale-secret");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(404, {
          code: "INSTALLATION_NOT_FOUND",
          error: "Установка больше не зарегистрирована",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(403, { code: "AUTH", error: "Installation proof отклонён" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(403, { code: "AUTH", error: "Installation proof отклонён" }),
      );
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    await expect(
      gateway.narraGatewayRequest("/v2/media/images", { method: "POST" }),
    ).rejects.toMatchObject({ code: "AUTH" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_ID_KEY);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(INSTALLATION_SECRET_KEY);
  });

  it("does not replace a revoked installation", async () => {
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "revoked-secret");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(403, { code: "AUTH", error: "Эта установка отозвана" }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    await expect(
      gateway.narraGatewayRequest("/v2/media/images", { method: "POST" }),
    ).rejects.toMatchObject({ code: "AUTH" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("does not retry a provider authorization failure as an installation failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, { token: "valid-token", expires_in: 900 }))
      .mockResolvedValueOnce(
        expoJsonResponse(401, {
          code: "AUTH",
          error: "Провайдер изображений отклонил ключ",
        }),
      );
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    const response = await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "AUTH",
      error: "Провайдер изображений отклонил ключ",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("restores a valid installation token after a cold JS reload", async () => {
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, { token: "persisted-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const firstGateway = await import("./narra-gateway-fetch");
    firstGateway.setNarraGatewayFetch(firstFetch);

    await firstGateway.narraGatewayRequest("/v2/media/images", { method: "POST" });
    expect(firstFetch).toHaveBeenCalledTimes(2);
    expect(secureValues.get(INSTALLATION_TOKEN_KEY)).toBe("persisted-token");
    expect(Number(secureValues.get(INSTALLATION_TOKEN_EXPIRY_KEY))).toBeGreaterThan(Date.now());
    expect(new Headers(firstFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer persisted-token",
    );

    vi.resetModules();
    const secondFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const secondGateway = await import("./narra-gateway-fetch");
    secondGateway.setNarraGatewayFetch(secondFetch);

    await secondGateway.narraGatewayRequest("/v2/media/images", { method: "POST" });
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(new Headers(secondFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer persisted-token",
    );
  });

  it("coalesces concurrent registration during a cold start", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, { token: "shared-token", expires_in: 900 }))
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    await Promise.all([
      gateway.narraGatewayRequest("/v2/media/images", { method: "POST" }),
      gateway.narraGatewayRequest("/v2/media/images", { method: "POST" }),
    ]);

    const registrationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/v2/installations/register"),
    );
    expect(registrationCalls).toHaveLength(1);
    expect(cryptoMock.randomUUID).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes an expired token for an existing installation without registering", async () => {
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "valid-secret");
    secureValues.set(INSTALLATION_TOKEN_KEY, "expired-token");
    secureValues.set(INSTALLATION_TOKEN_EXPIRY_KEY, String(Date.now() - 1));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { token: "refreshed-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    const response = await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v2\/installations\/refresh$/);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/v2\/media\/images$/);
    expect(secureValues.get(INSTALLATION_TOKEN_KEY)).toBe("refreshed-token");
    expect(Number(secureValues.get(INSTALLATION_TOKEN_EXPIRY_KEY))).toBeGreaterThan(Date.now());
  });

  it("registers an existing installation only after refresh returns 404", async () => {
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "valid-secret");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(404, {
          code: "INSTALLATION_NOT_FOUND",
          error: "Установка больше не зарегистрирована",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { token: "registered-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    await gateway.narraGatewayRequest("/v2/media/images", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v2\/installations\/refresh$/);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/v2\/installations\/register$/);
    const registration = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(registration.installation_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("classifies installation rate limits as RATE and preserves retry metadata", async () => {
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "valid-secret");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          { code: "RATE", error: "Слишком много запросов" },
          { "Retry-After": "12", "RateLimit-Reset": "1786525200" },
        ),
      );
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);

    await expect(
      gateway.narraGatewayRequest("/v2/media/images", { method: "POST" }),
    ).rejects.toMatchObject({
      code: "RATE",
      technicalDetail: "retry-after=12; ratelimit-reset=1786525200",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v2\/installations\/refresh$/);
  });
});

describe("Narra gateway build configuration", () => {
  it("uses the production gateway when a native build has no Expo environment", async () => {
    vi.resetModules();
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_URL = "";
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "";

    const gateway = await import("./narra-gateway-fetch");

    expect(gateway.getNarraGatewayConfig()).toEqual({
      baseUrl: "https://api.narra.disrupt.builders",
      authMode: "installation",
    });
    expect(gateway.getNarraGatewayConfig().baseUrl).not.toContain("api-test");
  });
});

describe("Narra gateway cancellation", () => {
  it("forwards caller cancellation to the active request", async () => {
    vi.resetModules();
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_URL = "https://gateway.test";
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "none";
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
      throw new Error("unreachable");
    });
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const controller = new AbortController();

    const request = gateway.narraGatewayRequest("/v2/books/book-1/source/download", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("Narra gateway consumed response lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    secureValues.clear();
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_URL = "https://gateway.test";
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "none";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());

  it("reads split UTF-8 chunks without calling the native text method and removes its deadline", async () => {
    const expected = "Книга — déjà vu 📖";
    const encoded = new TextEncoder().encode(expected);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, 1));
          controller.enqueue(encoded.slice(1, encoded.length - 1));
          controller.enqueue(encoded.slice(encoded.length - 1));
          controller.close();
        },
      }),
    );
    const nativeText = vi.spyOn(response, "text").mockImplementation(() => new Promise(() => {}));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      gateway.consumeNarraGatewayResponse(
        "/v2/books/catalog",
        { signal: controller.signal },
        readGatewayResponseText,
      ),
    ).resolves.toBe(expected);

    expect(nativeText).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an auth waiter without cancelling shared registration or dispatching its unused endpoint", async () => {
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "installation";
    const token = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(token.promise)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const controller = new AbortController();
    const cancelled = gateway.consumeNarraGatewayResponse(
      "/v2/books/catalog",
      { signal: controller.signal },
      readGatewayResponseText,
    );
    const cancelledResult = cancelled.catch((error: unknown) => error);
    const other = gateway.consumeNarraGatewayResponse(
      "/v2/books/genres",
      {},
      readGatewayResponseText,
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    const tokenSignal = fetchMock.mock.calls[0][1]?.signal;
    controller.abort();
    expect(await cancelledResult).toMatchObject({ name: "AbortError" });
    expect(tokenSignal?.aborted).toBe(false);
    token.resolve(jsonResponse(201, { token: "shared-token", expires_in: 900 }));
    await expect(other).resolves.toBe(JSON.stringify({ ok: true }));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://gateway.test/v2/installations/register",
      "https://gateway.test/v2/books/genres",
    ]);
    expect(secureValues.get(INSTALLATION_TOKEN_KEY)).toBe("shared-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a late shared auth rejection after its caller leaves and permits the next attempt", async () => {
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "installation";
    const token = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(token.promise)
      .mockResolvedValueOnce(jsonResponse(201, { token: "recovered-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const controller = new AbortController();
    const cancelled = gateway
      .consumeNarraGatewayResponse(
        "/v2/books/catalog",
        { signal: controller.signal },
        readGatewayResponseText,
      )
      .catch((error: unknown) => error);
    await flush();
    controller.abort();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    token.reject(new Error("late auth transport failure"));
    await flush();
    expect(secureValues.has(INSTALLATION_TOKEN_KEY)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      gateway.consumeNarraGatewayResponse("/v2/books/catalog", {}, readGatewayResponseText),
    ).resolves.toBe(JSON.stringify({ ok: true }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles caller abort after headers even when native read and cancellation never settle", async () => {
    const native = pendingNativeBody();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(native.response);
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const controller = new AbortController();
    const request = gateway
      .consumeNarraGatewayResponse(
        "/v2/books/catalog",
        { signal: controller.signal },
        readGatewayResponseText,
      )
      .catch((error: unknown) => error);
    await flush();
    expect(native.reader.read).toHaveBeenCalledOnce();
    controller.abort();
    expect(await request).toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(native.reader.cancel).toHaveBeenCalledOnce();
    expect(native.reader.releaseLock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // Both late errors must be observed; Vitest fails on unhandled rejection.
    native.body.reject(new Error("late native body error"));
    native.cancellation.reject(new Error("late native cancel error"));
    await flush();
  });

  it("settles caller abort before headers even when fetch does not reject until later", async () => {
    const headers = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(headers.promise);
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const controller = new AbortController();
    const request = gateway
      .consumeNarraGatewayResponse(
        "/v2/books/catalog",
        { signal: controller.signal },
        readGatewayResponseText,
      )
      .catch((error: unknown) => error);
    controller.abort();
    expect(await request).toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    headers.reject(new Error("late native headers error"));
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timeout budget across headers and a stalled body", async () => {
    const headers = deferred<Response>();
    const native = pendingNativeBody();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(headers.promise);
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const request = gateway
      .consumeNarraGatewayResponse("/v2/books/catalog", {}, readGatewayResponseText, 100)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(80);
    headers.resolve(native.response);
    await flush();
    expect(native.reader.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(await request).toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(native.reader.cancel).toHaveBeenCalledOnce();
    native.body.resolve({ done: true, value: undefined });
    native.cancellation.resolve();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the shared auth body at fifteen seconds and never persists its late token", async () => {
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "installation";
    const native = pendingNativeBody(201);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native.response)
      .mockResolvedValueOnce(jsonResponse(201, { token: "current-token", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const request = gateway
      .consumeNarraGatewayResponse("/v2/books/catalog", {}, readGatewayResponseText)
      .catch((error: unknown) => error);
    await flush();
    expect(native.reader.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await request).toMatchObject({ code: "TIMEOUT" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    native.body.resolve({
      done: false,
      value: new TextEncoder().encode(JSON.stringify({ token: "obsolete-token", expires_in: 900 })),
    });
    native.cancellation.resolve();
    await flush();
    expect(secureValues.has(INSTALLATION_TOKEN_KEY)).toBe(false);
    await expect(
      gateway.consumeNarraGatewayResponse("/v2/books/catalog", {}, readGatewayResponseText),
    ).resolves.toBe(JSON.stringify({ ok: true }));
    expect(secureValues.get(INSTALLATION_TOKEN_KEY)).toBe("current-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the fifteen-second auth budget per HTTP attempt during refresh-to-registration recovery", async () => {
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE = "installation";
    secureValues.set(INSTALLATION_ID_KEY, "11111111-1111-4111-8111-111111111111");
    secureValues.set(INSTALLATION_SECRET_KEY, "valid-secret");
    const refresh = deferred<Response>();
    const registration = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(registration.promise)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const request = gateway.consumeNarraGatewayResponse(
      "/v2/books/catalog",
      {},
      readGatewayResponseText,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(14_000);
    refresh.resolve(jsonResponse(404, { code: "INSTALLATION_NOT_FOUND" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_000);
    registration.resolve(jsonResponse(201, { token: "recovered-token", expires_in: 900 }));
    await expect(request).resolves.toBe(JSON.stringify({ ok: true }));
    expect(fetchMock.mock.calls.every(([, init]) => !init?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains raw streaming lifetimes beyond the consumed-response deadline", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const gateway = await import("./narra-gateway-fetch");
    gateway.setNarraGatewayFetch(fetchMock);
    const raw = await gateway.narraGatewayRequest("/v2/ai/chat/stream", { method: "POST" });
    await vi.advanceTimersByTimeAsync(180_001);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    stream.enqueue(new TextEncoder().encode("data: still streaming\n\n"));
    stream.close();
    await expect(raw.text()).resolves.toBe("data: still streaming\n\n");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Narra logical request identity", () => {
  it("adds one opaque request id before a request reaches an adapter", async () => {
    vi.resetModules();
    const gateway = await import("./narra-gateway-fetch");
    const adapter = vi.fn(async (_path: string, _init: RequestInit) =>
      jsonResponse(200, { ok: true }),
    );
    gateway.setNarraGatewayAdapter(adapter);

    await gateway.narraGatewayRequest("/v2/ai/chat/complete", {
      method: "POST",
      body: JSON.stringify({ purpose: "summary", messages: [] }),
    });

    const payload = JSON.parse(String(adapter.mock.calls[0]?.[1]?.body));
    expect(payload.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
