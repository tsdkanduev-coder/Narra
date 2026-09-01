import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { NarraServiceError } from "../narra/errors";
import {
  type GatewayConsumerScope,
  readGatewayResponseText,
  withGatewayConsumer,
} from "./narra-gateway-consumer";

const INSTALLATION_ID_KEY = "narra.gateway.installation-id";
const INSTALLATION_SECRET_KEY = "narra.gateway.installation-secret";
const INSTALLATION_TOKEN_KEY = "narra.gateway.installation-token";
const INSTALLATION_TOKEN_EXPIRY_KEY = "narra.gateway.installation-token-expires-at";
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 150_000;
// Только legacy synchronous cover route держит длинное соединение. Durable
// cover-job POST/GET короткие и используют обычный сетевой таймаут.
const COVER_TIMEOUT_MS = 180_000;
const INSTALLATION_TIMEOUT_MS = 15_000;
/** Canon from services/narra-gateway/README.md — current mobile builds. Do not invent another host. */
const DEFAULT_NARRA_GATEWAY_URL = "https://api-test.narra.disrupt.builders";

type NarraGatewayAdapter = (path: string, init: RequestInit) => Promise<Response>;

interface InstallationIdentity {
  installationId: string;
  installationSecret: string;
}

interface GatewayToken {
  value: string;
  expiresAt: number;
}

let configuredAdapter: NarraGatewayAdapter | null = null;
let configuredFetch: typeof globalThis.fetch = expoFetch as typeof globalThis.fetch;
let cachedIdentity: InstallationIdentity | null = null;
let cachedIdentityNeedsRegistration = false;
let identityPromise: Promise<InstallationIdentity> | null = null;
let cachedToken: GatewayToken | null = null;
let tokenHydrated = false;
let tokenHydrationPromise: Promise<void> | null = null;
let tokenPromise: Promise<string> | null = null;

export interface NarraGatewayConfig {
  baseUrl: string;
  authMode: "none" | "installation";
}

export function getNarraGatewayConfig(): NarraGatewayConfig {
  const configuredUrl = process.env.EXPO_PUBLIC_NARRA_GATEWAY_URL?.trim().replace(/\/+$/, "");
  const baseUrl = configuredUrl || DEFAULT_NARRA_GATEWAY_URL;
  const authMode =
    process.env.EXPO_PUBLIC_NARRA_GATEWAY_AUTH_MODE === "none" ? "none" : "installation";
  return { baseUrl, authMode };
}

/** Allows a host app or test to provide the backend contract without patching global fetch. */
export function setNarraGatewayAdapter(adapter: NarraGatewayAdapter | null): void {
  configuredAdapter = adapter;
}

export function setNarraGatewayFetch(fetchImpl: typeof globalThis.fetch): void {
  configuredFetch = fetchImpl;
}

