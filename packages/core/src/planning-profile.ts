/**
 * The interview's conclusions in the few lines every planning Skill needs (docs/review-2026-10-20.md §4): how the person works, what
 * drains and what carries them, where the lines stand against each other, and the direction the plan serves. Before this the milestone
 * architect, the backplanner and the capture analysis saw none of it, and the step planner saw person facts only while fewer than fifty
 * facts of the task's own line came first — on the owner's research line (101 facts) none of them ever reached a plan.
 *
 * Pure: the caller passes the confirmed facts and the stored profile. Appearance, the portrait confirmation and meal times are left out
 * (the figure and the availability pattern use those); every line is short and plain, at most `MAX_LINES`.
 */
export type ProfileFactLike = { identityId: string; slot: string; value: string; status: string };
export type ProfileModelLike = {
  trueNorth?: string; coreConflict?: string; allocation?: string; does?: string; realWant?: string;
  energyMap?: Array<{ activity: string; skill?: string; love?: string; charge?: string }>;
  values?: Array<{ value: string; score: number }>;
};

export const PLANNING_PROFILE_MAX_LINES = 14;
const LINE_MAX = 160;
/** Person facts about how they work, in the order a planner reads them. */
const WORK_SLOTS = ["peak_work_time", "work_window", "energy_drain", "behavior_pattern", "flow", "line_constraint", "work_style",
  "focus", "rhythm", "sleep", "recovery", "collaboration"];
const LEFT_OUT = /^(appearance|gender|hair|clothing|portrait|lunch|dinner|meal|age|name|appearance_skipped)/;

const clip = (text: string) => (text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text).replace(/\s+/g, " ").trim();

export function planningProfile(facts: ProfileFactLike[], model: ProfileModelLike | undefined): string[] {
  const lines: string[] = [];
  const person = facts.filter((fact) => fact.identityId === "person" && fact.status === "confirmed" && !LEFT_OUT.test(fact.slot));
  const rank = (slot: string) => { const index = WORK_SLOTS.findIndex((prefix) => slot.startsWith(prefix)); return index < 0 ? WORK_SLOTS.length : index; };
  for (const fact of [...person].sort((a, b) => rank(a.slot) - rank(b.slot)).filter((fact) => rank(fact.slot) < WORK_SLOTS.length))
    lines.push(clip(`工作方式（${fact.slot}）：${fact.value}`));
  const map = model?.energyMap ?? [];
  const carries = map.filter((item) => item.skill === "high" && item.love === "high").map((item) => item.activity).slice(0, 4);
  const drains = map.filter((item) => item.charge === "drain" || item.love === "low").map((item) => item.activity).slice(0, 4);
  if (carries.length) lines.push(clip(`擅长又投入：${carries.join("；")}`));
  if (drains.length) lines.push(clip(`耗能：${drains.join("；")}`));
  if (model?.does) lines.push(clip(`实际做法：${model.does}`));
  if (model?.allocation) lines.push(clip(`主线分配：${model.allocation}`));
  if (model?.coreConflict) lines.push(clip(`核心矛盾：${model.coreConflict}`));
  const values = [...(model?.values ?? [])].sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.value);
  if (values.length) lines.push(clip(`最看重：${values.join("、")}`));
  if (model?.trueNorth) lines.push(clip(`方向：${model.trueNorth}`));
  return lines.slice(0, PLANNING_PROFILE_MAX_LINES);
}
