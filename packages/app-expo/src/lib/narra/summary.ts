import { narraGatewayRequest } from "@/lib/ai/narra-gateway-fetch";
import { NarraServiceError } from "./errors";

const MAX_SUMMARY_SOURCE_CHARS = 30_000;
type SummaryResponse = { text?: string; content?: string; error?: string };

export async function generateNarraSummary(
  chapter: string,
  excerpt: string,
  language: "ru" | "en" = "ru",
  bookEditionId?: string,
): Promise<string> {
  const edition = typeof bookEditionId === "string" ? bookEditionId.trim() : "";
  if (!edition) {
    throw new NarraServiceError(
      "SERVICE",
      "Поиск по книге ещё не готов (SEARCH_NOT_READY). Ответ без книги недоступен.",
      undefined,
      undefined,
      "SEARCH_NOT_READY",
    );
  }
  const response = await narraGatewayRequest("/v2/ai/chat/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      book_edition_id: edition,
      messages: [
        {
          role: "system",
          content:
            language === "en"
              ? "Summarize the book excerpt in 3–5 sentences in English. Preserve important events, details, and emotional meaning. Do not add information that is not in the excerpt. Return only the summary."
              : "Кратко перескажи фрагмент книги в 3–5 предложениях. Сохрани важные события, детали и эмоциональный смысл. Не добавляй сведений, которых нет во фрагменте. Ответь только пересказом на русском языке.",
        },
        {
          role: "user",
          content:
            language === "en"
              ? `Chapter “${chapter}”:\n${excerpt.slice(0, MAX_SUMMARY_SOURCE_CHARS)}`
              : `Глава «${chapter}»:\n${excerpt.slice(0, MAX_SUMMARY_SOURCE_CHARS)}`,
        },
      ],
      temperature: 0.35,
      purpose: "summary",
      origin: "user",
      analytics_tier: "essential",
    }),
  });

  const body = await response.text();
  let payload: SummaryResponse | null = null;
  try {
    payload = JSON.parse(body) as SummaryResponse;
  } catch {
    // Some gateway adapters return plain text for chat completions.
  }

  if (!response.ok) {
    throw new Error(payload?.error || body || `AI request failed (${response.status})`);
  }

  const summary = (payload ? payload.text || payload.content || "" : body).trim();
  if (!summary) throw new Error("Gateway returned an empty summary");
  return summary;
}
