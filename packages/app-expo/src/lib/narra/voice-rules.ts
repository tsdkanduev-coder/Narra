import type { NarraCharacter, NarraGender } from "./types";

/**
 * Единая точка правды правил озвучки Narra.
 *
 * Коды голосов сверены с фактическим реестром /v2/speech
 * (narra/docs/narra-release-plan.md, staging probe 2026-07-23, provider picker):
 * `Che→Афина`, `She→Сбер`, `Erm→Джой`, `Ast→Стерлинг`, `Gal→Галустьян`,
 * `Ste→Стремпаржевская`, `Tso→Цокаева`, `Bez→Безлепкин`, `Ego→Егоров`,
 * `Chr→Чернышова`, `Izv→Изволов`, `Saf→Сафронова`, `Kov→Ковалев`,
 * `Mar→Марков`, `Kas→Пират Касперович`, `Efo→Фокин`.
 * Прежний нарраторский код `Shi` в реестре не подтверждён и больше не используется.
 */

export type NarraVoiceType = "assistant" | "actor" | "easter";

export type NarraNarratorPreference = "male" | "female";

export const DEFAULT_NARRATOR_PREFERENCE: NarraNarratorPreference = "female";

export interface NarraVoiceInfo {
  /** Человеческое имя голоса в продукте. */
  name: string;
  gender: NarraGender;
  type: NarraVoiceType;
  /** Может ли голос выдаваться автоматически (пасхалки и сломанный синтез — нет). */
  autoAssign: boolean;
}

export const VOICES: Readonly<Record<string, NarraVoiceInfo>> = {
  // Ассистентские голоса: нарратор и главный герой.
  Che: { name: "Афина", gender: "female", type: "assistant", autoAssign: true },
  She: { name: "Сбер", gender: "male", type: "assistant", autoAssign: true },
  Erm: { name: "Джой", gender: "female", type: "assistant", autoAssign: true },
  // Актёрская библиотека (порядок приоритета — в ACTOR_PRIORITY).
  // TODO(Фокин): код `Efo` подтверждён по provider picker, но синтез не работает
  // (`Efo_48000` — HTTP 400, `Efo_24000` — HTTP 502), поэтому autoAssign: false
  // до починки на стороне gateway.
  Efo: { name: "Фокин", gender: "male", type: "actor", autoAssign: false },
  Ast: { name: "Стерлинг", gender: "male", type: "actor", autoAssign: true },
  Gal: { name: "Галустьян", gender: "male", type: "actor", autoAssign: true },
  Ste: { name: "Стремпаржевская", gender: "female", type: "actor", autoAssign: true },
  Tso: { name: "Цокаева", gender: "female", type: "actor", autoAssign: true },
  Bez: { name: "Безлепкин", gender: "male", type: "actor", autoAssign: true },
  Ego: { name: "Егоров", gender: "male", type: "actor", autoAssign: true },
  Chr: { name: "Чернышова", gender: "female", type: "actor", autoAssign: true },
  Izv: { name: "Изволов", gender: "male", type: "actor", autoAssign: true },
  // Сафронова — приоритет детским книгам и сказкам (opts.childrensBook).
  Saf: { name: "Сафронова", gender: "female", type: "actor", autoAssign: true },
  Kov: { name: "Ковалев", gender: "male", type: "actor", autoAssign: true },
  // Пасхалки: НИКОГДА не участвуют в автоназначении, только ручной выбор.
  Mar: { name: "Марков", gender: "male", type: "easter", autoAssign: false },
  Kas: { name: "Пират", gender: "male", type: "easter", autoAssign: false },
};

/** Актёрский пул в утверждённом порядке приоритета (work order, правило 4). */
export const ACTOR_PRIORITY: readonly string[] = [
  "Efo",
  "Ast",
  "Gal",
  "Ste",
  "Tso",
  "Bez",
  "Ego",
  "Chr",
  "Izv",
  "Saf",
  "Kov",
];

/** Ассистентские голоса по полу в порядке предпочтения. */
const ASSISTANT_PRIORITY: Readonly<Record<NarraGender, readonly string[]>> = {
  female: ["Che", "Erm"],
  male: ["She"],
};

/**
 * Просодические варианты для повтора голоса при исчерпании пула.
 * pitch — сдвиг высоты в полутонах, rate — множитель скорости.
 */
export interface NarraProsody {
  pitch?: number;
  rate?: number;
}

export const PROSODY_VARIANTS: readonly NarraProsody[] = [
  { pitch: -2 },
  { pitch: 2 },
  { rate: 0.9 },
  { rate: 1.1 },
  { pitch: -2, rate: 1.1 },
  { pitch: 2, rate: 0.9 },
];

