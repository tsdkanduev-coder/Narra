import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendBookBinding, BackendBookManifest } from "./backend-book-contract";
import { BackendBookSession, type BackendBookSessionDependencies } from "./backend-book-session";

const binding: BackendBookBinding = {
  bookEditionId: "id",
  resolution: "private",
  contentSha256: "hash",
  sourceUploaded: true,
};
const ready: BackendBookManifest = { availability: "ready", textLength: 1000, characters: [] };
function setup(progress = 0.2) {
  const deps: BackendBookSessionDependencies = {
    bind: vi.fn(async () => binding),
    progress: vi.fn(async () => ({})),
    manifest: vi.fn(async () => ready),
    identity: vi.fn(async () => ({ pending: false, delay: 5000 })),
    publish: vi.fn(),
    media: vi.fn(async () => {}),
    error: vi.fn(),
    expired: vi.fn(),
    isNotFound: (error) => error === "404",
  };
  const session = new BackendBookSession(deps, progress);
  return { session, deps };
}
describe("backend book synchronization lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("publishes profiles before media and starts identity independently", async () => {
    const { session, deps } = setup();
    vi.mocked(deps.identity).mockImplementation(() => new Promise(() => {}));
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.publish).toHaveBeenCalledWith(ready, 0.2);
    expect(vi.mocked(deps.publish).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.media).mock.invocationCallOrder[0],
    );
    session.stop();
  });
  it("sends maximum progress once per batch and never decreases it", async () => {
    const { session, deps } = setup();
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    session.update(0.3);
    session.update(0.7);
    session.update(0.4);
    await vi.advanceTimersByTimeAsync(1499);
    expect(deps.progress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(deps.progress).mock.calls.map((call) => call[1])).toEqual([0.2, 0.7]);
    session.update(0.1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.progress).toHaveBeenCalledTimes(2);
    session.stop();
  });
  it("polls manifest without rebinding/uploading or reposting unchanged progress", async () => {
    const { session, deps } = setup();
    vi.mocked(deps.manifest).mockResolvedValue({ ...ready, availability: "processing" });
    session.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deps.bind).toHaveBeenCalledTimes(1);
    expect(deps.progress).toHaveBeenCalledTimes(1);
    expect(deps.manifest).toHaveBeenCalledTimes(4);
    session.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.manifest).toHaveBeenCalledTimes(4);
  });
  it.each(["failed", "cancelled", "unavailable"] as const)(
    "publishes %s once and does not leave an infinite manifest poll",
    async (availability) => {
      const { session, deps } = setup();
      vi.mocked(deps.manifest).mockResolvedValue({ ...ready, availability });
      session.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.publish).toHaveBeenCalledTimes(1);
      expect(deps.manifest).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      session.stop();
    },
  );
  it("honors identity poll_after_ms without delaying manifest", async () => {
    const { session, deps } = setup();
    vi.mocked(deps.identity).mockResolvedValue({ pending: true, delay: 12_000 });
    session.start();
    await vi.advanceTimersByTimeAsync(11999);
    expect(deps.identity).toHaveBeenCalledTimes(1);
    expect(deps.publish).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.identity).toHaveBeenCalledTimes(2);
    session.stop();
  });
  it("ignores late responses after cancellation", async () => {
    const { session, deps } = setup();
    let resolve!: (value: BackendBookManifest) => void;
    vi.mocked(deps.manifest).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    session.stop();
    resolve(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.media).not.toHaveBeenCalled();
  });
  it("re-resolves a missing private edition and backs off network errors", async () => {
    const { session, deps } = setup();
    vi.mocked(deps.manifest).mockRejectedValueOnce("404");
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.expired).toHaveBeenCalledWith(binding);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.bind).toHaveBeenCalledTimes(2);
    expect(deps.publish).toHaveBeenCalled();
    session.stop();
  });
  it("still fetches the manifest when progress posting fails", async () => {
    const { session, deps } = setup();
    vi.mocked(deps.progress).mockRejectedValue(new Error("offline"));
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.publish).toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalled();
    session.stop();
  });
});

describe("terminal backend errors", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("stops retrying after a terminal bind error until an explicit retry", async () => {
    const { session, deps } = setup();
    deps.isTerminal = (error) => error === "FORMAT_UNSUPPORTED";
    vi.mocked(deps.bind).mockRejectedValue("FORMAT_UNSUPPORTED");
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bind).toHaveBeenCalledTimes(1);
    expect(deps.error).toHaveBeenCalledWith("FORMAT_UNSUPPORTED");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.bind).toHaveBeenCalledTimes(1);
    session.update(0.5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.bind).toHaveBeenCalledTimes(1);
    vi.mocked(deps.bind).mockResolvedValue(binding);
    session.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.bind).toHaveBeenCalledTimes(2);
  });
});
