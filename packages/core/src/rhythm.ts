import { PRODUCTIVE, type ActivityCategory } from "./activity-state";

/**
 * How this person actually works, read from what they actually did — not from what a model guesses a task takes.
 *
 * Every number here is a measurement and every one can be absent (0 means "not enough to say"; nothing is ever filled in with a
 * default that looks like data):
 *  - `focusRunMinutes`: the median stretch they stay on work-like apps before drifting, from the screen record. Estimates are
 *    sized in sessions of this length, so 「6 小时」 reads as what it is — about four sittings — instead of one unbroken block.
 *  - `productiveMinutesPerDay`: how much of a day is work-like, so a task's focused minutes can be turned into days.
 *  - `planActualRatio` / `completed`: how long finished tasks really took against what was estimated for them. A person who
 *    finishes in 60% of the estimate every time should not keep being shown the estimate.
 */
export type WorkRhythm = {
  focusRunMinutes: number;
  productiveMinutesPerDay: number;
  planActualRatio: number;
  observedDays: number;
  completed: number;
};

export const NO_RHYTHM: WorkRhythm = { focusRunMinutes: 0, productiveMinutesPerDay: 0, planActualRatio: 0, observedDays: 0, completed: 0 };

/** A task's estimate is corrected by the person's own ratio only once there are this many finished tasks behind it. */
export const MIN_COMPLETED_FOR_RATIO = 3;
/** Never trust a ratio further than this either way: three unusual afternoons must not halve or double everything. */
export const RATIO_FLOOR = 0.4;
export const RATIO_CEILING = 2;
/** Two stretches of work-like activity closer than this are one stretch (a glance at a phone is not leaving). */
const RUN_GAP_MINUTES = 3;
const MIN_RUN_MINUTES = 5;
const MIN_DAYS_FOR_DAILY_FIGURE = 3;

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function summarizeRhythm(input: {
  segments: Array<{ start: string; end: string; category: string; idle: boolean }>;
  finished: Array<{ actualMinutes: number; estimatedMinutes: number }>;
}): WorkRhythm {
  const work = input.segments
    .filter((segment) => !segment.idle && PRODUCTIVE.has(segment.category as ActivityCategory))
    .map((segment) => ({ from: Date.parse(segment.start), to: Date.parse(segment.end) }))
    .filter((segment) => segment.to > segment.from)
    .sort((a, b) => a.from - b.from);

  const runs: number[] = [];
  let current: { from: number; to: number } | undefined;
  for (const segment of work) {
    if (current && segment.from - current.to <= RUN_GAP_MINUTES * 60_000) current.to = Math.max(current.to, segment.to);
    else { if (current) runs.push((current.to - current.from) / 60_000); current = { ...segment }; }
  }
  if (current) runs.push((current.to - current.from) / 60_000);
  const focusRuns = runs.filter((minutes) => minutes >= MIN_RUN_MINUTES);

  const perDay = new Map<string, number>();
  for (const segment of work) {
    const day = new Date(segment.from).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + (segment.to - segment.from) / 60_000);
  }
  const ratios = input.finished.filter((entry) => entry.actualMinutes > 0 && entry.estimatedMinutes > 0).map((entry) => entry.actualMinutes / entry.estimatedMinutes);

  return {
    focusRunMinutes: Math.round(median(focusRuns)),
    productiveMinutesPerDay: perDay.size >= MIN_DAYS_FOR_DAILY_FIGURE ? Math.round([...perDay.values()].reduce((sum, value) => sum + value, 0) / perDay.size) : 0,
    planActualRatio: ratios.length >= MIN_COMPLETED_FOR_RATIO ? Math.round(Math.min(RATIO_CEILING, Math.max(RATIO_FLOOR, median(ratios))) * 100) / 100 : 0,
    observedDays: perDay.size,
    completed: ratios.length
  };
}
