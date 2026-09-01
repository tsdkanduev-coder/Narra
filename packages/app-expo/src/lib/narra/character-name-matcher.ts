/**
 * Матчер имён персонажей в тексте книги для кликабельной разметки в ридере.
 *
 * Идея: от каждой словоформы имени (имя, фамилия, отчество из name/fullName)
 * строится основа (стем), а словоформы в тексте матчатся как «основа + допустимое
 * русское окончание» строго по границам слова. Защиты:
 * - основы короче MIN_NAME_STEM_LENGTH не участвуют в стем-матчинге
 *   (короткие имена матчатся только точной формой);
 * - частотные слова и титулы (стоп-лист) не подсвечиваются;
 * - слово должно начинаться с заглавной буквы;
 * - если основа принадлежит нескольким персонажам (общая фамилия, общее имя),
 *   одиночное упоминание не подсвечивается — только однозначная фраза
 *   («Драко Малфоя» — да, «Малфоя» при двух Малфоях — нет).
 *
 * Модуль без зависимостей и без DOM: он собирается esbuild'ом в reader-бандл
 * (см. scripts/build-reader.js) и переиспользуется RN-стороной для построения
 * спеки, поэтому логика матчинга существует в одном месте.
 */

export interface CharacterNameSource {
  id: string;
  name: string;
  fullName?: string;
  aliases?: string[];
  /**
   * Пол персонажа: при общей основе фамилии у двух героев (Раскольников /
   * Раскольникова) точные родовые формы («Раскольникова», «Раскольниковой» —
   * она; «Раскольников», «Раскольниковым» — он) остаются однозначными.
   */
  gender?: "male" | "female";
}

export interface CharacterNameMatcherSpec {
  /** основа (в нижнем регистре) → id персонажей, к которым она может относиться */
  stems: Record<string, string[]>;
  /** точные формы (включая безопасно сгенерированные падежные) → id персонажей */
  exact: Record<string, string[]>;
  /** допустимые окончания после основы */
  endings: string[];
  /** слова, которые никогда не подсвечиваются */
  stopwords: string[];
}

export interface CharacterNameMatch {
  /** индекс первого символа в тексте */
  start: number;
  /** индекс за последним символом */
  end: number;
  characterId: string;
}

export const MIN_NAME_STEM_LENGTH = 4;

/**
 * Русские падежные окончания, которые допускаются после основы имени.
 * Экспорт использует stress-markup (P9) для генерации словоформ с ударением.
 */
export const NAME_ENDINGS: readonly string[] = [
  "",
  "а",
  "я",
  "у",
  "ю",
  "е",
  "о",
  "ы",
  "и",
  "й",
  "ь",
  "ой",
  "ою",
  "ей",
  "ею",
  "ом",
  "ем",
  "ым",
  "им",
  "ам",
  "ям",
  "ах",
  "ях",
  "ами",
  "ями",
  "ье",
  "ья",
  "ью",
  "ьи",
];

/**
 * Титулы, обращения и частотные слова-омонимы: не годятся ни как основа имени,
 * ни как подсвечиваемая словоформа (сюда же попадают имена-омонимы вроде «Вера»).
 */
const NAME_STOPWORDS: readonly string[] = [
  // титулы и обращения
  "князь",
  "княжна",
  "княгиня",
  "граф",
  "графиня",
  "барон",
  "баронесса",
  "лорд",
  "леди",
  "сэр",
  "мадам",
  "месье",
  "мистер",
  "миссис",
  "мисс",
  "пан",
  "пани",
  "дон",
  "донна",
  "фрау",
  "герр",
  "доктор",
  "профессор",
  "капитан",
  "майор",
  "полковник",
  "генерал",
  "поручик",
  "лейтенант",
  "сержант",
  "адмирал",
  "отец",
  "мать",
  "матушка",
  "батюшка",
  "брат",
  "сестра",
  "дядя",
  "тётя",
  "тетя",
  "господин",
  "госпожа",
  "товарищ",
  "святой",
  "святая",
  "царь",
  "царица",
  "король",
  "королева",
  "принц",
  "принцесса",
  "император",
  "императрица",
  // частотные слова-омонимы имён
  "вера",
  "надежда",
  "любовь",
  "воля",
  "роза",
  "лилия",
  "мир",
  "лев",
  "свет",
  "света",
  "заря",
  "земля",
  "победа",
  "слава",
  "радость",
  "правда",
  "истина",
];

const VOWELS = "аеёиоуыэюя";

