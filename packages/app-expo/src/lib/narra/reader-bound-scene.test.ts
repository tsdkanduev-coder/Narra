import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readerScreen = readFileSync(
  new URL("../../screens/ReaderScreen.tsx", import.meta.url),
  "utf8",
);

describe("reader bound scene generation", () => {
  it("does not draw a scene off-book through OpenRouter when edition is missing", () => {
    expect(readerScreen).not.toContain("generateNarraSceneImage");
    expect(readerScreen).not.toContain("scene-image-openrouter");
    expect(readerScreen).toContain("generateBackendReaderScene");
    expect(readerScreen).toContain("if (!edition)");
    expect(readerScreen).toContain("Сцена рисуется только для книги с изданием в Narra");
  });
});
