import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const moves: Array<{ from: string; to: string }> = [];

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: vi.fn(async () => ({ exists: true })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error("ENOENT");
    return text;
  }),
  writeAsStringAsync: vi.fn(async (path: string, text: string) => {
    files.set(path, text);
  }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    moves.push({ from, to });
    files.delete(from);
  }),
}));
vi.mock("expo-secure-store", () => ({}));

import { create } from "zustand";
import { flushAllWrites, withPersist } from "./persist";

interface CounterState {
  count: number;
  books: Array<{ id: string; characters?: string[] }>;
  _hasHydrated: boolean;
  increment: () => void;
}

const STORE_PATH = "file:///docs/readany-store/counter.json";

function waitForHydration(store: { getState: () => CounterState }): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (store.getState()._hasHydrated) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

describe("withPersist hydration recovery", () => {
  beforeEach(() => {
    files.clear();
    moves.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("hydrates from a valid snapshot", async () => {
    files.set(STORE_PATH, JSON.stringify({ count: 7, books: [] }));
    const store = create<CounterState>(
      withPersist("counter", (set) => ({
        count: 0,
        books: [],
        _hasHydrated: false,
        increment: () => set((state) => ({ count: state.count + 1 })),
      })),
    );
    await waitForHydration(store);
    expect(store.getState().count).toBe(7);
  });

  it("quarantines a corrupt snapshot and still finishes hydration", async () => {
    files.set(STORE_PATH, "{not json");
    const store = create<CounterState>(
      withPersist("counter", (set) => ({
        count: 0,
        books: [],
        _hasHydrated: false,
        increment: () => set((state) => ({ count: state.count + 1 })),
      })),
    );
    await waitForHydration(store);
    expect(store.getState().count).toBe(0);
    expect(moves[0]?.from).toBe(STORE_PATH);
    expect(moves[0]?.to).toMatch(/counter\.json\.corrupt-\d+$/);
  });

  it("survives a migration that throws on an old snapshot", async () => {
    files.set(STORE_PATH, JSON.stringify({ count: 3, books: [{ id: "b1" }] }));
    const store = create<CounterState>(
      withPersist(
        "counter",
        (set) => ({
          count: 0,
          books: [],
          _hasHydrated: false,
          increment: () => set((state) => ({ count: state.count + 1 })),
        }),
        undefined,
        (persisted) => ({
          ...persisted,
          // Старые снимки без characters ломали такую миграцию в narra-store.
          books: persisted.books.map((book) => ({
            ...book,
            characters: (book.characters as string[]).map((item) => item),
          })),
        }),
      ),
    );
    await waitForHydration(store);
    expect(store.getState()._hasHydrated).toBe(true);
    expect(store.getState().count).toBe(0);
    expect(moves).toHaveLength(1);
  });

  it("flushes pending debounced writes on demand", async () => {
    const store = create<CounterState>(
      withPersist("counter", (set) => ({
        count: 0,
        books: [],
        _hasHydrated: false,
        increment: () => set((state) => ({ count: state.count + 1 })),
      })),
    );
    await waitForHydration(store);
    store.getState().increment();
    expect(files.has(STORE_PATH)).toBe(false);
    await flushAllWrites();
    expect(JSON.parse(files.get(STORE_PATH) ?? "{}").count).toBe(1);
  });
});
