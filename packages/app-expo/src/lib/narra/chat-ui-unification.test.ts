import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatScreen = readFileSync(new URL("../../screens/ChatScreen.tsx", import.meta.url), "utf8");
const sharedChat = readFileSync(
  new URL("../../components/chat/NarraChat.tsx", import.meta.url),
  "utf8",
);

describe("Narra and character chat UI contract", () => {
  it("sends Loop 6 book chat through gateway complete, not local RAG", () => {
    expect(chatScreen).not.toContain("useStreamingChat");
    expect(chatScreen).not.toContain("resolveActiveAIConfig");
    expect(chatScreen).toContain("completeNarraChat");
    expect(chatScreen).toContain("bookEditionId");
    expect(chatScreen).toContain("SEARCH_NOT_READY");
  });

  it("uses the standard top toast for Narra response failures", () => {
    expect(chatScreen).toContain("toast.error(");
    expect(chatScreen).toContain('t("chat.responseFailed"');
    expect(chatScreen).toContain('label: t("common.retry", "Повторить")');
    expect(chatScreen).not.toContain("errorMessage={");
  });

  it("does not keep a custom inline error inside the shared chat", () => {
    expect(sharedChat).not.toContain("errorState");
    expect(sharedChat).not.toContain("retryLabel");
    expect(sharedChat).not.toContain("errorMessage");
  });

  it("uses the same transcript modes as character dialogs", () => {
    expect(chatScreen).toContain("showScrollToBottomButton={false}");
    expect(chatScreen).toContain("showTypingIndicator={false}");
    expect(chatScreen).toContain("showModeControls={false}");
  });
});
