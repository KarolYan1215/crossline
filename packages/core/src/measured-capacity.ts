/**
 * Measured work time and the capacity planned from it (docs/plans/closed-loop-1030.md §1–§3, the owner's decisions of 2026-10-30).
 *
 * The month simulation showed a plan built on the stated 72 hours a week against a person who did 10–25: the plan was 17–39% kept and the
 * weekly commitment never once found the week overloaded. Capacity is now what the person actually worked, read from four signals:
 *
 * 1. timed sessions and confirmed blocks (the person's own word, the most reliable);
 * 2. screen activity in the work categories (`PRODUCTIVE`: coding, research tools, writing, reading) — by category only, never a title;
 * 3. Codex and Claude Code sessions (time only, `AgentHistorySummary.spans`);
 * 4. file changes in authorized folders — evidence and a time mark only, never minutes of their own.
 *
 * The four are joined in time (a minute counts once). A day with no signal at all is missing, not zero. Capacity is the median of the
 * last 28 days of the same kind (weekday or weekend) times 1.25, at least 60 minutes. Everything here is pure; `apps/web/lib/measured-
 * capacity.ts` gathers the signals.
 */

/** A stretch of time in epoch milliseconds. */
export type Span = { start: number; end: number };
export type MeasuredSource = "timer" | "screen" | "agent";
export type MeasuredSignals = {
  timer: Span[]; screen: Span[]; agent: Span[];
  /**
   * 「电脑前的一天」: active minutes per clock hour, no category. Used only on a day without any categorized screen segment (a computer
   * whose detail consent is off), placed at the start of its hour — the position inside the hour is not known.
   */
  hourly?: Array<{ start: string; active: number }>;
  /** Local days with any screen segment at all (work or not): on those the categorized segments say everything, `hourly` is not used. */
  segmentDays?: string[];
  /** Local days on which the person answered for a block (done, partial or not done): a signal even at zero minutes. */
  confirmedDays?: string[];
  /** Times (ms) a file of the person's changed in an authorized folder: counted per day as evidence, never as minutes. */
  fileChanges?: number[];
};
export type MeasuredDay = {
  day: string;
  /** Minutes of work that day, every signal joined in time. */
  minutes: number;
  /** No signal at all: left out of the median. */
  missing: boolean;
  bySource: Record<MeasuredSource, number>;
  fileChanges: number;
};

/** Capacity is the usual day's measured work times this, so a good day still fits. */
export const CAPACITY_FACTOR = 1.25;
export const MIN_DAY_MINUTES = 60;
export const CAPACITY_LOOKBACK_DAYS = 28;
/** Days of the same kind with a signal before the median alone is trusted, without screen activity behind it. */
export const COLD_START_DAYS = 5;
/** With no measurement yet, the stated hours are planned at half. */
export const COLD_START_FACTOR = 0.5;

const MINUTE = 60_000;

/** Sorted, non-overlapping spans. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/** Minutes of `spans` (merged) inside [from, to). */
export function minutesWithin(spans: Span[], from: number, to: number): number {
  let total = 0;
  for (const span of spans) total += Math.max(0, Math.min(span.end, to) - Math.max(span.start, from));
  return total / MINUTE;
}

/**
 * The measured work of each local day. `dayStarts` are the local midnights in order, one more than the days (the end of the last one),
 * so the zone's arithmetic stays with the caller.
 */
export function measuredWorkDays(signals: MeasuredSignals, dayStarts: Array<{ day: string; start: number }>): MeasuredDay[] {
  const days = dayStarts.slice(0, -1);
  const bounds = (index: number) => ({ from: dayStarts[index]!.start, to: dayStarts[index + 1]!.start });
  const timer = mergeSpans(signals.timer), agent = mergeSpans(signals.agent), screen = mergeSpans(signals.screen);
  const hourly = (signals.hourly ?? []).filter((hour) => hour.active > 0)
    .map((hour) => { const start = Date.parse(hour.start); return { start, end: start + Math.min(60, hour.active) * MINUTE }; });
  const confirmed = new Set(signals.confirmedDays ?? []);
  const segmented = new Set(signals.segmentDays ?? []);
  return days.map((entry, index) => {
    const { from, to } = bounds(index);
    const screenToday = segmented.has(entry.day) || minutesWithin(screen, from, to) > 0 ? screen : mergeSpans(hourly);
    const all = mergeSpans([...timer, ...screenToday, ...agent]);
    const bySource = { timer: minutesWithin(timer, from, to), screen: minutesWithin(screenToday, from, to), agent: minutesWithin(agent, from, to) };
    const minutes = minutesWithin(all, from, to);
    const files = (signals.fileChanges ?? []).filter((at) => at >= from && at < to).length;
    const anySignal = minutes > 0 || confirmed.has(entry.day);
    return { day: entry.day, minutes: Math.round(minutes), missing: !anySignal,
      bySource: { timer: Math.round(bySource.timer), screen: Math.round(bySource.screen), agent: Math.round(bySource.agent) }, fileChanges: files };
  });
}

