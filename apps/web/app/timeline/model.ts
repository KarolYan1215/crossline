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
  /** The line this belongs to, when it belongs to one: a task's own line, or the line a calendar event was filed under (`calendar.lines`). */
  identityId?: string;
  milestone?: string;
  /** The work order a scheduled block stands for, so a click can open it. */
  workOrderId?: string;
  /** The step the block is for (`v<version>s<n>`), when the plan placed a step rather than the whole task. */
  stepId?: string;
  /** Its time passed without the work being done: drawn dashed as 「未完成」 until 04:00 the next morning, its work already planned again. */
  missed?: boolean;
  /** The assistant has this block's step: `planned` = 「自动交给 Agent」 will start it when the block comes up; `running` = it is at work on it. */
  agent?: "planned" | "running";
  /**
   * A work block that keeps its time while the rest is re-planned (`schedule.frozen`): started, locked, kept by a local re-plan or about
   * to start. `overlapOk`: the person accepted that it overlaps something; `lockedVia: "calendar"`: locked by dragging it on their calendar app.
   */
  frozen?: "pinned" | "locked" | "keep" | "commit";
  overlapOk?: boolean;
  lockedVia?: "calendar";
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

const WORK_KINDS: ReadonlyArray<TimelineItem["kind"]> = ["scheduled", "optional", "proposed"];
export type OverlapState = "clash" | "allowed";
/**
 * How each item that shares time with another is drawn. Overlap is allowed, conflict is not (the person's rule, 2026-10-15):
 * - `allowed`: a work block whose overlap the person accepted (「保留重叠」 on a held block) — side by side, labelled 「已允许重叠」;
 * - `clash`: work on top of anything else without that acceptance — the scheduler does not do this on its own, so one on screen is a
 *   held block a new event landed on, waiting for the person's answer.
 * Two of the person's own commitments (calendar events, class meetings, events they added) sharing time is their calendar as it is,
 * and what screen activity recorded is what happened: neither is marked. A clash wins over an allowed overlap on the same item.
 */
export function overlapStates(items: TimelineItem[]): Map<string, OverlapState> {
  const out = new Map<string, OverlapState>();
  const relevant = items.filter((item) => item.kind !== "activity" && !item.missed);
  for (let i = 0; i < relevant.length; i += 1) for (let j = i + 1; j < relevant.length; j += 1) {
    const a = relevant[i]!, b = relevant[j]!;
    if (a.day !== b.day || !overlaps(a, b)) continue;
    const work = [a, b].filter((item) => WORK_KINDS.includes(item.kind));
    if (!work.length) continue;
    const state: OverlapState = work.some((item) => item.overlapOk) ? "allowed" : "clash";
    for (const item of [a, b]) if (out.get(item.id) !== "clash") out.set(item.id, state);
  }
  return out;
}

/** The items a block shares time with on its day (activity left out), for saying what a held block overlaps. */
export const overlapping = (items: TimelineItem[], of: TimelineItem): TimelineItem[] =>
  items.filter((item) => item.id !== of.id && item.day === of.day && item.kind !== "activity" && overlaps(item, of));

type PlanBlock = { id: string; lane: "human" | "ai"; title: string; task?: string; step?: string; tag?: string; day?: string; start: string; end: string; source: string; readOnly: boolean };
export type WorkOrderMeta = { identityId: string; milestone?: string };

/** Turns the plan's blocks into timeline items. `scheduled:<workOrderId>[:n]` blocks pick up their line and milestone; a
 * `proposed:` block is where a proposal still waiting for approval would go, drawn as a preview. */
export function itemsFromPlan(blocks: PlanBlock[], today: string, meta: Record<string, WorkOrderMeta>): TimelineItem[] {
  return blocks.map((block) => {
    const proposed = block.id.startsWith("proposed:"), optional = block.id.startsWith("optional:");
    const workOrderId = block.id.startsWith("scheduled:") || proposed || optional ? block.id.split(":")[1] : undefined;
    const segment = workOrderId ? block.id.split(":")[2] : undefined;
    const stepId = segment && /^v\d+s\d+$/.test(segment) ? segment : undefined;
    const known = workOrderId ? meta[workOrderId] : undefined;
    const kind: TimelineItem["kind"] = proposed ? "proposed" : optional ? "optional" : workOrderId ? "scheduled" : block.id.startsWith("import:") ? "import" : "calendar";
    return {
      id: block.id, title: block.task ?? block.title, day: block.day ?? today, start: block.start, end: block.end, kind,
      ...(block.step ? { step: block.step } : {}), ...(block.tag ? { tag: block.tag } : {}),
      ...(known ? { identityId: known.identityId } : {}), ...(known?.milestone ? { milestone: known.milestone } : {}),
      ...(workOrderId ? { workOrderId } : {}), ...(stepId ? { stepId } : {}), source: block.source, readOnly: block.readOnly
    };
  });
}

/**
 * Marks the blocks whose step the assistant has: `running` for a step it is at work on (`<order>#<step>`, or the whole order when
 * the block is for the whole task), `planned` for a step 「自动交给 Agent」 will start by itself. Only scheduled and pencilled blocks.
 */