export function narratorVoiceFor(preference: NarraNarratorPreference | undefined): string {
  return (preference ?? DEFAULT_NARRATOR_PREFERENCE) === "male" ? "She" : "Che";
}

export interface VoiceAssignmentCharacter {
  id: string;
  gender: NarraGender;
  /** Уже посчитанная значимость (доля прямой речи + упоминания): больше — важнее. */
  rank?: number;
  /** Безымянный эпизодник — получает голос нарратора. */
  isMinor?: boolean;
  /** Персонаж-рассказчик — получает голос нарратора вне очереди. */
  isNarrator?: boolean;
  /**
   * Ручной выбор голоса пользователем (правило 3): приоритет над любым
   * автоназначением, слоты ассистентов и актёрского пула не расходует.
   * Допустимы и пасхалки (Марков/Пират). Неизвестный код игнорируется.
   */
  voiceOverride?: string;
}

export interface AssignVoicesOptions {
  narratorPreference?: NarraNarratorPreference;
  /** Повествование от 1-го лица: главный герой — рассказчик, один голос с нарратором. */
  firstPerson?: boolean;
  /** Детская книга/сказка: Сафронова получает приоритет в женском пуле. */
  childrensBook?: boolean;
  /** Ключ кэша: план закрепляется за книгой и не пересчитывается. */
  bookId?: string;
}

export interface VoiceAssignment {
  voice: string;
  prosody?: NarraProsody;
}

export interface VoicePlan {
  narratorVoice: string;
  assignments: Record<string, VoiceAssignment>;
}

function actorPool(gender: NarraGender, childrensBook: boolean): string[] {
  const pool = ACTOR_PRIORITY.filter(
    (code) => VOICES[code].autoAssign && VOICES[code].gender === gender,
  );
  if (childrensBook && gender === "female") {
    const priority = pool.filter((code) => code === "Saf");
    return [...priority, ...pool.filter((code) => code !== "Saf")];
  }
  return pool;
}

function resolveOverride(character: VoiceAssignmentCharacter): string | undefined {
  return character.voiceOverride && VOICES[character.voiceOverride]
    ? character.voiceOverride
    : undefined;
}

function buildPlan(characters: VoiceAssignmentCharacter[], opts: AssignVoicesOptions): VoicePlan {
  const narratorVoice = narratorVoiceFor(opts.narratorPreference);
  const assignments: Record<string, VoiceAssignment> = {};

  // Ручное переопределение — приоритет над всем; такие герои выходят из
  // автоочереди и не расходуют ассистентские/актёрские слоты.
  for (const character of characters) {
    const override = resolveOverride(character);
    if (override) assignments[character.id] = { voice: override };
  }

  const majors = characters
    .map((character, index) => ({ character, index }))
    .filter(
      ({ character }) => !character.isMinor && !character.isNarrator && !resolveOverride(character),
    )
    .sort((a, b) => (b.character.rank ?? 0) - (a.character.rank ?? 0) || a.index - b.index)
    .map(({ character }) => character);

  // Эпизодники и персонаж-рассказчик — голос нарратора.
  for (const character of characters) {
    if ((character.isMinor || character.isNarrator) && !assignments[character.id]) {
      assignments[character.id] = { voice: narratorVoice };
    }
  }

  const freeAssistants = new Set(
    Object.keys(VOICES).filter(
      (code) => VOICES[code].type === "assistant" && code !== narratorVoice,
    ),
  );
  const takeAssistant = (gender: NarraGender): string | undefined => {
    const code = ASSISTANT_PRIORITY[gender].find((candidate) => freeAssistants.has(candidate));
    if (code) freeAssistants.delete(code);
    return code;
  };

  const poolCursor: Record<NarraGender, number> = { male: 0, female: 0 };
  const takeActor = (gender: NarraGender): VoiceAssignment => {
    const pool = actorPool(gender, Boolean(opts.childrensBook));
    if (pool.length === 0) return { voice: narratorVoice };
    const index = poolCursor[gender]++;
    const voice = pool[index % pool.length];
    const cycle = Math.floor(index / pool.length);
    if (cycle === 0) return { voice };
    // Пул исчерпан: повторяем голос с изменённой просодией (детерминированно).
    return { voice, prosody: PROSODY_VARIANTS[(cycle - 1) % PROSODY_VARIANTS.length] };
  };

  majors.forEach((character, order) => {
    if (order === 0) {
      if (opts.firstPerson) {
        // Главный герой — рассказчик: один голос с нарратором.
        assignments[character.id] = { voice: narratorVoice };
      } else {
        const assistant = takeAssistant(character.gender);
        assignments[character.id] = assistant ? { voice: assistant } : takeActor(character.gender);
      }
      return;
    }
    if (order === 1 && opts.firstPerson) {
      // Второй ассистентский голос уходит следующему по значимости.
      const assistant = takeAssistant(character.gender);
      if (assistant) {
        assignments[character.id] = { voice: assistant };
        return;
      }
    }
    assignments[character.id] = takeActor(character.gender);
  });

  return { narratorVoice, assignments };
}

