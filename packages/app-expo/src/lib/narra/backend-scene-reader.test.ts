import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateCreator } from "zustand";
const runtime = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock("@/stores/persist", () => ({
  withPersist: <T extends object>(_key: string, creator: StateCreator<T>) => creator,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "22222222-2222-4222-8222-222222222222" }));
vi.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: runtime.read,
  EncodingType: { Base64: "base64" },
}));
vi.mock("react-native", () => ({ AppState: { currentState: "active" } }));
vi.mock("./media", () => ({
  normalizePersistedNarraMediaUri: (uri: string) =>
    uri.replace("file:///old/", "file:///documents/"),
}));
vi.mock("@/lib/diagnostics/diagnostics", async () => ({
  ...(await import("@/lib/diagnostics/diagnostic-journal")),
  recordDiagnostic: runtime.diagnostic,
}));
vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ consumeNarraGatewayResponse: vi.fn() }));
vi.mock("./backend-book-api", async (original) => ({
  ...(await original<typeof import("./backend-book-api")>()),
  backendBookRequest: runtime.request,
}));
vi.mock("./backend-scene-file", () => ({ saveBackendSceneFile: runtime.save }));
import { useNarraStore } from "@/stores/narra-store";
import { clearBackendSceneOperationsForTests } from "./backend-scene-operations";
import { generateBackendReaderScene, readSceneDataUri } from "./backend-scene-reader";
import { sceneInsertAnchors } from "./scene-inserts";
import type { NarraBookState } from "./types";

const ready = {
  status: "ready",
  scene_key: "text-interval-v1:6",
  slot_index: 6,
  anchor_text_offset: 39000,
  image_url: "https://storage.test/?secret=signed",
  mime_type: "image/png",
};
const input = () => ({
  bookId: "book",
  sourceKey: "page:anchor",
  anchor: "anchor",
  chapter: "Chapter",
  intent: { bookEditionId: "edition", markupIdentity: "v3", requestedProgress: 0.385 },
  display: vi.fn(),
  remove: vi.fn(),
});
const state = () => useNarraStore.getState().books.book;
const backendScene = () => Object.values(state().scenesByBackendId ?? {})[0];
beforeEach(() => {
  vi.useFakeTimers();
  useNarraStore.setState({ books: {} });
  runtime.request.mockReset().mockResolvedValue(ready);
  runtime.save.mockReset().mockResolvedValue("file:///documents/scene.png");
  runtime.read.mockReset().mockResolvedValue("aW1hZ2U=");
  runtime.diagnostic.mockClear();
  clearBackendSceneOperationsForTests();
});
afterEach(() => vi.useRealTimers());