export function withAgentMarks(items: TimelineItem[], marks: { running: Set<string>; planned: Set<string> }): TimelineItem[] {
  return items.map((item) => {
    if (!item.workOrderId || (item.kind !== "scheduled" && item.kind !== "optional")) return item;
    const key = item.stepId ? `${item.workOrderId}#${item.stepId}` : item.workOrderId;
    const agent = marks.running.has(key) || marks.running.has(item.workOrderId) ? "running" as const : marks.planned.has(key) ? "planned" as const : undefined;
    return agent ? { ...item, agent } : item;
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

/** The least height, in pixels, a day-view block needs to carry one line of text. Anything shorter is drawn as a bare colour bar. */
export const MIN_TEXT_PX = 18;

type Slot = { column: number; columns: number };
/**
 * One piece of the vertical day view, in pixels from the top of the drawn range:
 * - `block`: tall enough for its text, drawn at its true time and height; `textTop` pushes the text below a `more` label sitting on
 *   its top edge (0 almost always);
 * - `bar`: too short for a line of text, a colour bar at its true time with no text (its title is in the tooltip and the list);
 * - `more`: the 「+N 项」 label over a run of bars close together, opening the list of what they are.
 */
export type DayPiece<T> =
  | ({ kind: "block"; item: T; top: number; height: number; textTop: number } & Slot)
  | ({ kind: "bar"; item: T; top: number; height: number } & Slot)
  | ({ kind: "more"; items: T[]; top: number; height: number } & Slot);

const sideBySide = (a: Slot, b: Slot) => a.column / a.columns < (b.column + 1) / b.columns && b.column / b.columns < (a.column + 1) / a.columns;

/**
 * Lays out the vertical day so that no two pieces of text ever overlap (the real account's 11:35–11:47 and 11:47–11:55 blocks were
 * both stretched to a minimum height and wrote over each other). Blocks that share time sit side by side (`packColumns`). A block
 * shorter than `MIN_TEXT_PX` carries no text: it is a bar, and bars sharing width less than a line apart are one run, labelled
 * 「+N 项」 once it holds two or more. A label is one line tall at the run's top; a block starting under it has its text moved down
 * below it, and one left with less than a line of its own joins the run.
 */
export function layoutDay<T extends { id: string; start: string; end: string }>(items: T[], from: number, pxPerHour: number): Array<DayPiece<T>> {
  const px = (minutes: number) => (minutes / 60) * pxPerHour;
  const placed = packColumns(items).map(({ item, column, columns }) => {
    const start = toMinutes(item.start), end = Math.max(toMinutes(item.end), start + 1);
    return { item, column, columns, top: px(start - from), height: px(end - start) };
  });
  type Placed = (typeof placed)[number];
  type Run = Slot & { members: Placed[]; top: number; bottom: number };
  const runs: Run[] = [];
  const join = (entry: Placed) => {
    const run = runs.find((candidate) => sideBySide(candidate, entry)
      && entry.top - candidate.bottom < MIN_TEXT_PX && candidate.top - (entry.top + entry.height) < MIN_TEXT_PX);
    if (run) { run.members.push(entry); run.top = Math.min(run.top, entry.top); run.bottom = Math.max(run.bottom, entry.top + entry.height); }
    else runs.push({ column: entry.column, columns: entry.columns, members: [entry], top: entry.top, bottom: entry.top + entry.height });
  };
  const tall = new Map<string, Placed & { textTop: number }>();
  for (const entry of placed) {
    if (entry.height < MIN_TEXT_PX) join(entry);
    else tall.set(entry.item.id, { ...entry, textTop: 0 });
  }
  // A label covers [run.top, run.top + MIN_TEXT_PX) in its column. A block whose text would start under it is pushed down, or, with
  // less than a line left, becomes one more bar of the run — which can lengthen the run, so repeat until nothing moves.
  for (let changed = true; changed;) {
    changed = false;
    for (const run of runs) {
      if (run.members.length < 2) continue;
      const labelEnd = run.top + MIN_TEXT_PX;
      for (const block of [...tall.values()]) {
        if (!sideBySide(run, block) || block.top < run.top || block.top >= labelEnd) continue;
        const textTop = labelEnd - block.top;
        if (block.height - textTop >= MIN_TEXT_PX) { if (block.textTop !== textTop) { block.textTop = textTop; changed = true; } continue; }
        tall.delete(block.item.id);
        run.members.push(block); run.bottom = Math.max(run.bottom, block.top + block.height);
        changed = true;
      }
    }
    // Two runs sharing width that a demotion brought within a line of each other become one, so two labels never meet.
    for (let i = 0; i < runs.length; i += 1) for (let j = runs.length - 1; j > i; j -= 1) {
      const a = runs[i]!, b = runs[j]!;
      if (!sideBySide(a, b) || b.top - a.bottom >= MIN_TEXT_PX || a.top - b.bottom >= MIN_TEXT_PX) continue;
      a.members.push(...b.members); a.top = Math.min(a.top, b.top); a.bottom = Math.max(a.bottom, b.bottom);
      runs.splice(j, 1); changed = true;
    }
  }
  const pieces: Array<DayPiece<T>> = [];
  for (const entry of placed) {
    const block = tall.get(entry.item.id);
    if (block) pieces.push({ kind: "block", item: block.item, column: block.column, columns: block.columns, top: block.top, height: block.height, textTop: block.textTop });
    else pieces.push({ kind: "bar", item: entry.item, column: entry.column, columns: entry.columns, top: entry.top, height: entry.height });
  }
  for (const run of runs) {
    if (run.members.length < 2) continue;
    const members = [...run.members].sort((a, b) => a.top - b.top);
    pieces.push({ kind: "more", items: members.map((member) => member.item), column: run.column, columns: run.columns, top: run.top, height: MIN_TEXT_PX });
  }
  return pieces;
}
