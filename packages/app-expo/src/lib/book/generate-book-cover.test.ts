import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalCoverJob } from "./cover-job-repository";

const jobs = vi.hoisted(() => new Map<string, LocalCoverJob>());
vi.mock("@/lib/ai/narra-gateway-fetch", () => ({ narraGatewayRequest: vi.fn() }));
vi.mock("./cover-job-session", () => ({
  inCoverForeground: (operation: (signal: AbortSignal) => Promise<unknown>) =>
    operation(new AbortController().signal),
}));

vi.mock("@/lib/narra/media", () => ({
  generateBookCoverImage: vi.fn(),
}));
vi.mock("@readany/core/utils", () => ({ generateId: () => "request-1" }));
vi.mock("./cover-job-repository", () => ({
  deleteLocalCoverJob: vi.fn(async (bookId) => {
    jobs.delete(bookId);
  }),
  getLocalCoverJob: vi.fn(async (bookId) => jobs.get(bookId) ?? null),
  getOrCreateLocalCoverJob: vi.fn(async ({ bookId, requestId, prompt, request }) => {
    const job = jobs.get(bookId) ?? {
      bookId,
      requestId,
      prompt: prompt ?? "",
      request,
      status: "submitting",
      nextPollAt: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    jobs.set(bookId, job);
    return job;
  }),
  updateLocalCoverJob: vi.fn(async (bookId, update) => {
    const job = jobs.get(bookId);
    if (!job) return null;
    Object.assign(job, update, {
      lastErrorCode: update.errorCode,
      lastErrorMessage: update.errorMessage,
    });
    return job;
  }),
}));

import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { generateBookCoverImage } from "@/lib/narra/media";
import { CoverJobError } from "../narra/cover-jobs";
import coverGenerationConfig from "./cover-generation-config.json";
import { deleteLocalCoverJob } from "./cover-job-repository";
import { ART_STYLE, PROMPT_CHAR_LIMIT } from "../narra/art-style";
import {
  acknowledgeGeneratedBookCover,
  buildFanartCoverPrompt,
  coverPrompt,
  generateBookCover,
} from "./generate-book-cover";

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
});
afterEach(() => vi.useRealTimers());

describe("buildFanartCoverPrompt", () => {
  it("fits the 950-char budget and keeps the full work-order style", () => {
    const prompt = buildFanartCoverPrompt({
      title: "Анна Каренина",
      author: "Лев Толстой",
      description: `${"Роман о семье, любви и давлении общества. ".repeat(40)}`,
    });

    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_LIMIT);
    expect(prompt).toContain(ART_STYLE);
    expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
    expect(prompt).toContain("Анна Каренина");
  });
});

describe("coverPrompt", () => {
  it("builds the approved GPT Image 2 cover prompt with book context", () => {
    const prompt = coverPrompt({
      title: "Анна Каренина",
      author: "Лев Толстой",
      description: "Роман о семье, любви и давлении общества.",
      subjects: ["literary fiction"],
      accentColor1: "deep crimson red",
    });

    expect(prompt).toContain("Create the complete front-cover artwork");
    expect(prompt).toContain("late modernist editorial design");
    expect(prompt).toContain("two-fifths of the total canvas height");
    expect(prompt).toContain("38–42%");
    expect(prompt).toContain("must never exceed about 45%");
    expect(prompt).toContain("ABSOLUTELY NO TEXT");
    expect(prompt).toContain("“Анна Каренина”");
    expect(prompt).toContain("Лев Толстой");
    expect(prompt).toContain("Роман о семье, любви и давлении общества.");
    expect(prompt).toContain("BOOK GENRE:\nliterary fiction");
    expect(prompt).toContain("psychological and social tension");
    expect(prompt).toContain("SHARED BACKGROUND SYSTEM — IDENTICAL ACROSS ALL GENRES");
    expect(prompt).toContain("deep crimson red");
    expect(prompt).not.toContain("{{BOOK_TITLE}}");
    expect(prompt).not.toContain("{{BACKGROUND_COLOR}}");
    expect(prompt).not.toContain("{{BOOK_GENRE}}");
    expect(prompt).not.toContain("{{GENRE_ART_DIRECTION}}");
  });

  it("keeps the catalog-scripts model config aligned with the gateway default", () => {
    expect(coverGenerationConfig.openRouterModel).toBe("openai/gpt-image-2");
  });

  it("fills missing metadata and selects a stable dominant background color", () => {
    const first = coverPrompt({ title: "Неизвестная книга" });
    const second = coverPrompt({ title: "Неизвестная книга" });

    expect(first).toBe(second);
    expect(first).toContain("Unknown author");
    expect(first).toContain("Infer the central idea, mood, symbols and historical context");
    expect(first).toContain("BOOK GENRE:\nclassics / general literature");
    expect(first).toContain("late-modernist paper collage");
    expect(first).not.toMatch(/\{\{[A-Z_]+\}\}/u);
    expect(coverGenerationConfig.backgroundColors.some((color) => first.includes(color))).toBe(
      true,
    );
  });

  it("caps long book descriptions while preserving the complete art direction", () => {
    const prompt = coverPrompt({
      description: "Очень длинное описание содержания книги. ".repeat(30),
      title: "Книга",
    });

    expect(prompt).toContain("CRITICAL OUTPUT RULE");
    expect(prompt.length).toBeLessThan(8_000);
  });

  it("adds a genre-specific direction inferred from content when metadata is absent", () => {
    const prompt = coverPrompt({
      title: "Книга",
      description: "Исторический роман о семье на фоне революции.",
    });

    expect(prompt).toContain("BOOK GENRE:\nhistorical fiction");
    expect(prompt).toContain("era-specific engraved figure");
  });

  it("keeps the background system fixed while allowing a 1990s anime manga illustration", () => {
    const prompt = coverPrompt({ title: "Книга", subjects: ["manga"] });

    expect(prompt).toContain("BOOK GENRE:\nmanga or anime graphic fiction");
    expect(prompt).toContain("1990s cel anime");
    expect(prompt).toContain("Genre variation belongs only inside the compact focal illustration");
  });
});