describe("reader backend scene action and persistence", () => {
  it("publishes only a saved local image, then reads it and sends a data URI to WebView", async () => {
    const action = input();
    runtime.save.mockImplementation(async () => {
      expect(state().sceneRequests?.[action.sourceKey].requestedProgress).toBe(0.385);
      expect(state().scenesByBackendId).toBeUndefined();
      expect(action.display).not.toHaveBeenCalled();
      return "file:///documents/scene.png";
    });
    runtime.read.mockImplementation(async () => {
      expect(backendScene().imageUri).toBe("file:///documents/scene.png");
      return "aW1hZ2U=";
    });
    await generateBackendReaderScene(action, new AbortController().signal);
    expect(action.display).toHaveBeenCalledWith("anchor", "data:image/png;base64,aW1hZ2U=");
    expect(backendScene().backendScene?.sceneKey).toBe("text-interval-v1:6");
    expect(JSON.stringify(state())).not.toContain("signed");
    expect(JSON.stringify(runtime.diagnostic.mock.calls)).not.toContain("signed");
    const correlation = runtime.diagnostic.mock.calls.map((args) => args[1].requestId);
    expect(new Set(correlation).size).toBe(1);
  });
  it("failed job is terminal, leaves a retry intent, and never saves/displays another generated scene", async () => {
    runtime.request.mockResolvedValue({ status: "failed" });
    const action = input();
    await expect(generateBackendReaderScene(action, new AbortController().signal)).rejects.toThrow(
      "SCENE_FAILED",
    );
    expect(runtime.save).not.toHaveBeenCalled();
    expect(action.display).not.toHaveBeenCalled();
    expect(state().scenes).toEqual({});
    expect(sceneInsertAnchors(state().scenes, state().sceneRequests)).toEqual(["anchor"]);
    // Simulate persisted state and retry after the reader moved to a different page.
    useNarraStore.setState({ books: JSON.parse(JSON.stringify(useNarraStore.getState().books)) });
    runtime.request.mockResolvedValue(ready);
    await generateBackendReaderScene(
      { ...input(), intent: state().sceneRequests?.[action.sourceKey] ?? input().intent },
      new AbortController().signal,
    );
    expect(JSON.parse(runtime.request.mock.lastCall?.[1].body)).toEqual({
      progress_fraction: 0.385,
    });
  });
  it("an empty/failed download cannot enter the store; a fresh ready URL can recover it", async () => {
    const action = input();
    runtime.save.mockRejectedValueOnce(new Error("SCENE_EMPTY_DOWNLOAD"));
    const pending = generateBackendReaderScene(action, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(state().scenes).toEqual({});
    expect(action.display).not.toHaveBeenCalled();
    runtime.request.mockResolvedValue({ ...ready, image_url: "https://storage.test/fresh" });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(runtime.save.mock.lastCall?.[1].imageUrl).toBe("https://storage.test/fresh");
    expect(action.display).toHaveBeenCalledTimes(1);
  });
  it("restores an image after restart without network and remaps the old sandbox path", async () => {
    const action = input();
    await generateBackendReaderScene(action, new AbortController().signal);
    const stored = JSON.parse(JSON.stringify(state())) as NarraBookState;
    runtime.request.mockClear().mockRejectedValue(new Error("offline"));
    await expect(
      readSceneDataUri(
        Object.values(stored.scenesByBackendId ?? {})[0].imageUri.replace(
          "file:///documents/",
          "file:///old/",
        ),
      ),
    ).resolves.toBe("data:image/png;base64,aW1hZ2U=");
    expect(runtime.request).not.toHaveBeenCalled();
    expect(runtime.read).toHaveBeenLastCalledWith("file:///documents/scene.png", {
      encoding: "base64",
    });
    runtime.read.mockResolvedValue("");
    await expect(
      readSceneDataUri(Object.values(stored.scenesByBackendId ?? {})[0].imageUri),
    ).rejects.toThrow("SCENE_EMPTY_LOCAL_FILE");
  });
  it("cancellation during download cannot publish into a closed reader", async () => {
    const action = input();
    const controller = new AbortController();
    runtime.save.mockImplementation(async () => {
      controller.abort();
      return "file:///documents/scene.png";
    });
    await expect(generateBackendReaderScene(action, controller.signal)).rejects.toThrow(
      "SCENE_ABORTED",
    );
    expect(state().scenes).toEqual({});
    expect(action.display).not.toHaveBeenCalled();
  });
  it("keeps the tapped CFI bound and displays the image there when the same sceneKey already has a canonical anchor", async () => {
    const first = { ...input(), anchor: "cfi-a", sourceKey: "page:cfi-a" };
    await generateBackendReaderScene(first, new AbortController().signal);
    expect(first.display).toHaveBeenCalledWith("cfi-a", "data:image/png;base64,aW1hZ2U=");
    expect(first.remove).not.toHaveBeenCalled();

    const second = { ...input(), anchor: "cfi-b", sourceKey: "page:cfi-b" };
    await generateBackendReaderScene(second, new AbortController().signal);
    expect(second.remove).not.toHaveBeenCalled();
    expect(second.display).toHaveBeenCalledWith("cfi-b", "data:image/png;base64,aW1hZ2U=");
    expect(second.display).toHaveBeenCalledWith("cfi-a", "data:image/png;base64,aW1hZ2U=");
    const id = Object.keys(state().scenesByBackendId ?? {})[0];
    expect(state().sceneAnchorBindings).toEqual({ "cfi-a": id, "cfi-b": id });
    expect(sceneInsertAnchors(state().scenes, state().sceneRequests, state().sceneAnchorBindings)).toEqual(
      ["cfi-a", "cfi-b"],
    );
  });
  it("after persist/reload the tapped non-canonical CFI still restores instead of staying on Рисуем", async () => {
    await generateBackendReaderScene(
      { ...input(), anchor: "cfi-a", sourceKey: "page:cfi-a" },
      new AbortController().signal,
    );
    await generateBackendReaderScene(
      { ...input(), anchor: "cfi-b", sourceKey: "page:cfi-b" },
      new AbortController().signal,
    );
    useNarraStore.setState({ books: JSON.parse(JSON.stringify(useNarraStore.getState().books)) });
    const book = state();
    expect(book.sceneAnchorBindings?.["cfi-b"]).toBe(book.sceneAnchorBindings?.["cfi-a"]);
    expect(
      sceneInsertAnchors(book.scenes, book.sceneRequests, book.sceneAnchorBindings, book.scenesByBackendId),
    ).toEqual(["cfi-a", "cfi-b"]);
  });
  it("keeps references for a no-op intent update and strips extra response fields", () => {
    const action = input();
    const request = { ...action.intent, imageUrl: ready.image_url };
    useNarraStore.getState().setSceneRequest(action.bookId, action.sourceKey, request);
    const first = state();
    useNarraStore.getState().setSceneRequest(action.bookId, action.sourceKey, request);
    expect(state()).toBe(first);
    expect(JSON.stringify(first)).not.toContain("signed");
    expect(runtime.request).not.toHaveBeenCalled();
  });
});
