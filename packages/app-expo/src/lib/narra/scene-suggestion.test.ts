import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_SUGGESTION_INTERVAL,
  FIRST_SCENE_SUGGESTION_PAGES,
  INITIAL_SCENE_SUGGESTION_STATE,
  SCENE_SUGGESTION_INTERVALS,
  type SceneSuggestionRelocate,
  type SceneSuggestionState,
  advanceSceneSuggestion,
} from "./scene-suggestion";

function pageRelocate(section: number, page: number): SceneSuggestionRelocate {
  return {
    section: { current: section, total: 10 },
    page: { current: page, total: 40 },
    fraction: (section * 40 + page) / 400,
  };
}

/** Состояние после первой (ранней) врезки — обычный интервальный режим. */
const ONGOING_STATE: SceneSuggestionState = {
  ...INITIAL_SCENE_SUGGESTION_STATE,
  firstSuggested: true,
};

/** Прогоняет цепочку relocate, возвращает финальное состояние и число предложений. */
function run(
  events: SceneSuggestionRelocate[],
  interval: number,
  initial: SceneSuggestionState = INITIAL_SCENE_SUGGESTION_STATE,
) {
  let state = initial;
  let suggestions = 0;
  for (const detail of events) {
    const result = advanceSceneSuggestion(state, detail, interval);
    state = result.state;
    if (result.suggest) suggestions += 1;
  }
  return { state, suggestions };
}

describe("настройка частоты врезок", () => {
  it("дефолт — 8 страниц, варианты 3/4/8/выкл", () => {
    expect(DEFAULT_SCENE_SUGGESTION_INTERVAL).toBe(8);
    expect(SCENE_SUGGESTION_INTERVALS).toEqual([3, 4, 8, 0]);
    expect(SCENE_SUGGESTION_INTERVALS).toContain(DEFAULT_SCENE_SUGGESTION_INTERVAL);
  });

  it("interval = 0 (выкл): никогда не предлагает и не копит счётчик", () => {
    const events = Array.from({ length: 30 }, (_, index) => pageRelocate(0, index + 1));
    const { state, suggestions } = run(events, 0);
    expect(suggestions).toBe(0);
    expect(state.pagesTurned).toBe(0);
  });
});

describe("первая врезка сессии книги (P16)", () => {
  it("первое предложение — после 2 перелистываний вперёд с открытия книги", () => {
    expect(FIRST_SCENE_SUGGESTION_PAGES).toBe(2);
    const events = [pageRelocate(0, 1), pageRelocate(0, 2), pageRelocate(0, 3)];
    // Первый relocate — привязка, затем 2 перелистывания → ранняя врезка
    const { state, suggestions } = run(events, DEFAULT_SCENE_SUGGESTION_INTERVAL);
    expect(suggestions).toBe(1);
    expect(state.firstSuggested).toBe(true);
    expect(state.pagesTurned).toBe(0);
  });

  it("после первой врезки — обычный интервал настройки", () => {
    // Привязка + 2 перелистывания (ранняя врезка) + ещё 8 → вторая врезка
    const events = Array.from({ length: 11 }, (_, index) => pageRelocate(0, index + 1));
    expect(run(events, 8).suggestions).toBe(2);
    // А одного интервала после ранней врезки не хватает
    expect(run(events.slice(0, 10), 8).suggestions).toBe(1);
  });

  it("врезки выключены (interval = 0) — ранней врезки тоже нет", () => {
    const events = [pageRelocate(0, 1), pageRelocate(0, 2), pageRelocate(0, 3)];
    expect(run(events, 0).suggestions).toBe(0);
  });

  it("прыжок сбрасывает счётчик, но не признак первой врезки", () => {
    const shown = run([pageRelocate(0, 1), pageRelocate(0, 2), pageRelocate(0, 3)], 8).state;
    const jumped = advanceSceneSuggestion(shown, pageRelocate(5, 1), 8);
    expect(jumped.state.firstSuggested).toBe(true);
    expect(jumped.state.pagesTurned).toBe(0);
  });

  it("при коротком интервале первая врезка не позже интервала", () => {
    // interval 1 меньше FIRST_SCENE_SUGGESTION_PAGES — врезка после 1 страницы
    const { suggestions } = run([pageRelocate(0, 1), pageRelocate(0, 2)], 1);
    expect(suggestions).toBe(1);
  });
});

