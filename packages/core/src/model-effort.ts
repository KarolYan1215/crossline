/**
 * How hard the account's own Codex thinks (2026-10-31, the owner: 「设置中允许用户自行设置模型强度（仅对chatgpt用户起效）」). Every Skill
 * keeps its tier; the preference moves each one's effort one step (`lower`: high → medium, medium → low; `higher`: medium → high, high →
 * xhigh). A provider or the developer's model is never moved: their price and limits are not the person's ChatGPT quota.
 */
export const MODEL_EFFORT_SETTING = "model.effort";
export const EFFORT_PREFERENCES = ["lower", "default", "higher"] as const;
export type EffortPreference = (typeof EFFORT_PREFERENCES)[number];
export const effortPreferenceOf = (raw: string | null | undefined): EffortPreference =>
  (EFFORT_PREFERENCES as readonly string[]).includes(raw ?? "") ? raw as EffortPreference : "default";
