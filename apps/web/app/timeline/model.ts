/**
 * What the day, week and month views are made of, as plain data and pure functions.
 *
 * All three views read the same list of items — real calendar events, file-imported class meetings, and the
 * blocks the scheduler placed for work orders — so a block cannot show in one view and be missing from another.
 * Nothing here knows about React or the clock: the views pass in "today" and the zone's current minute.
 */
export type TimelineItem = {
  id: string; title: string;
  /** `YYYY-MM-DD` in the person's time zone. */
  day: string;
  /** `HH:MM`, 24 hour. */
  start: string; end: string;
  /** `optional`: pencilled in outside the person's hours (dashed, not planned until started). */
  kind: "calendar" | "scheduled" | "proposed" | "optional" | "import" | "activity";
  /** A scheduled block's task and step, drawn as title and subtitle; `tag` is its standing (暂定, 预排…). */
  task?: string;
  step?: string;
  tag?: string;
  /** The line this belongs to, when it belongs to one. Calendar events from outside do not. */
  identityId?: string;
  milestone?: string;
  /** The work order a scheduled block stands for, so a click can open it. */
  workOrderId?: string;
  source: string;
  readOnly: boolean;
};

/** A date something is due by, shown as a flag on the day rather than a block of time. */
export type TimelineDeadline = { id: string; day: string; title: string; identityId?: string; detail?: string };

export const MINUTES_PER_DAY = 1440;

export const toMinutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
export const toClock = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60) % 24).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
};

const DAY = 86_400_000;
const parseDay = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const formatDay = (time: number) => new Date(time).toISOString().slice(0, 10);
export const shiftDay = (day: string, days: number): string => formatDay(parseDay(day) + days * DAY);
/** 0 is Sunday. */
export const weekdayOf = (day: string): number => new Date(parseDay(day)).getUTCDay();
/** The Monday on or before `day`: weeks here start on Monday. */
export const weekStart = (day: string): string => shiftDay(day, -((weekdayOf(day) + 6) % 7));
export const weekDays = (day: string): string[] => Array.from({ length: 7 }, (_, index) => shiftDay(weekStart(day), index));

export const monthOf = (day: string): string => day.slice(0, 7);
export const shiftMonth = (day: string, months: number): string => {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 1 + months;
  return formatDay(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
};

/** Six rows of seven days starting on the Monday on or before the 1st, always six so the grid does not jump. */
export function monthGrid(day: string): Array<Array<{ day: string; inMonth: boolean }>> {
  const first = `${monthOf(day)}-01`;
  const start = weekStart(first);
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, index) => {
    const cell = shiftDay(start, week * 7 + index);
    return { day: cell, inMonth: monthOf(cell) === monthOf(day) };
  }));
}

export const itemsOn = <T extends { day: string; start?: string }>(items: T[], day: string): T[] =>
  items.filter((item) => item.day === day).sort((a, b) => toMinutes(a.start ?? "00:00") - toMinutes(b.start ?? "00:00"));

/** A time-ordered list with a column assigned to every item, so blocks that overlap sit side by side. */
export function packColumns<T extends { start: string; end: string }>(items: T[]): Array<{ item: T; column: number; columns: number }> {
  const sorted = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(b.end) - toMinutes(a.end));
  const out: Array<{ item: T; column: number; columns: number; group: number }> = [];
  let group = 0, groupEnd = -1;
  const columnEnds: number[] = [];
  for (const item of sorted) {
    const start = toMinutes(item.start), end = Math.max(toMinutes(item.end), start + 1);
    if (start >= groupEnd) { group += 1; groupEnd = -1; columnEnds.length = 0; }
    let column = columnEnds.findIndex((until) => until <= start);
    if (column === -1) { column = columnEnds.length; columnEnds.push(end); } else columnEnds[column] = end;
    groupEnd = Math.max(groupEnd, end);
    out.push({ item, column, columns: 0, group });
  }
  // A group is as wide as its widest moment; every item in it shares that width.
  const widest = new Map<number, number>();
  for (const entry of out) widest.set(entry.group, Math.max(widest.get(entry.group) ?? 0, entry.column + 1));
  return out.map(({ item, column, group: g }) => ({ item, column, columns: widest.get(g) ?? 1 }));
}

/** The current minute of the day in a time zone. */
export function minuteInZone(nowIso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowIso));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

/** Two blocks that share time, for flagging a conflict. Back-to-back is not an overlap. */
export function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}
export function conflictingIds(items: Array<{ id: string; start: string; end: string }>): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
    if (overlaps(items[i]!, items[j]!)) { out.add(items[i]!.id); out.add(items[j]!.id); }
  }
  return out;
}

type PlanBlock = { id: string; lane: "human" | "ai"; title: string; task?: string; step?: string; tag?: string; day?: string; start: string; end: string; source: string; readOnly: boolean };
export type WorkOrderMeta = { identityId: string; milestone?: string };

/** Turns the plan's blocks into timeline items. `scheduled:<workOrderId>[:n]` blocks pick up their line and milestone; a
 * `proposed:` block is where a proposal still waiting for approval would go, drawn as a preview. */
export function itemsFromPlan(blocks: PlanBlock[], today: string, meta: Record<string, WorkOrderMeta>): TimelineItem[] {
  return blocks.map((block) => {
    const proposed = block.id.startsWith("proposed:"), optional = block.id.startsWith("optional:");
    const workOrderId = block.id.startsWith("scheduled:") || proposed || optional ? block.id.split(":")[1] : undefined;
    const known = workOrderId ? meta[workOrderId] : undefined;
    const kind: TimelineItem["kind"] = proposed ? "proposed" : optional ? "optional" : workOrderId ? "scheduled" : block.id.startsWith("import:") ? "import" : "calendar";
    return {
      id: block.id, title: block.task ?? block.title, day: block.day ?? today, start: block.start, end: block.end, kind,
      ...(block.step ? { step: block.step } : {}), ...(block.tag ? { tag: block.tag } : {}),
      ...(known ? { identityId: known.identityId } : {}), ...(known?.milestone ? { milestone: known.milestone } : {}),
      ...(workOrderId ? { workOrderId } : {}), source: block.source, readOnly: block.readOnly
    };
  });
}

/**
 * The hours a vertical day draws: from the earlier of 07:00 and the first thing, to the later of 22:00 and the last, on whole hours. A
 * day is read top to bottom; drawing midnight to midnight wasted most of the height on sleep.
 */
export function dayRange(items: Array<{ start: string; end: string }>): { from: number; to: number } {
  const starts = items.map((item) => toMinutes(item.start)), ends = items.map((item) => Math.max(toMinutes(item.end), toMinutes(item.start) + 1));
  const from = Math.floor(Math.min(7 * 60, ...starts) / 60) * 60;
  const to = Math.ceil(Math.max(22 * 60, ...ends) / 60) * 60;
  return { from, to: Math.min(MINUTES_PER_DAY, to) };
}
