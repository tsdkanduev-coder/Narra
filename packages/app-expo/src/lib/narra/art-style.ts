/**
 * Единый fanart-стиль генераций изображений (канон из work order narra-core-loop).
 * Добавляется в конец каждого промпта и НИКОГДА не сокращается.
 */
/** Канон work order narra-core-loop. НИКОГДА не сокращается и не перефразируется. */
export const ART_STYLE =
  "фанарт, стилизованная современная книжная иллюстрация, цифровая живопись с выразительными " +
  "мазками, НЕ фотореализм, чистые уверенные формы, мягкий рассеянный свет, сдержанная " +
  "благородная палитра, лёгкая текстура бумаги, единая серия работ одного художника, " +
  "без текста и надписей";

/** Лимит промпта Kandinsky в символах. */
export const PROMPT_CHAR_LIMIT = 950;

function shrinkPart(part: string, maxLength: number): string {
  if (part.length <= maxLength) return part;
  if (maxLength < 2) return "";
  const slice = part.slice(0, maxLength - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= maxLength * 0.6 ? slice.slice(0, lastSpace) : slice;
  const trimmed = cut.replace(/[\s,.;:!?…—-]+$/u, "");
  return trimmed ? `${trimmed}…` : "";
}

/**
 * Собирает промпт из частей и завершает его ART_STYLE.
 * При переполнении лимита сокращаются части (сначала самые длинные — паспорта
 * и отрывок сцены); стиль всегда остаётся в конце целиком.
 */
export function budgetPrompt(
  parts: string[],
  limit = PROMPT_CHAR_LIMIT,
  artStyle = ART_STYLE,
): string {
  const styleTail = `Стиль: ${artStyle}.`;
  const body = parts.map((part) => part.replace(/\s+/gu, " ").trim()).filter(Boolean);
  const assemble = () => [...body.filter(Boolean), styleTail].join(" ");
  let prompt = assemble();
  while (prompt.length > limit && body.some(Boolean)) {
    const overflow = prompt.length - limit;
    let longest = 0;
    for (let index = 1; index < body.length; index++) {
      if (body[index].length > body[longest].length) longest = index;
    }
    body[longest] = shrinkPart(body[longest], body[longest].length - overflow);
    prompt = assemble();
  }
  return prompt;
}