/** Основа словоформы имени: срезаем один финальный гласный, «й» или «ь». */
export function stemNameToken(token: string): string {
  if (token.length < 2) return token;
  const last = token[token.length - 1];
  if (last === "й" || last === "ь" || VOWELS.includes(last)) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Возвращает только полные словоформы, которые можно получить без словаря и
 * без матчинга по произвольному продолжению основы. Это особенно важно для
 * коротких имён (Анна → Анну) и фамилий-прилагательных
 * (Вронский → Вронского, Раневская → Раневскую).
 */
function exactRussianNameForms(token: string): string[] {
  const forms = new Set<string>();
  const addForms = (base: string, endings: readonly string[]) => {
    for (const ending of endings) forms.add(`${base}${ending}`);
  };

  // Короткая основа не участвует в стем-матчинге: перечисляем полные формы.
  const stem = stemNameToken(token);
  if (token.length >= MIN_NAME_STEM_LENGTH && stem.length < MIN_NAME_STEM_LENGTH) {
    forms.add(token);
    if (token.endsWith("а")) {
      const base = token.slice(0, -1);
      const genitiveEnding = /[гкхжчшщц]$/.test(base) ? "и" : "ы";
      addForms(base, [genitiveEnding, "е", "у", "ой", "ою"]);
    } else if (token.endsWith("я")) {
      addForms(token.slice(0, -1), ["и", "е", "ю", "ей", "ею"]);
    }
  }

  // Мужские фамилии-прилагательные: Вронский, Троцкий.
  if (/(?:ск|цк)ий$/.test(token)) {
    addForms(token.slice(0, -2), ["ого", "ому", "им", "ом"]);
  }
  // Женские фамилии на -ская/-цкая: Раневская, Троцкая.
  else if (/(?:ск|цк)ая$/.test(token)) {
    addForms(token.slice(0, -2), ["ой", "ую", "ою"]);
  }

  return [...forms];
}

/**
 * Родовые формы русских фамилий на -ов/-ев/-ин: нужны только там, где основа
 * фамилии общая для мужчины и женщины. Совпадающие формы (муж. род. «Раскольникова»
 * = жен. им. «Раскольникова») отдаются женской: в авторских ремарках имя стоит
 * в именительном падеже, а родительный мужской формы редко называет говорящего.
 */
function genderedSurnameForms(token: string, gender: "male" | "female"): string[] {
  if (gender === "female") {
    const match = /^(.+(?:ов|ев|ёв|ин|ын))а$/.exec(token);
    if (!match) return [];
    return [token, `${match[1]}ой`, `${match[1]}ою`];
  }
  if (!/(?:ов|ев|ёв|ин|ын)$/.test(token)) return [];
  return [token, `${token}ым`];
}

function addId(map: Record<string, string[]>, key: string, id: string): void {
  const existing = map[key];
  if (!existing) {
    map[key] = [id];
    return;
  }
  if (!existing.includes(id)) existing.push(id);
}

/**
 * Строит спеку матчера из персонажей книги. Персонажи с запертым доступом
 * сюда просто не передаются — их имена не будут размечены вовсе.
 */
export function buildCharacterNameMatcherSpec(
  characters: readonly CharacterNameSource[],
): CharacterNameMatcherSpec {
  const stems: Record<string, string[]> = {};
  const exact: Record<string, string[]> = {};
  const stopwordSet = new Set(NAME_STOPWORDS);

  for (const character of characters) {
    if (!character?.id) continue;
    const raw = [character.name, character.fullName ?? "", ...(character.aliases ?? [])].join(" ");
    const tokens = raw.toLowerCase().match(/[a-zа-яё]+/g) ?? [];
    for (const token of new Set(tokens)) {
      if (token.length < 3 || stopwordSet.has(token)) continue;
      for (const form of exactRussianNameForms(token)) addId(exact, form, character.id);
      const stem = stemNameToken(token);
      if (stem.length >= MIN_NAME_STEM_LENGTH) {
        addId(stems, stem, character.id);
      }
    }
  }

  // Родовые формы фамилий добавляем только для общих основ: у единственного
  // носителя фамилии стем-матчинг и так однозначен.
  for (const character of characters) {
    if (!character?.id || !character.gender) continue;
    const raw = [character.name, character.fullName ?? "", ...(character.aliases ?? [])].join(" ");
    const tokens = raw.toLowerCase().match(/[a-zа-яё]+/g) ?? [];
    for (const token of new Set(tokens)) {
      if (token.length < 3 || stopwordSet.has(token)) continue;
      const stem = stemNameToken(token);
      if (stem.length < MIN_NAME_STEM_LENGTH || (stems[stem]?.length ?? 0) < 2) continue;
      for (const form of genderedSurnameForms(token, character.gender)) {
        addId(exact, form, character.id);
      }
    }
  }

  return {
    stems,
    exact,
    endings: [...NAME_ENDINGS],
    stopwords: [...NAME_STOPWORDS],
  };
}

interface PreparedSpec {
  stems: Map<string, readonly string[]>;
  exact: Map<string, readonly string[]>;
  stopwords: Set<string>;
  endings: readonly string[];
}

const preparedCache = new WeakMap<CharacterNameMatcherSpec, PreparedSpec>();

function prepareSpec(spec: CharacterNameMatcherSpec): PreparedSpec {
  const cached = preparedCache.get(spec);
  if (cached) return cached;
  const prepared: PreparedSpec = {
    stems: new Map(Object.entries(spec.stems ?? {})),
    exact: new Map(Object.entries(spec.exact ?? {})),
    stopwords: new Set(spec.stopwords ?? []),
    endings: spec.endings?.length ? spec.endings : [...NAME_ENDINGS],
  };
  preparedCache.set(spec, prepared);
  return prepared;
}

function lookupWordIds(word: string, prepared: PreparedSpec): string[] {
  const ids = new Set<string>();
  const exactIds = prepared.exact.get(word);
  if (exactIds) for (const id of exactIds) ids.add(id);
  // Точная форма конкретнее основы: если словоформа перечислена явно (в том
  // числе родовая форма фамилии), кандидаты по общей основе её не размывают.
  if (ids.size > 0) return [...ids];
  for (const ending of prepared.endings) {
    if (ending.length >= word.length) continue;
    if (ending && !word.endsWith(ending)) continue;
    const stem = ending ? word.slice(0, word.length - ending.length) : word;
    if (stem.length < MIN_NAME_STEM_LENGTH) continue;
    const stemIds = prepared.stems.get(stem);
    if (stemIds) for (const id of stemIds) ids.add(id);
  }
  return [...ids];
}

function isUpperCaseLetter(char: string): boolean {
  return /[A-ZА-ЯЁ]/.test(char);
}

interface WordToken {
  start: number;
  end: number;
  ids: string[];
}

/**
 * Находит однозначные упоминания персонажей в тексте.
 * Соседние слова одного персонажа («Евгений Базаров») склеиваются в один матч;
 * неоднозначные основы матчатся только когда фраза сужает кандидатов до одного
 * («Анна Аркадьевна Каренина» — да, «Каренина» — нет).
 */
export function findCharacterNameMatches(
  text: string,
  spec: CharacterNameMatcherSpec | null | undefined,
): CharacterNameMatch[] {
  if (!text || !spec) return [];
  if (!/[A-ZА-ЯЁ]/.test(text)) return [];
  const prepared = prepareSpec(spec);
  if (prepared.stems.size === 0 && prepared.exact.size === 0) return [];

  const tokens: WordToken[] = [];
  for (const match of text.matchAll(/[A-Za-zА-Яа-яЁё]+/g)) {
    const word = match[0];
    if (match.index == null || !isUpperCaseLetter(word[0])) continue;
    const lower = word.toLowerCase();
    if (prepared.stopwords.has(lower)) continue;
    const ids = lookupWordIds(lower, prepared);
    if (ids.length === 0) continue;
    tokens.push({ start: match.index, end: match.index + word.length, ids });
  }

  const matches: CharacterNameMatch[] = [];
  let index = 0;
  while (index < tokens.length) {
    const first = tokens[index];
    let candidateIds = first.ids;
    let lastIncluded = index;
    let next = index + 1;
    while (next < tokens.length) {
      const gap = text.slice(tokens[next - 1].end, tokens[next].start);
      if (!/^\s+$/.test(gap)) break;
      const intersection = candidateIds.filter((id) => tokens[next].ids.includes(id));
      if (intersection.length === 0) break;
      candidateIds = intersection;
      lastIncluded = next;
      next += 1;
    }
    if (candidateIds.length === 1 && (first.ids.length === 1 || lastIncluded > index)) {
      matches.push({
        start: first.start,
        end: tokens[lastIncluded].end,
        characterId: candidateIds[0],
      });
      index = lastIncluded + 1;
    } else {
      index += 1;
    }
  }
  return matches;
}
