import { ART_STYLE, budgetPrompt } from "./art-style";
import { passportDescription, sceneArtDirectionForGenre } from "./scene-prompt";
import type { NarraCharacter } from "./types";

export interface CharacterPortraitPromptContext {
  bookContext?: string;
  genreId?: string;
  genreLabel?: string;
  /** Только для контролируемой генерации известных взрослых каталожных героинь. */
  assumeAdultFemale?: boolean;
}

/** Портреты идут через GPT Image и не ограничены коротким лимитом Kandinsky. */
export const PORTRAIT_PROMPT_CHAR_LIMIT = 1_600;

function femaleBodyDirection(
  character: NarraCharacter,
  genreId: string,
  assumeAdultFemale = false,
): string {
  if (
    (genreId !== "manga" && genreId !== "fanfiction") ||
    character.gender !== "female" ||
    (!assumeAdultFemale && (!character.passport || character.passport.age < 18))
  ) {
    return "";
  }

  return "Персонаж — взрослая женщина с огромной грудью, которая явно формирует объёмный силуэт под полностью закрытой одеждой. Образ строго несексуализированный: нейтральная поза, без декольте, наготы и эротического акцента.";
}

function portraitArtStyle(genreId: string, genreLabel: string): string {
  const direction =
    genreId === "classic"
      ? "классический живописный портрет в традиции книжной иллюстрации: натуральные пропорции, сдержанная академическая манера, мягкий естественный свет и благородная историческая палитра"
      : sceneArtDirectionForGenre(genreId);
  return `портретная иллюстрация в визуальном языке жанра «${genreLabel}»: ${direction}; единая серия работ одного художника; строго без текста, букв, цифр, надписей, логотипов и водяных знаков`;
}

export function buildCharacterPortraitPrompt(
  character: NarraCharacter,
  context: CharacterPortraitPromptContext = {},
): string {
  const genreId = context.genreId ?? "classic";
  const genreLabel = context.genreLabel ?? "классическая литература";
  if (character.id === "buratino") {
    return budgetPrompt(
      [
        "Ровно одна неодушевлённая театральная деревянная марионетка в кадре — Буратино. Это не человек и не ребёнок: окрашенная резная кукла без возраста и без реалистичной человеческой анатомии.",
        "Вертикальный портрет куклы до талии в среднем плане, строго анфас. Между верхним краем изображения и макушкой ровно 10% высоты кадра. Светлый однотонный фон.",
        context.bookContext
          ? `Кукольный персонаж книги ${context.bookContext}; простой костюм сказочного театра.`
          : "Кукольный персонаж сказочного театра в простом костюме.",
        "Без других персонажей, без текста, букв, логотипов и водяных знаков.",
        portraitArtStyle(genreId, genreLabel),
      ],
      PORTRAIT_PROMPT_CHAR_LIMIT,
      ART_STYLE,
    );
  }
  return budgetPrompt(
    [
      `Ровно один человек в кадре — ${character.fullName || character.name}, никого больше: без второстепенных персонажей, без силуэтов и людей на фоне.`,
      "Погрудный портрет: голова и плечи, строго анфас, ровный светлый фон. Вертикальный портрет до талии в среднем плане, строго анфас, взгляд в камеру. Камера отдалена: персонаж целиком показан от макушки до линии талии, полностью видны голова, плечи, грудь и весь торс; лицо не доминирует в кадре. Свободное пространство между верхним краем изображения и макушкой составляет ровно 10% высоты кадра. По сторонам плеч остаётся спокойное свободное пространство. Локти могут обрезаться боковыми краями, кисти рук не обязательны. Не делать headshot, крупный план лица или тесный погрудный кадр; не показывать человека в полный рост.",
      context.bookContext
        ? `Персонаж книги ${context.bookContext}: одежда, причёска и антураж строго соответствуют эпохе и миру книги, без современной одежды.`
        : "Одежда и причёска строго соответствуют эпохе и миру книги, без современной одежды.",
      `Выражение лица: ${character.expression || "естественное, в характере"}.`,
      femaleBodyDirection(character, genreId, context.assumeAdultFemale),
      `Внешность (соблюдать точно): ${passportDescription(character)}.`,
      portraitArtStyle(genreId, genreLabel),
    ],
    PORTRAIT_PROMPT_CHAR_LIMIT,
    ART_STYLE,
  );
}
