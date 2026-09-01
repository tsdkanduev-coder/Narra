import { describe, expect, it } from "vitest";
import { ART_STYLE, PROMPT_CHAR_LIMIT, budgetPrompt } from "./art-style";

const CANON_ART_STYLE =
  "фанарт, стилизованная современная книжная иллюстрация, цифровая живопись с выразительными " +
  "мазками, НЕ фотореализм, чистые уверенные формы, мягкий рассеянный свет, сдержанная " +
  "благородная палитра, лёгкая текстура бумаги, единая серия работ одного художника, " +
  "без текста и надписей";

describe("ART_STYLE canon", () => {
  it("matches the locked work-order style clause verbatim", () => {
    expect(ART_STYLE).toBe(CANON_ART_STYLE);
    expect(ART_STYLE).not.toMatch(/semi-realistic anime/i);
    expect(ART_STYLE.includes("без текста и надписей")).toBe(true);
  });
});

describe("budgetPrompt", () => {
  it("keeps short parts verbatim and ends with the full art style", () => {
    const prompt = budgetPrompt(["Погрудный портрет.", "Выражение лица: спокойное."]);

    expect(prompt).toContain("Погрудный портрет.");
    expect(prompt).toContain("Выражение лица: спокойное.");
    expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_LIMIT);
  });

  it("keeps the style intact and fits the default limit on a huge excerpt", () => {
    const excerpt = `Сцена: ${"Анна вошла в зал и остановилась у двери. ".repeat(400)}`;
    const prompt = budgetPrompt(["Иллюстрация сцены.", excerpt]);

    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_LIMIT);
    expect(prompt).toContain(ART_STYLE);
    expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
    expect(prompt).toContain("Иллюстрация сцены.");
    expect(prompt).toContain("Анна вошла в зал");
  });

  it("trims the longest parts (passports) first, not the instructions", () => {
    const instruction = "В кадре только эти герои, НЕ коллаж.";
    const passports = `Герои: ${"высокий, статный, тёмные волосы, серые глаза; ".repeat(120)}`;
    const prompt = budgetPrompt([instruction, passports]);

    expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_LIMIT);
    expect(prompt).toContain(instruction);
    expect(prompt).toContain(ART_STYLE);
  });

  it("keeps the full style even when every part overflows a tight limit", () => {
    const limit = `Стиль: ${ART_STYLE}.`.length + 40;
    const prompt = budgetPrompt(["а".repeat(500), "б".repeat(500), "в".repeat(500)], limit);

    expect(prompt.length).toBeLessThanOrEqual(limit);
    expect(prompt).toContain(ART_STYLE);
    expect(prompt.endsWith(`Стиль: ${ART_STYLE}.`)).toBe(true);
  });

  it("collapses whitespace and drops empty parts", () => {
    const prompt = budgetPrompt(["", "  Сцена:   бал  \n у  двери ", "   "]);

    expect(prompt).toContain("Сцена: бал у двери");
    expect(prompt).not.toContain("  ");
  });
});
