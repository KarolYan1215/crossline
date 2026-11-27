/**
 * The system's suggested importance (0–100) for a milestone, before the person moves the slider. Since 2026-11-22 it is the milestone
 * risk reviewer's `weight` (`MilestoneReading`, Skill `crossline-milestone-review:risk`), which reads what the point score used to add
 * up — the line's place in the person's order, the cross-line relations through it, what is at stake (a graded course, the deadline),
 * how the person moved this line's sliders before — and says why in one line. Before a review, the neutral middle.
 */
export type ImportancePreset = { weight: number; why: string; by: "model" | "none" };
export const NEUTRAL_WEIGHT = 50;

export function presetFromReading(reading: { weight: number; weightWhy: string } | undefined): ImportancePreset {
  return reading ? { weight: reading.weight, why: reading.weightWhy, by: "model" } : { weight: NEUTRAL_WEIGHT, why: "", by: "none" };
}

// rule: importance.hours-from-text
/** A stated weekly figure such as 「每周约 12 小时」 or 「10–20 小时」 as hours (the upper end of a range); course numbers are ignored. */
export function hoursFromText(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:[–\-~至到]\s*(\d+(?:\.\d+)?))?\s*(?:个)?\s*(?:小时|hours?\b|h\b)/i.exec(text);
  if (!match) return null;
  return Number(match[2] ?? match[1]);
}