export type DayKind = "weekday" | "weekend";
export const dayKindOf = (day: string): DayKind => { const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); return weekday === 0 || weekday === 6 ? "weekend" : "weekday"; };

/**
 * How a kind of day is planned: `measured` (five or more days with a signal), `screen` (fewer, but the computer's screen activity is
 * there, so it is used from the first day), or `stated` (nothing yet: the stated hours at half).
 */
export type PlanCapacityBasis = "measured" | "screen" | "stated";
export type KindCapacity = { basis: PlanCapacityBasis; samples: number; median: number; minutes?: number };
export type MeasuredCapacity = Record<DayKind, KindCapacity>;

export function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Capacity per kind of day from measured days (today should be left out by the caller: it is not over). */
export function measuredCapacity(days: MeasuredDay[], options: { hasScreen: boolean }): MeasuredCapacity {
  const of = (kind: DayKind): KindCapacity => {
    const samples = days.filter((day) => !day.missing && dayKindOf(day.day) === kind).map((day) => day.minutes);
    const value = medianOf(samples);
    if (samples.length >= COLD_START_DAYS || (options.hasScreen && samples.length > 0))
      return { basis: samples.length >= COLD_START_DAYS ? "measured" : "screen", samples: samples.length, median: Math.round(value),
        minutes: Math.max(MIN_DAY_MINUTES, Math.round(value * CAPACITY_FACTOR)) };
    return { basis: "stated", samples: samples.length, median: Math.round(value) };
  };
  return { weekday: of("weekday"), weekend: of("weekend") };
}

/** The minutes of work a day may hold: the measured cap of its kind, or half of what the person said that day holds. */
export function dayCapacityMinutes(capacity: MeasuredCapacity, day: string, statedMinutes: number): number {
  const kind = capacity[dayKindOf(day)];
  if (kind.minutes !== undefined) return kind.minutes;
  return Math.max(Math.min(MIN_DAY_MINUTES, statedMinutes), Math.round(statedMinutes * COLD_START_FACTOR));
}

/* ── one block: done, partly done, or probably not done ── */

/** Work minutes at or over this share of a block mean it was done; under the lower share, probably not. */
export const INFER_DONE_SHARE = 0.6;
export const INFER_NONE_SHARE = 0.2;
export type InferredOutcome = "done" | "partial" | "not_done";

/** What the passive signals say about a block, from the work minutes inside it. */
export function inferBlockOutcome(workMinutes: number, blockMinutes: number): InferredOutcome {
  if (blockMinutes <= 0) return "not_done";
  const share = workMinutes / blockMinutes;
  return share >= INFER_DONE_SHARE ? "done" : share < INFER_NONE_SHARE ? "not_done" : "partial";
}

/** 「按预估完成」 in one tap: a block timed or seen worked for under this share of its planned minutes is recorded as partly done. */
export const AS_PLANNED_MIN_SHARE = 0.7;
export const asPlannedOutcome = (workMinutes: number, blockMinutes: number): "done" | "partial" =>
  blockMinutes > 0 && workMinutes < blockMinutes * AS_PLANNED_MIN_SHARE ? "partial" : "done";

/* ── what the pages say ── */

/** The typical measured week in hours: the mean measured day over days with a signal, seven times; undefined with none. */
export function measuredWeeklyHours(days: MeasuredDay[]): number | undefined {
  const present = days.filter((day) => !day.missing);
  if (!present.length) return undefined;
  return Math.round(present.reduce((sum, day) => sum + day.minutes, 0) / present.length * 7 / 6) / 10;
}

/** The basis a page names: measured when either kind of day is planned from measurements. */
export const planBasisOf = (capacity: MeasuredCapacity): PlanCapacityBasis =>
  capacity.weekday.basis !== "stated" ? capacity.weekday.basis : capacity.weekend.basis !== "stated" ? capacity.weekend.basis : "stated";

/**
 * Written by the web's attention timer for the worker (`date-advance` works a self-set deadline forward at the measured pace): the
 * minutes each kind of day may hold. `{ at, weekday, weekend, basis }`.
 */
export const MEASURED_CAPACITY_SETTING = "capacity.measured";
export type MeasuredCapacityRecord = { at: string; weekday: number; weekend: number; basis: PlanCapacityBasis };
