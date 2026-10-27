/**
 * How often the plan moves under the person (the 2026-10-18 evaluation): a plan that keeps re-shuffling gives none of the closure a made
 * plan is for (Masicampo & Baumeister 2011 found the relief only where the plan was carried out), so the system has to know how much it
 * moves. The schedule is derived on every read, so the web's ten-minute timer keeps a snapshot of where each piece of work starts in the
 * next seven days and compares the next reading with it.
 */

/** Where each piece of work (`order` or `order#step`) first starts, as an instant, within `[at, until)`. */
export type PlanSnapshot = { at: string; until: string; starts: Record<string, string> };
/** One day's changes, each piece of work counted once however often it moved. */
export type PlanChurnDay = { moved: string[]; dropped: string[]; readings: number };

export const PLAN_SNAPSHOT_SETTING = "metrics.planSnapshot";
export const planChurnKey = (day: string) => `metrics.planChurn:${day}`;
/** A start that moved less than this is the same block (the solver's rounding, a rest shifted). */
export const PLAN_MOVE_MINUTES = 15;

/**
 * What changed between two readings, counting only work the earlier reading placed still ahead of the later one: `moved` starts at least
 * `PLAN_MOVE_MINUTES` elsewhere, `dropped` no longer has a time in the window although it is still to be done (`alive`; finished or
 * discarded work leaving the plan is not a change). Work newly placed is not counted: that is new work, not the plan moving.
 */
export function planChanges(previous: PlanSnapshot | undefined, next: PlanSnapshot, alive: (key: string) => boolean): { moved: string[]; dropped: string[] } {
  if (!previous) return { moved: [], dropped: [] };
  const moved: string[] = [];
  const dropped: string[] = [];
  for (const [key, start] of Object.entries(previous.starts)) {
    if (start <= next.at) continue;
    const now = next.starts[key];
    if (now) { if (Math.abs(Date.parse(now) - Date.parse(start)) >= PLAN_MOVE_MINUTES * 60_000) moved.push(key); }
    else if (start < next.until && alive(key)) dropped.push(key);
  }
  return { moved, dropped };
}

/** Adds one reading's changes to the day's record. */
export function addChurn(day: PlanChurnDay | undefined, changes: { moved: string[]; dropped: string[] }): PlanChurnDay {
  const base = day ?? { moved: [], dropped: [], readings: 0 };
  return { moved: [...new Set([...base.moved, ...changes.moved])], dropped: [...new Set([...base.dropped, ...changes.dropped])], readings: base.readings + 1 };
}

/** The average number of pieces of work moved or dropped per recorded day, or null with no day recorded. */
export function churnPerDay(days: PlanChurnDay[]): number | null {
  if (!days.length) return null;
  return Math.round((days.reduce((sum, day) => sum + new Set([...day.moved, ...day.dropped]).size, 0) / days.length) * 10) / 10;
}