function requireGatewayUrl(): string {
  const { baseUrl } = getNarraGatewayConfig();
  if (!baseUrl) {
    throw new NarraServiceError(
      "CONFIG",
      "EXPO_PUBLIC_NARRA_GATEWAY_URL is not configured for this build",
    );
  }
  return baseUrl;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet[(value >> 18) & 63];
    output += alphabet[(value >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(value >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getInstallationIdentity(): Promise<InstallationIdentity> {
  if (cachedIdentity) return cachedIdentity;
  if (!identityPromise) {
    identityPromise = (async () => {
      let installationId = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
      let installationSecret = await SecureStore.getItemAsync(INSTALLATION_SECRET_KEY);
      cachedIdentityNeedsRegistration = !installationId || !installationSecret;
      if (!installationId || !installationSecret) {
        installationId = Crypto.randomUUID();
        installationSecret = base64Url(await Crypto.getRandomBytesAsync(32));
        await Promise.all([
          SecureStore.setItemAsync(INSTALLATION_ID_KEY, installationId),
          SecureStore.setItemAsync(INSTALLATION_SECRET_KEY, installationSecret),
        ]);
      }
      const identity = { installationId, installationSecret };
      cachedIdentity = identity;
      return identity;
    })().finally(() => {
      identityPromise = null;
    });
  }
  return identityPromise;
}

async function hydrateInstallationToken(): Promise<void> {
  if (tokenHydrated) return;
  if (!tokenHydrationPromise) {
    tokenHydrationPromise = (async () => {
      const [value, rawExpiresAt] = await Promise.all([
        SecureStore.getItemAsync(INSTALLATION_TOKEN_KEY),
        SecureStore.getItemAsync(INSTALLATION_TOKEN_EXPIRY_KEY),
      ]);
      const expiresAt = Number(rawExpiresAt);
      cachedToken =
        value && Number.isFinite(expiresAt) && expiresAt > 0 ? { value, expiresAt } : null;
      tokenHydrated = true;
    })().finally(() => {
      tokenHydrationPromise = null;
    });
  }
  await tokenHydrationPromise;
}

async function persistInstallationToken(token: GatewayToken): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(INSTALLATION_TOKEN_KEY, token.value),
    SecureStore.setItemAsync(INSTALLATION_TOKEN_EXPIRY_KEY, String(token.expiresAt)),
  ]);
  cachedToken = token;
  tokenHydrated = true;
}

async function clearInstallationToken(): Promise<void> {
  cachedToken = null;
  tokenHydrated = true;
  await Promise.all([
    SecureStore.deleteItemAsync(INSTALLATION_TOKEN_KEY),
    SecureStore.deleteItemAsync(INSTALLATION_TOKEN_EXPIRY_KEY),
  ]);
}

async function resetInstallationIdentity(): Promise<void> {
  cachedIdentity = null;
  cachedIdentityNeedsRegistration = false;
  identityPromise = null;
  cachedToken = null;
  tokenHydrated = true;
  await Promise.all([
    SecureStore.deleteItemAsync(INSTALLATION_ID_KEY),
    SecureStore.deleteItemAsync(INSTALLATION_SECRET_KEY),
    SecureStore.deleteItemAsync(INSTALLATION_TOKEN_KEY),
    SecureStore.deleteItemAsync(INSTALLATION_TOKEN_EXPIRY_KEY),
  ]);
}

interface GatewayErrorPayload {
  message: string;
  code?: string;
  authError?: string;
  retryAfter?: string;
  rateLimitReset?: string;
  response: Response;
}

async function readGatewayError(
  response: Response,
  consumedBody?: string,
): Promise<GatewayErrorPayload> {
  // expo/fetch currently throws from Response.clone() on native. Read the
  // error body once and recreate a response for callers that still need it.
  const body = consumedBody ?? (await response.text().catch(() => ""));
  let payload: { error?: string; message?: string; code?: string } | null = null;
  try {
    payload = JSON.parse(body) as { error?: string; message?: string; code?: string };
  } catch {
    // Non-JSON provider errors still fall back to the raw body below.
  }
  return {
    message:
      payload?.error ||
      payload?.message ||
      payload?.code ||
      body.trim() ||
      `HTTP ${response.status}`,
    code: payload?.code,
    authError: response.headers.get("x-narra-auth-error") ?? undefined,
    retryAfter: response.headers.get("retry-after") ?? undefined,
    rateLimitReset: response.headers.get("ratelimit-reset") ?? undefined,
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

function canResetRejectedIdentity(response: Response, error: GatewayErrorPayload): boolean {
  if (
    response.status === 403 &&
    error.code === "AUTH" &&
    error.message === "Installation proof отклонён"
  ) {
    return true;
  }
  return (
    response.status === 400 &&
    error.code === "VALIDATION" &&
    error.message === "Некорректный installation secret"
  );
}

function rateLimitTechnicalDetail(error: GatewayErrorPayload): string | undefined {
  const values = [
    error.retryAfter ? `retry-after=${error.retryAfter}` : "",
    error.rateLimitReset ? `ratelimit-reset=${error.rateLimitReset}` : "",
  ].filter(Boolean);
  return values.length > 0 ? values.join("; ") : undefined;
}

function isInstallationTokenRejection(response: Response, error: GatewayErrorPayload): boolean {
  return (
    response.status === 401 &&
    (error.authError === "installation_token" ||
      (error.code === "AUTH" && error.message === "Нужен действующий installation token"))
  );
}

async function requestInstallationToken(
  mode: "register" | "refresh",
  allowIdentityReset = true,
): Promise<string> {
  const identity = await getInstallationIdentity();
  // The shared token request has its own deadline. Cancelling one catalog
  // consumer must not cancel authentication needed by other gateway callers.
  const { response, body } = await withGatewayConsumer(
    async (scope) => {
      const response = await scope.wait(
        configuredFetch(`${requireGatewayUrl()}/v2/installations/${mode}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            mode === "register"
              ? {
                  installation_id: identity.installationId,
                  installation_secret: identity.installationSecret,
                  app_version: "narra-expo",
                  platform: process.env.EXPO_OS || "react-native",
                  arch: "react-native",
                }
              : {
                  installation_id: identity.installationId,
                  installation_secret: identity.installationSecret,
                },
          ),
          signal: scope.signal,
        }),
      );
      return { response, body: await readGatewayResponseText(response, scope) };
    },
    { timeoutMs: INSTALLATION_TIMEOUT_MS },
  );
  if (!response.ok) {
    if (mode === "refresh" && response.status === 404) {
      return requestInstallationToken("register", allowIdentityReset);
    }
    const error = await readGatewayError(response, body);
    // A keychain restore or an interrupted app update can leave a locally persisted
    // installation ID paired with a secret the gateway no longer recognizes. That
    // is recoverable and is distinct from an explicitly revoked installation.
    if (allowIdentityReset && canResetRejectedIdentity(response, error)) {
      await resetInstallationIdentity();
      return requestInstallationToken("register", false);
    }
    const code = response.status === 429 || error.code === "RATE" ? "RATE" : "AUTH";
    throw new NarraServiceError(
      code,
      error.message,
      undefined,
      code === "RATE" ? rateLimitTechnicalDetail(error) : undefined,
    );
  }
  const payload = JSON.parse(body) as { token?: string; expires_in?: number };
  if (!payload.token) throw new NarraServiceError("AUTH", "Gateway returned no token");
  const configuredExpiresIn = Number(payload.expires_in);
  const expiresIn = Number.isFinite(configuredExpiresIn) ? Math.max(60, configuredExpiresIn) : 900;
  const token = {
    value: payload.token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  await persistInstallationToken(token);
  cachedIdentityNeedsRegistration = false;
  return token.value;
}

async function getInstallationToken(forceRefresh = false): Promise<string> {
  await getInstallationIdentity();
  await hydrateInstallationToken();
  if (cachedIdentityNeedsRegistration && cachedToken) {
    await clearInstallationToken();
  }
  if (!forceRefresh && cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return cachedToken.value;
  }
  if (!tokenPromise) {
    const mode = forceRefresh || !cachedIdentityNeedsRegistration ? "refresh" : "register";
    tokenPromise = requestInstallationToken(mode).finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

async function directGatewayRequest(
  path: string,
  init: RequestInit,
  scope?: GatewayConsumerScope,
): Promise<Response> {
  const config = getNarraGatewayConfig();
  const url = `${requireGatewayUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const send = async (forceRefresh = false) => {
    scope?.throwIfAborted();
    const headers = new Headers(init.headers);
    if (config.authMode === "installation") {
      const token = scope
        ? await scope.wait(getInstallationToken(forceRefresh))
        : await getInstallationToken(forceRefresh);
      headers.set("authorization", `Bearer ${token}`);
    }
    if (scope) {
      scope.throwIfAborted();
      return scope.wait(configuredFetch(url, { ...init, headers, signal: scope.signal }));
    }
    // Raw streaming callers retain their existing headers-only lifecycle.
    const controller = new AbortController();
    const requestTimeout =
      path === "/v2/media/cover"
        ? COVER_TIMEOUT_MS
        : path.startsWith("/v2/media/images")
          ? IMAGE_TIMEOUT_MS
          : DEFAULT_TIMEOUT_MS;
    const externalSignal = init.signal;
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), requestTimeout);
    try {
      return await configuredFetch(url, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
  let response = await send();
  if (config.authMode === "installation" && response.status === 401) {
    const body = scope ? await readGatewayResponseText(response, scope) : undefined;
    const error = await readGatewayError(response, body);
    if (isInstallationTokenRejection(response, error)) {
      scope?.throwIfAborted();
      if (scope) await scope.wait(clearInstallationToken());
      else await clearInstallationToken();
      response = await send(true);
    } else {
      response = error.response;
    }
  }
  return response;
}

export async function narraGatewayRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const request = withLogicalRequestId(path, init);
  return configuredAdapter ? configuredAdapter(path, request) : directGatewayRequest(path, request);
}

/** Opt-in complete-response lifecycle; raw chat/TTS streams keep their own lifetime. */
export function consumeNarraGatewayResponse<T>(
  path: string,
  init: RequestInit,
  consume: (response: Response, scope: GatewayConsumerScope) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const request = withLogicalRequestId(path, init);
  return withGatewayConsumer(
    async (scope) => {
      const scopedRequest = { ...request, signal: scope.signal };
      const response = configuredAdapter
        ? await scope.wait(configuredAdapter(path, scopedRequest))
        : await directGatewayRequest(path, scopedRequest, scope);
      scope.throwIfAborted();
      return scope.wait(consume(response, scope));
    },
    { signal: init.signal, timeoutMs },
  );
}

/**
 * One client action keeps one identity across provider retries and fallbacks.
 * The gateway owns provider telemetry; callers cannot select provider/model.
 */
function withLogicalRequestId(path: string, init: RequestInit): RequestInit {
  if (!path.startsWith("/v2/ai/chat/") || typeof init.body !== "string") return init;
  try {
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    if (typeof payload.request_id === "string") return init;
    return { ...init, body: JSON.stringify({ ...payload, request_id: Crypto.randomUUID() }) };
  } catch {
    return init;
  }
}
