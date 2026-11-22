import { tFor, type Locale } from "./i18n";

/**
 * How close a piece of work is to what the person already knows (walkthrough W-154, 2026-10-29): `near`, `mid` or `far`. The owner's
 * words: 「距离我现在已有认知的 domain 越远的东西需要越详细的解释和材料，越近的则应该越简洁明了」. It decides how much a task is
 * prepared (`taskPreparation`: far gets a tutorial even when short, near never does) and how the step planner and the tutorial writer
 * write (near: the key points and the first move, no basics, no general guides; far: terms explained, why, one worked example and the
 * common mistakes, material from the start to enough).
 *
 * Why it matters (the expertise reversal effect, Kalyuga 2007, Educational Psychology Review 19(4)): worked examples and full
 * explanations help a novice and *hurt* someone who already knows the domain — they must reconcile the guidance with what they know,
 * which is load without learning. So the same tutorial is wrong at both ends.
 *
 * Who judges it (2026-11-22, replacing the rule score over background words, 「新手」 words and counts of accepted tasks): the step
 * planner, which reads the person's profile, facts, earlier work and lessons, writes `familiarity: {level, why}` with every plan
 * (`StepPlan.familiarity`). The person's own choice for the line and kind of work (`override`) wins; before any plan, `mid`.
 */
export type FamiliarityLevel = "near" | "mid" | "far";
export const FAMILIARITY_LEVELS: readonly FamiliarityLevel[] = ["near", "mid", "far"];
/** The planner's judgement as it is kept with the plan. */
export type ModelFamiliarity = { level: FamiliarityLevel; why: string };
export type Familiarity = {
  level: FamiliarityLevel;
  /** `person` when the person chose it for this line and kind of work, `model` when the planner judged it, `none` before either. */
  by: "person" | "model" | "none";
  /** What the level rests on, in plain English for the model (never shown as UI text). */
  basis: string[];
};

/** The planner's field (`stepPlanSchema`). */
export const FAMILIARITY_FIELD = { type: "object", additionalProperties: false, required: ["level", "why"], properties: {
  level: { type: "string", enum: [...FAMILIARITY_LEVELS] }, why: { type: "string" } } } as const;

/** The planner's judgement when it is one: a known level, the reason clipped. */
export function readModelFamiliarity(value: unknown): ModelFamiliarity | undefined {
  const item = value as Partial<ModelFamiliarity> | undefined;
  if (!item || typeof item !== "object" || !(FAMILIARITY_LEVELS as readonly unknown[]).includes(item.level)) return undefined;
  return { level: item.level as FamiliarityLevel, why: typeof item.why === "string" ? item.why.trim().slice(0, 300) : "" };
}

/** The setting holding the person's own choices, keyed `<line>|<archetype>` (archetype `*` when the task has none yet). */
export const FAMILIARITY_SETTING = "tasks.familiarity";
export const familiarityKey = (lineId: string, archetypeId: string | undefined) => `${lineId}|${archetypeId || "*"}`;

/** The person's choice for a line and kind of work: the exact kind first, then the whole line (`*`). */
export function familiarityOverride(raw: string | undefined, lineId: string, archetypeId: string | undefined): FamiliarityLevel | undefined {
  let map: Record<string, unknown> = {};
  try { map = JSON.parse(raw ?? "{}") as Record<string, unknown>; } catch { return undefined; }
  if (!map || typeof map !== "object") return undefined;
  for (const key of [familiarityKey(lineId, archetypeId), familiarityKey(lineId, undefined)]) {
    const value = map[key];
    if (typeof value === "string" && (FAMILIARITY_LEVELS as readonly string[]).includes(value)) return value as FamiliarityLevel;
  }
  return undefined;
}

/** The level in force: the person's choice, else the planner's judgement, else `mid`. */
export function familiarityOf(input: { override?: FamiliarityLevel | undefined; planned?: ModelFamiliarity | undefined }): Familiarity {
  if (input.override) return { level: input.override, by: "person", basis: [`the person set this line and kind of work as ${input.override}`] };
  if (input.planned) return { level: input.planned.level, by: "model", basis: input.planned.why ? [input.planned.why] : [] };
  return { level: "mid", by: "none", basis: ["not judged yet"] };
}

/** The tag on the task: what the level means for how much is explained. */
export function familiarityLabel(level: FamiliarityLevel, locale?: Locale): string {
  const t = tFor(locale);
  return level === "near" ? t("熟悉领域·从简") : level === "far" ? t("新领域·附讲解") : t("一般熟悉·按步骤");
}

/**
 * What the step planner and the tutorial writer are told for each level (the same sentence both read beside `familiarity` in their
 * input). Kept here so the two prompts and the tests agree.
 */
export const FAMILIARITY_INSTRUCTIONS = "`familiarity.level` says how close this work is to what the person already knows. "
  + "near: give the key points and the first move only; do not explain basic concepts the person's field already covers, do not cite "
  + "general authoritative guides (a NASA or MIT design-review guide for a researcher's own review), keep each step short. "
  + "far: explain each term the first time it is used, say why each step is done, give one concrete worked example and the common "
  + "mistakes, and list material from an introduction to just enough (a few sources, the most useful first; say where to get what the "
  + "person must supply, such as where to export a statement). mid: as usual.";

/** The planner alone: it judges the level itself, unless the person set one. */
export const FAMILIARITY_JUDGE = "Judge `familiarity` first and return it: level near, mid or far, from what `person` says about their "
  + "degree, field, job, skills and experience, what they said about being new to this, `doneSteps`, `acceptedOutputs` and `lessons`; "
  + "why is one plain sentence naming what it rests on. When `familiarity.setByPerson` is given, that is the level. Then write the steps "
  + "to that level. ";
