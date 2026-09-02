import { describe, expect, it } from "vitest";
import type { BackendBookManifest } from "./backend-book-contract";
import { emptyNarraBookState } from "./domain";
import { readerCastForBook, readerCastForCharacters } from "./reader-cast";
import type { NarraBookState, NarraCharacter } from "./types";

function character(overrides: Partial<NarraCharacter> & { id: string }): NarraCharacter {
  return {
    name: overrides.id,
    fullName: overrides.id,
    role: "Персонаж",
    gender: "male",
    voice: "Ast",
    traits: [],
    speechStyle: "",
    speechExamples: [],
    appearancePrompt: "",
    unlockProgress: 0,
    ...overrides,
  };
}

function manifest(
  characters: Array<{
    key: string;
    provisional?: boolean;
    state?: "ready" | "preparing" | "unknown";
  }>,
  availability: BackendBookManifest["availability"] = "ready",
): BackendBookManifest {
  return {
    availability,
    characters: characters.map((item) => ({
      key: item.key,
      name: item.key,
      fullName: "",
      provisional: item.provisional ?? false,
      state: item.state ?? "ready",
      profile: {},
      assets: [],
    })),
  };
}

const LOCAL = [character({ id: "pechorin", name: "Печорин" })];
const BACKEND = [character({ id: "character:abc", name: "Печорин", backendManaged: true })];

describe("readerCastForCharacters", () => {
  it("returns client-analysed / bundled characters when there is no backend manifest", () => {
    expect(readerCastForCharacters(LOCAL, undefined)).toEqual(LOCAL);
  });

  it("prefers backend characters when the manifest is ready and non-provisional", () => {
    const cast = readerCastForCharacters(
      [...LOCAL, ...BACKEND],
      manifest([{ key: "character:abc" }]),
    );
    expect(cast).toEqual(BACKEND);
  });

  it("falls back to client characters while the manifest is only provisional", () => {
    const cast = readerCastForCharacters(
      [...LOCAL, ...BACKEND],
      manifest([{ key: "character:abc", provisional: true }]),
    );
    expect(cast).toEqual(LOCAL);
  });

  it("falls back to client characters while the manifest is still processing", () => {
    const cast = readerCastForCharacters(
      [...LOCAL, ...BACKEND],
      manifest([{ key: "character:abc" }], "processing"),
    );
    expect(cast).toEqual(LOCAL);
  });

  it("returns an empty cast for a book without characters", () => {
    expect(readerCastForCharacters(undefined, undefined)).toEqual([]);
    expect(readerCastForCharacters([], manifest([{ key: "character:abc" }]))).toEqual([]);
  });
});

describe("readerCastForBook", () => {
  it("reads the cast from the narra store state", () => {
    const state: { books: Record<string, NarraBookState | undefined> } = {
      books: {
        local: { ...emptyNarraBookState("local"), characters: LOCAL },
        backend: {
          ...emptyNarraBookState("backend"),
          characters: BACKEND,
          backendManifest: manifest([{ key: "character:abc" }]),
        },
      },
    };
    expect(readerCastForBook(state, "local")).toEqual(LOCAL);
    expect(readerCastForBook(state, "backend")).toEqual(BACKEND);
    expect(readerCastForBook(state, "missing")).toEqual([]);
  });
});
