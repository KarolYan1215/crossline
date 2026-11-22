/**
 * The person's own choice of model and reasoning effort (D19, docs/plans/2026-11-22-interview-and-import-redesign.md §三.5): set beside the
 * interview's input box and under Settings → 模型, kept per workspace in the ledger (`model.choice`), read by the worker per run. A choice
 * wins over the route table, is never stepped down when the quota is tight, and is never swapped for another model: a model the account
 * does not have, or a spent quota, is said as such (`packages/codex/src/skill-runner.ts`). Only runs on the account's own Codex take it;
 * a provider's model is the provider's.
 */
export const MODEL_CHOICE_SETTING = "model.choice";

/** The slot for every Skill without a choice of its own. */
export const OTHER_SKILLS = "*";

export type ModelChoice = { model: string; effort?: string };
/** Keyed by a Skill's own name (without the `crossline:` prefix), or `OTHER_SKILLS`. */
export type ModelChoices = Record<string, ModelChoice>;

/** What can be chosen, in the person's words: the interview, its 整理层 and 调研层, and everything else. */
export const MODEL_CHOICE_SLOTS = [
  { key: "crossline-onboarding", label: "访谈" },
  { key: "crossline-onboarding-extract", label: "整理层" },
  { key: "crossline-onboarding-research", label: "调研层" },
  { key: OTHER_SKILLS, label: "其他 Skill" }
] as const;
export type ModelChoiceSlot = (typeof MODEL_CHOICE_SLOTS)[number]["key"];

const SLOTS = new Set<string>(MODEL_CHOICE_SLOTS.map((slot) => slot.key));
/** The efforts the runtime knows; which of them a model takes is the catalogue's to say. */
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
/** A model id is the runtime's own string; this only keeps a pasted paragraph or a control character out of the ledger. */
const MODEL_ID = /^[\w.:@/-]{1,100}$/;

export const isModelChoiceSlot = (key: string): key is ModelChoiceSlot => SLOTS.has(key);

/** Why a choice cannot be stored, or undefined when it can. */
export function modelChoiceProblem(choice: { model?: unknown; effort?: unknown }): string | undefined {
  if (typeof choice.model !== "string" || !MODEL_ID.test(choice.model)) return "INVALID_MODEL";
  if (choice.effort !== undefined && (typeof choice.effort !== "string" || !EFFORTS.has(choice.effort))) return "INVALID_EFFORT";
  return undefined;
}

/** The stored choices; anything unreadable or malformed counts as no choice, never as a guess. */
export function modelChoicesOf(raw: string | null | undefined): ModelChoices {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const choices: ModelChoices = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isModelChoiceSlot(key) || !value || typeof value !== "object") continue;
      const { model, effort } = value as { model?: unknown; effort?: unknown };
      if (modelChoiceProblem({ model, effort })) continue;
      choices[key] = { model: model as string, ...(typeof effort === "string" ? { effort } : {}) };
    }
    return choices;
  } catch { return {}; }
}

/** The choice a Skill runs on: its own slot's, else the one for every other Skill, else none (the route table decides). */
export function modelChoiceFor(choices: ModelChoices, skillName: string): ModelChoice | undefined {
  const key = skillName.replace(/^crossline:/, "");
  return choices[key] ?? choices[OTHER_SKILLS];
}

/** The choices with one slot set, or cleared with `null` (back to the route table). */
export function withModelChoice(choices: ModelChoices, slot: ModelChoiceSlot, choice: ModelChoice | null): ModelChoices {
  const next = { ...choices };
  if (choice) next[slot] = { model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) };
  else delete next[slot];
  return next;
}
