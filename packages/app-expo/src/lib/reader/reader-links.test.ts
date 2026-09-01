import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { externalLinkHost, isReaderHostedUrl } from "./reader-links";

describe("reader link safety net", () => {
  it("keeps local reader and section documents, blocks external http(s)", () => {
    expect(isReaderHostedUrl("file:///var/app/reader.html")).toBe(true);
    expect(isReaderHostedUrl("http://127.0.0.1:54936/books/a.epub")).toBe(true);
    expect(isReaderHostedUrl("http://localhost:8081/section.xhtml")).toBe(true);
    expect(isReaderHostedUrl("blob:http://127.0.0.1/uuid")).toBe(true);
    expect(isReaderHostedUrl("about:blank")).toBe(true);
    expect(isReaderHostedUrl("chapter2.xhtml#note1")).toBe(true);
    expect(isReaderHostedUrl("https://www.litres.ru/book/123")).toBe(false);
    expect(isReaderHostedUrl("http://royallib.com/")).toBe(false);
    expect(isReaderHostedUrl("mailto:someone@example.com")).toBe(false);
  });

  it("describes the external host for the notice", () => {
    expect(externalLinkHost("https://www.litres.ru/book/123")).toBe("litres.ru");
    expect(externalLinkHost("not a url")).toBe("");
    expect(externalLinkHost("")).toBe("");
  });

  it("wires the WebView guard and the foliate external-link event", () => {
    const template = readFileSync(
      fileURLToPath(new URL("../../../assets/reader/reader.template.html", import.meta.url)),
      "utf8",
    );
    expect(template).toContain("el.addEventListener('external-link'");
    expect(template).toContain("postToRN('externalLink'");
    const screen = readFileSync(
      fileURLToPath(new URL("../../screens/ReaderScreen.tsx", import.meta.url)),
      "utf8",
    );
    expect(screen).toContain("onShouldStartLoadWithRequest={(request) => {");
    expect(screen).toContain("isReaderHostedUrl(request.url)");
    expect(screen).toContain("onExternalLink: (href) => {");
    const bridge = readFileSync(
      fileURLToPath(new URL("../../hooks/use-reader-bridge.ts", import.meta.url)),
      "utf8",
    );
    expect(bridge).toContain('case "externalLink":');
  });
});