describe("generateBookCover", () => {
  it.each([new TypeError("failed to fetch"), new Error("Network request failed")])(
    "retries a lost submit response with the same persisted body and request ID: %s",
    async (error) => {
      vi.useFakeTimers();
      vi.mocked(generateBookCoverImage)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({
          base64: btoa("\xff\xd8\xffjpeg-bytes"),
          mimeType: "image/jpeg",
          jobId: "job-1",
        });
      const pending = generateBookCover({ bookId: "book-1", title: "Original" });
      await vi.advanceTimersByTimeAsync(3100);
      await pending;
      expect(generateBookCoverImage).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(generateBookCoverImage).mock.calls;
      expect(calls[0][0]).toEqual(calls[1][0]);
      expect(calls[0][1].requestId).toBe(calls[1][1].requestId);
      expect(deleteLocalCoverJob).not.toHaveBeenCalled();
    },
  );

  it("resumes GET after losing connectivity during polling", async () => {
    vi.useFakeTimers();
    vi.mocked(generateBookCoverImage)
      .mockImplementationOnce(async (_request, options) => {
        await options.onJob({ jobId: "server-job", status: "running", nextPollAt: 0 });
        throw new TypeError("failed to fetch");
      })
      .mockResolvedValueOnce({
        base64: btoa("\xff\xd8\xffjpeg-bytes"),
        mimeType: "image/jpeg",
        jobId: "server-job",
      });
    const pending = generateBookCover({ bookId: "book-1", title: "Book" });
    await vi.advanceTimersByTimeAsync(3100);
    await pending;
    expect(vi.mocked(generateBookCoverImage).mock.calls[1][1].jobId).toBe("server-job");
  });

  it("does not automatically retry a 429 or create a second job after reload", async () => {
    vi.mocked(generateBookCoverImage).mockRejectedValueOnce(
      new CoverJobError("limit", "RATE", 429),
    );
    await expect(generateBookCover({ bookId: "book-1", title: "Book" })).rejects.toThrow("limit");
    await expect(generateBookCover({ bookId: "book-1", title: "Book" })).rejects.toThrow("limit");
    expect(generateBookCoverImage).toHaveBeenCalledOnce();
    expect(jobs.get("book-1")?.status).toBe("failed");
  });

  it("finishes deleting the local intent after a crash after server ACK", async () => {
    jobs.set("book-1", {
      bookId: "book-1",
      requestId: "request-1",
      prompt: "",
      jobId: "job-1",
      status: "completed",
      nextPollAt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(new Response("{}", { status: 404 }));
    const verify = vi.fn(async () => {});
    await acknowledgeGeneratedBookCover("book-1", verify);
    expect(verify).toHaveBeenCalledOnce();
    expect(jobs.size).toBe(0);
    expect(generateBookCoverImage).not.toHaveBeenCalled();
  });
  it("persists structured facts before submission and decodes the returned image", async () => {
    vi.mocked(generateBookCoverImage).mockResolvedValueOnce({
      base64: btoa("\xff\xd8\xffjpeg-bytes"),
      mimeType: "image/jpeg",
      jobId: "job-1",
    });

    const generated = await generateBookCover({
      bookId: "book-1",
      title: "Анна Каренина",
      author: "Лев Толстой",
      description: "Роман о семье, любви и давлении общества.",
    });

    expect(generateBookCoverImage).toHaveBeenCalledTimes(1);
    const [request, options] = vi.mocked(generateBookCoverImage).mock.calls[0] ?? [];
    expect(request).toMatchObject({ book: { title: "Анна Каренина" } });
    expect(jobs.get("book-1")?.request).toEqual(request);
    expect(options).toMatchObject({ requestId: "request-1" });
    expect(generated.mimeType).toBe("image/jpeg");
    expect(generated.jobId).toBe("job-1");
    expect(generated.bytes.slice(0, 3)).toEqual(new Uint8Array([255, 216, 255]));
    expect(deleteLocalCoverJob).not.toHaveBeenCalled();
  });

  it("propagates gateway failures to the caller for retry bookkeeping", async () => {
    vi.mocked(generateBookCoverImage).mockRejectedValueOnce(
      new Error("Cover generation failed (429)"),
    );

    await expect(generateBookCover({ bookId: "book-1", title: "Книга" })).rejects.toThrow(
      "Cover generation failed (429)",
    );
  });

  it("reuses the persisted local prompt after a JS reload", async () => {
    jobs.set("book-1", {
      bookId: "book-1",
      requestId: "request-1",
      jobId: "job-existing",
      prompt: "persisted prompt",
      status: "running",
      nextPollAt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(generateBookCoverImage).mockResolvedValueOnce({
      base64: btoa("\xff\xd8\xffjpeg-bytes"),
      mimeType: "image/jpeg",
      jobId: "job-existing",
    });

    await generateBookCover({ bookId: "book-1", title: "Changed title" });

    expect(generateBookCoverImage).toHaveBeenCalledWith(
      { prompt: "persisted prompt" },
      expect.objectContaining({
        requestId: "request-1",
        jobId: "job-existing",
      }),
    );
  });

  it("verifies persistence before real ACK, and keeps the intent if ACK fails", async () => {
    jobs.set("book-1", {
      bookId: "book-1",
      requestId: "request-1",
      prompt: "",
      jobId: "job-1",
      status: "completed",
      nextPollAt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const verify = vi.fn(async () => {
      expect(narraGatewayRequest).not.toHaveBeenCalled();
    });
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(acknowledgeGeneratedBookCover("book-1", verify)).rejects.toThrow();
    expect(verify).toHaveBeenCalledOnce();
    expect(deleteLocalCoverJob).not.toHaveBeenCalled();
    vi.mocked(narraGatewayRequest).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await acknowledgeGeneratedBookCover("book-1", async () => {});
    expect(deleteLocalCoverJob).toHaveBeenCalledWith("book-1");
    expect(generateBookCoverImage).not.toHaveBeenCalled();
  });

  it.each(["file missing", "DB write lost"])(
    "never ACKs when verification fails: %s",
    async (reason) => {
      jobs.set("book-1", {
        bookId: "book-1",
        requestId: "request-1",
        prompt: "",
        jobId: "job-1",
        status: "completed",
        nextPollAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await expect(
        acknowledgeGeneratedBookCover("book-1", async () => {
          throw new Error(reason);
        }),
      ).rejects.toThrow(reason);
      expect(narraGatewayRequest).not.toHaveBeenCalled();
      expect(jobs.has("book-1")).toBe(true);
    },
  );

  it("does not resubmit terminal failures on reload", async () => {
    jobs.set("book-1", {
      bookId: "book-1",
      requestId: "request-1",
      prompt: "",
      status: "failed",
      nextPollAt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(generateBookCover({ bookId: "book-1", title: "Book" })).rejects.toThrow();
    expect(generateBookCoverImage).not.toHaveBeenCalled();
  });

  it("coalesces parallel requests for one book", async () => {
    vi.mocked(generateBookCoverImage).mockResolvedValueOnce({
      base64: btoa("\xff\xd8\xffjpeg-bytes"),
      mimeType: "image/jpeg",
      jobId: "job-1",
    });
    const first = generateBookCover({ bookId: "book-1", title: "Book" });
    const second = generateBookCover({ bookId: "book-1", title: "Changed" });
    expect(first).toBe(second);
    await first;
    expect(generateBookCoverImage).toHaveBeenCalledOnce();
  });

  it("removes an expired pointer, but does not immediately start another generation", async () => {
    vi.mocked(generateBookCoverImage).mockRejectedValueOnce(
      new CoverJobError("expired", "NOT_FOUND", 404),
    );
    await expect(generateBookCover({ bookId: "book-1", title: "Book" })).rejects.toThrow("expired");
    expect(jobs.size).toBe(0);
    expect(generateBookCoverImage).toHaveBeenCalledOnce();
  });
});
