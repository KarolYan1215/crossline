/**
 * One freeze model for the schedule (docs/loop-and-scout.md §1–§2). A frozen block keeps its time while everything else is
 * re-planned around it, for one of four reasons:
 *
 * - `pinned`: the person started it there;
 * - `locked`: the person locked it (the button, or by dragging it on their calendar app);
 * - `keep`:   the week's work an inserted event did not touch, kept for a while so only what it landed on moves (local re-plan);
 * - `commit`: running now or starting within the commit window, so the calendar and its reminders stop sliding.
 *
 * It replaces `schedule.pins` and `schedule.keep`. The planner freezes the one block (a task's other segments are still planned);
 * a frozen block that a hard constraint lands on is moved only for `keep`/`commit`, and asked about for `pinned`/`locked`.
 */
export const FROZEN_SETTING = "schedule.frozen";

export type FrozenBlock = {
  blockId: string;
  /** Instants (ISO). */
  start: string;
  end: string;
  reason: "pinned" | "locked" | "keep" | "commit";
  /** When the freeze lapses on its own (`keep`). */
  until?: string;
  /** The person accepted that it overlaps a hard constraint (「保留重叠」 / 「钉回原位」). */
  overlapOk?: boolean;
};

const REASONS = new Set(["pinned", "locked", "keep", "commit"]);

/** The stored list without what has ended or lapsed; anything unreadable reads as nothing frozen. */
export function parseFrozen(raw: string | undefined | null, now: Date): FrozenBlock[] {
  let value: unknown;
  try { value = JSON.parse(raw ?? "[]"); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const at = now.getTime();
  return value.filter((item): item is FrozenBlock => Boolean(item) && typeof item === "object"
    && typeof (item as FrozenBlock).blockId === "string" && typeof (item as FrozenBlock).start === "string"
    && typeof (item as FrozenBlock).end === "string" && REASONS.has((item as FrozenBlock).reason))
    .filter((item) => Date.parse(item.end) > at && (!item.until || Date.parse(item.until) > at));
}

/** Adds or replaces the entry for its block id. */
export const withFrozen = (list: FrozenBlock[], entry: FrozenBlock): FrozenBlock[] =>
  [...list.filter((item) => item.blockId !== entry.blockId), entry];

export const withoutFrozen = (list: FrozenBlock[], blockId: string): FrozenBlock[] =>
  list.filter((item) => item.blockId !== blockId);

/** `schedule.shift` (「后面都推 10 分钟」): the stretch from now until this instant is busy, so nothing new is placed in it. */
export const DELAY_SETTING = "schedule.delayUntil";
export const SHIFT_MINUTES = { min: 5, max: 120 } as const;

/**
 * 「后面都推 10 分钟」 (docs/energy-and-ecosystem.md §6): today's `commit` and `keep` blocks move later by `minutes`. One under way starts
 * `minutes` from now and its end moves by the same amount (the time already passed is not given back), so no shifted block overlaps the
 * next. `pinned` and `locked` stay where the person put them; blocks of later days are left alone. `dayEnd` is the end of the person's today.
 */
export function shiftFrozen(list: FrozenBlock[], minutes: number, now: Date, dayEnd: Date): FrozenBlock[] {
  const by = minutes * 60_000, at = now.getTime();
  return list.map((item) => {
    if ((item.reason !== "commit" && item.reason !== "keep") || Date.parse(item.end) <= at || Date.parse(item.start) >= dayEnd.getTime()) return item;
    const start = new Date(Math.max(Date.parse(item.start), at) + by).toISOString();
    const end = new Date(Date.parse(item.end) + by).toISOString();
    return { ...item, start, end, ...(item.reason === "commit" ? { until: end } : {}) };
  });
}