describe("счётчик перелистываний", () => {
  it("предлагает ровно раз в N страниц вперёд", () => {
    const events = Array.from({ length: 6 }, (_, index) => pageRelocate(0, index + 1));
    // Первый relocate — привязка позиции, дальше 5 перелистываний
    expect(run(events, 5, ONGOING_STATE).suggestions).toBe(1);
    expect(run(events, 5, ONGOING_STATE).state.pagesTurned).toBe(0);
  });

  it("после предложения счётчик начинается заново", () => {
    const events = Array.from({ length: 11 }, (_, index) => pageRelocate(0, index + 1));
    // 10 перелистываний при interval 5 → две врезки
    expect(run(events, 5, ONGOING_STATE).suggestions).toBe(2);
  });

  it("первый relocate (восстановление позиции) не считается страницей", () => {
    const { state } = run([pageRelocate(2, 17)], 5);
    expect(state.pagesTurned).toBe(0);
    expect(state.step).toEqual({ mode: "page", section: 2, page: 17 });
  });

  it("повтор той же позиции (resize, повторный relocate) не считается", () => {
    const { state } = run([pageRelocate(0, 1), pageRelocate(0, 1), pageRelocate(0, 1)], 5);
    expect(state.pagesTurned).toBe(0);
  });

  it("переход в следующую главу считается одним перелистыванием", () => {
    const { state } = run([pageRelocate(0, 39), pageRelocate(1, 1)], 5);
    expect(state.pagesTurned).toBe(1);
  });

  it("страница назад не считается, но и не сбрасывает счётчик", () => {
    const forward = [pageRelocate(0, 1), pageRelocate(0, 2), pageRelocate(0, 3)];
    const { state } = run([...forward, pageRelocate(0, 2)], 5, ONGOING_STATE);
    expect(state.pagesTurned).toBe(2);
  });

  it("быстрый свайп (relocate с шагом 2–3 страницы) считается чтением вперёд", () => {
    // foliate коалесцирует быстрые перелистывания в один relocate; раньше это
    // было «прыжком» и счётчик обнулялся — врезка могла не наступить никогда
    const events = [pageRelocate(0, 1), pageRelocate(0, 3), pageRelocate(0, 6)];
    const { state } = run(events, 8, ONGOING_STATE);
    expect(state.pagesTurned).toBe(2);
  });

  it("шаг назад на 2–3 страницы не считается и не сбрасывает счётчик", () => {
    const forward = [pageRelocate(0, 1), pageRelocate(0, 2), pageRelocate(0, 3)];
    const { state } = run([...forward, pageRelocate(0, 1)], 5, ONGOING_STATE);
    expect(state.pagesTurned).toBe(2);
  });

  it("прыжок (оглавление/поиск) сбрасывает счётчик", () => {
    const forward = Array.from({ length: 5 }, (_, index) => pageRelocate(0, index + 1));
    const { state, suggestions } = run([...forward, pageRelocate(7, 3)], 8, ONGOING_STATE);
    expect(suggestions).toBe(0);
    expect(state.pagesTurned).toBe(0);
    expect(state.step).toEqual({ mode: "page", section: 7, page: 3 });
  });

  it("программная навигация (suppressed) перепривязывает позицию без счёта", () => {
    let state = INITIAL_SCENE_SUGGESTION_STATE;
    state = advanceSceneSuggestion(state, pageRelocate(0, 1), 5).state;
    state = advanceSceneSuggestion(state, pageRelocate(0, 2), 5).state;
    const result = advanceSceneSuggestion(state, pageRelocate(0, 3), 5, true);
    expect(result.suggest).toBe(false);
    // Сам переход страницей не считается, но накопленный счётчик сохраняется
    expect(result.state.pagesTurned).toBe(1);
    expect(result.state.step).toEqual({ mode: "page", section: 0, page: 3 });
  });

  it("suppressed-переход не съедает прогресс: счёт продолжается после guard-окна", () => {
    let state = ONGOING_STATE;
    state = advanceSceneSuggestion(state, pageRelocate(0, 1), 4).state;
    state = advanceSceneSuggestion(state, pageRelocate(0, 2), 4).state; // 1
    state = advanceSceneSuggestion(state, pageRelocate(0, 3), 4).state; // 2
    // Восстановление позиции / программный переход
    state = advanceSceneSuggestion(state, pageRelocate(2, 5), 4, true).state;
    state = advanceSceneSuggestion(state, pageRelocate(2, 6), 4).state; // 3
    const result = advanceSceneSuggestion(state, pageRelocate(2, 7), 4); // 4 → suggest
    expect(result.suggest).toBe(true);
  });

  it("moved=true при смене страницы — плашка скрывается при перелистывании", () => {
    let state = INITIAL_SCENE_SUGGESTION_STATE;
    state = advanceSceneSuggestion(state, pageRelocate(0, 1), 5).state;
    const moved = advanceSceneSuggestion(state, pageRelocate(0, 2), 5);
    expect(moved.moved).toBe(true);
    const same = advanceSceneSuggestion(moved.state, pageRelocate(0, 2), 5);
    expect(same.moved).toBe(false);
  });

  it("смена настройки применяется со следующего перелистывания", () => {
    // 4 перелистывания при interval 8 — врезки ещё нет
    const events = Array.from({ length: 5 }, (_, index) => pageRelocate(0, index + 1));
    const { state, suggestions } = run(events, 8, ONGOING_STATE);
    expect(suggestions).toBe(0);
    // Пользователь сменил частоту на 5: накопленное учитывается
    const next = advanceSceneSuggestion(state, pageRelocate(0, 6), 5);
    expect(next.suggest).toBe(true);
  });
});

describe("фолбэк без пагинации (scroll-режим, только fraction)", () => {
  const fraction = (value: number): SceneSuggestionRelocate => ({ fraction: value });

  it("плавное продвижение вперёд считается страницами", () => {
    const events = [0.1, 0.12, 0.14, 0.16].map(fraction);
    const { state, suggestions } = run(events, 3, ONGOING_STATE);
    expect(suggestions).toBe(1);
    expect(state.pagesTurned).toBe(0);
  });

  it("большой скачок доли — прыжок, счётчик заново", () => {
    const events = [0.1, 0.12, 0.6].map(fraction);
    const { state } = run(events, 5);
    expect(state.pagesTurned).toBe(0);
  });

  it("relocate без позиции игнорируется", () => {
    const result = advanceSceneSuggestion(INITIAL_SCENE_SUGGESTION_STATE, {}, 5);
    expect(result).toEqual({
      state: INITIAL_SCENE_SUGGESTION_STATE,
      suggest: false,
      moved: false,
    });
  });
});