const planCache = new Map<string, { signature: string; plan: VoicePlan }>();

function planSignature(characters: VoiceAssignmentCharacter[], opts: AssignVoicesOptions): string {
  return JSON.stringify([
    characters.map((c) => [
      c.id,
      c.gender,
      c.rank ?? 0,
      Boolean(c.isMinor),
      Boolean(c.isNarrator),
      c.voiceOverride ?? "",
    ]),
    opts.narratorPreference ?? DEFAULT_NARRATOR_PREFERENCE,
    Boolean(opts.firstPerson),
    Boolean(opts.childrensBook),
  ]);
}

/**
 * Назначает голоса персонажам по канону озвучки. Результат детерминирован;
 * при переданном opts.bookId план кэшируется на книгу.
 */
export function assignVoices(
  characters: VoiceAssignmentCharacter[],
  opts: AssignVoicesOptions = {},
): VoicePlan {
  if (!opts.bookId) return buildPlan(characters, opts);
  const signature = planSignature(characters, opts);
  const cached = planCache.get(opts.bookId);
  if (cached && cached.signature === signature) return cached.plan;
  const plan = buildPlan(characters, opts);
  planCache.set(opts.bookId, { signature, plan });
  return plan;
}

export function clearVoicePlanCache(bookId?: string): void {
  if (bookId) planCache.delete(bookId);
  else planCache.clear();
}

/**
 * Пересчитывает автоголоса уже разобранного состава (смена голоса нарратора,
 * правило 1: ни один герой не должен звучать голосом нарратора, пока есть
 * свободные голоса). Порядок массива — rank по убыванию значимости. Поле voice
 * остаётся автоголосом: ручной voiceOverride хранится отдельно и имеет
 * приоритет при озвучке (voice-markup, scene-audio). Возвращает тот же массив,
 * если ни один голос не изменился.
 */
export function replanCharacterVoices(
  characters: readonly NarraCharacter[],
  opts: AssignVoicesOptions = {},
): NarraCharacter[] {
  if (characters.length === 0) return [...characters];
  const plan = assignVoices(
    characters.map((character, index) => ({
      id: character.id,
      gender: character.gender,
      rank: characters.length - index,
      isNarrator: character.isNarrator,
    })),
    opts,
  );
  let changed = false;
  const next = characters.map((character) => {
    const assignment = plan.assignments[character.id];
    const voice = assignment?.voice ?? plan.narratorVoice;
    const prosody = assignment?.prosody;
    if (
      character.voice === voice &&
      JSON.stringify(character.voiceProsody ?? null) === JSON.stringify(prosody ?? null)
    )
      return character;
    changed = true;
    return { ...character, voice, voiceProsody: prosody };
  });
  return changed ? next : [...characters];
}

const SENTENCE_SPLIT_RE = /[.!?…]+(?:\s|$)/u;
const FIRST_PERSON_RE = /(^|[^\p{L}])(я|меня|мне)(?=[^\p{L}]|$)/iu;
const DIALOGUE_LINE_RE = /^\s*[—–-]\s/u;
const MAX_DETECT_CHARS = 40_000;
const FIRST_PERSON_THRESHOLD = 0.12;

/**
 * Эвристика повествования от 1-го лица по первым главам: доля предложений
 * повествования (вне прямой речи «—») с «я »/«меня »/«мне ».
 */
export function detectFirstPerson(text: string): boolean {
  const narration = text
    .slice(0, MAX_DETECT_CHARS)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !DIALOGUE_LINE_RE.test(line))
    .join("\n");
  const sentences = narration.split(SENTENCE_SPLIT_RE).filter((sentence) => sentence.trim());
  if (sentences.length === 0) return false;
  const firstPerson = sentences.filter((sentence) => FIRST_PERSON_RE.test(sentence)).length;
  return firstPerson / sentences.length >= FIRST_PERSON_THRESHOLD;
}
