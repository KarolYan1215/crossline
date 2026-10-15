import { mctqLite, CHRONOTYPE_LABEL } from "./assess";
import { alertnessAt, phaseShiftFromPeak, type SleepEpisode } from "./energy-model";
import type { EnergyLevel } from "./index";

/**
 * The weekly energy advice for the plan page (decided 2026-10-15): which of the person's available half hours should be marked high,
 * medium or low energy, worked out by rules from what is on record — the three-process model run on the person's usual sleep, with the
 * circadian phase taken from their sleep timing (MCTQ's MSF_sc when there are workday and free-day nights, else the median mid-sleep)
 * rather than from the hours they painted, so the advice never just echoes the current pattern; their own L/M/H reports override the
 * model wherever two or more agree on a two-hour band; and the timed record of the last eight weeks is set beside it, flagged where it
 * contradicts a low reading. A weekly Skill run then reviews it against published research (`ENERGY_ADVICE_REVIEW_SCHEMA`), and may move
 * a band by one level at most, citing pages the worker opened. The advice is a suggestion: it is stored apart from the person's pattern
 * and only ever applied through the plan page's preview.
 *
 * Grids here are the plan page's: seven rows (0 = Sunday), 48 half hours, 0 none, 1 low, 2 medium, 3 high.
 */

export const ENERGY_ADVICE_SETTING = "energy.advice";
/** The id of the advice the person set aside (「忽略」); a new week's different advice is shown again. */
export const ENERGY_ADVICE_DISMISSED = "energy.advice.dismissed";
export const ENERGY_ADVICE_PERIOD_DAYS = 7;
/** Below this the rule says what is missing instead of advising from the generic curve alone. */
export const ADVICE_MIN_NIGHTS = 3;
export const ADVICE_MIN_REPORTS = 2;

const SLOTS = 48;
const HOUR = 3_600_000;
const DEFAULT_NIGHT = { from: 23.5, to: 7.5 };
/** The mid-sleep the model's published acrophase (16.8 h) corresponds to: the default night's. */
const DEFAULT_MID_SLEEP = 3.5;
const LEVEL_OF: Record<EnergyLevel, number> = { low: 1, medium: 2, high: 3 };
const LEVEL_LABEL: Record<number, string> = { 1: "低", 2: "中", 3: "高" };

export type AdviceGrid = number[][];

/** Local clock hour (fractional) and weekday (0 = Sunday) of an instant in a zone. */
export function zoneClock(zone: string): { hour: (iso: string) => number; weekday: (iso: string) => number } {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const parts = (iso: string) => Object.fromEntries(format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return {
    hour: (iso) => { const p = parts(iso); return (Number(p.hour) % 24) + Number(p.minute) / 60; },
    weekday: (iso) => WEEKDAY[parts(iso).weekday ?? ""] ?? 0
  };
}

export type TimedSession = { startedAt: string; endedAt?: string | undefined; interruptions?: Array<{ pausedAt: string; resumedAt?: string | undefined }> };

/**
 * Minutes worked per weekday (0 = Sunday) × hour, from the timer's own start and end in the person's zone, with every pause cut out.
 * Each stretch is walked in quarter hours, which every zone's offset divides, so a minute is never filed under the wrong hour.
 */
export function workedRhythm(sessions: TimedSession[], zone: string, now: string): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const clock = zoneClock(zone);
  const QUARTER = 15 * 60_000;
  for (const session of sessions) {
    const start = Date.parse(session.startedAt), end = Date.parse(session.endedAt ?? now);
    if (!(end > start)) continue;
    const pauses = (session.interruptions ?? []).map((item) => [Date.parse(item.pausedAt), Date.parse(item.resumedAt ?? session.endedAt ?? now)] as const)
      .filter(([from, to]) => to > from);
    for (let from = start; from < end;) {
      const to = Math.min(end, (Math.floor(from / QUARTER) + 1) * QUARTER);
      const paused = pauses.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
      const minutes = (to - from - paused) / 60_000;
      if (minutes > 0) { const iso = new Date(from).toISOString(); grid[clock.weekday(iso)]![Math.floor(clock.hour(iso))]! += minutes; }
      from = to;
    }
  }
  return grid.map((row) => row.map((value) => Math.round(value)));
}

/** Self-reports with corrections folded in: a report followed by another within ten minutes was taken back by it. */
export function settledReports(reports: Array<{ at: string; level: EnergyLevel }>): Array<{ at: string; level: EnergyLevel }> {
  const sorted = [...reports].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.filter((report, index) => {
    const next = sorted[index + 1];
    return !next || Date.parse(next.at) - Date.parse(report.at) > 10 * 60_000;
  });
}

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length / 2; return s.length % 2 ? s[Math.floor(m)]! : (s[m - 1]! + s[m]!) / 2; };
const wrap24 = (hours: number) => ((hours % 24) + 24) % 24;
/** 「9:30」 from 9.5; 24 stays 24 so a band reaching midnight reads 「22:00–24:00」. */
export const clockLabel = (hours: number) => {
  const minutes = Math.round(hours * 60);
  if (minutes === 1440) return "24:00";
  const h = ((minutes % 1440) + 1440) % 1440;
  return `${Math.floor(h / 60)}:${String(h % 60).padStart(2, "0")}`;
};
const hhmm = (hours: number) => { const m = Math.round(hours * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

type Night = { onset: number; wake: number; free: boolean };
type UsualNight = { from: number; to: number };

/** Every half hour of one usual day at a usual night, on the model's scale; null while asleep. */
function usualDayCurve(night: UsualNight, phaseShift: number): Array<number | null> {
  const day0 = Date.parse("2000-01-01T00:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const episodes: SleepEpisode[] = Array.from({ length: 14 }, (_, index) => ({
    sleepAt: iso(day0 + (index * 24 + night.from) * HOUR), wakeAt: iso(day0 + ((index + 1) * 24 + night.to) * HOUR), source: "usual" }));
  const utcHour = (at: string) => { const date = new Date(at); return date.getUTCHours() + date.getUTCMinutes() / 60; };
  const today = day0 + 14 * 24 * HOUR;
  const asleep = (hour: number) => night.from >= 24 ? hour >= night.from - 24 && hour < night.to : hour >= night.from || hour < night.to;
  return Array.from({ length: SLOTS }, (_, slot) => {
    const middle = slot / 2 + 0.25;
    if (asleep(middle)) return null;
    const value = alertnessAt(iso(today + middle * HOUR), episodes, utcHour, phaseShift);
    return value === undefined ? null : value;
  });
}

/**
 * Levels from a curve, by rank within the person's own waking day: the best quarter of the waking half hours high, the worst quarter
 * (inertia after waking, the hours before sleep, the afternoon dip when it is deep enough) low, the rest medium. By rank on purpose: the
 * model's curve is flat through most of a rested day, so a cut on its value marked twelve hours high; and the absolute cut points are
 * calibrated from reports, which a person with few of them does not have.
 */
function levelsOf(curve: Array<number | null>): number[] {
  const awake = curve.flatMap((value, slot) => value === null ? [] : [{ value, slot }]).sort((a, b) => b.value - a.value || a.slot - b.slot);
  const levels = curve.map(() => 0);
  const quarter = Math.round(awake.length * QUARTER_SHARE);
  awake.forEach((item, rank) => { levels[item.slot] = rank < quarter ? 3 : rank >= awake.length - quarter ? 1 : 2; });
  return levels;
}
const QUARTER_SHARE = 0.25;
const PHASE_BASIS = { chronotype: "按时型", sleep: "按睡眠中点", stated: "按本人所述高效时段", default: "无记录，按通用曲线" } as const;

/** A run shorter than an hour takes its neighbour's level, so the advice saves as a few windows rather than a scatter of half hours. */
function smooth(levels: number[]): number[] {
  const out = [...levels];
  for (let slot = 0; slot < SLOTS;) {
    let end = slot;
    while (end < SLOTS && out[end] === out[slot]) end += 1;
    if (out[slot]! > 0 && end - slot < 2) {
      const before = slot > 0 ? out[slot - 1]! : 0, after = end < SLOTS ? out[end]! : 0;
      const take = before > 0 ? before : after;
      if (take > 0) for (let index = slot; index < end; index += 1) out[index] = take;
    }
    slot = end;
  }
  return out;
}

/** Runs of one level as 「10:00–13:00」. */
export function levelRanges(row: number[], level: number): string[] {
  const ranges: string[] = [];
  for (let slot = 0; slot < row.length;) {
    if (row[slot] !== level) { slot += 1; continue; }
    let end = slot;
    while (end < row.length && row[end] === level) end += 1;
    ranges.push(`${clockLabel(slot / 2)}–${clockLabel(end / 2)}`);
    slot = end;
  }
  return ranges;
}

export type EnergyAdviceEvidence = {
  /** Recorded nights in the last four weeks behind the usual times (0 = the generic night). */
  nights: number;
  usual: { workdays: UsualNight; free: UsualNight | null };
  /** MCTQ's sleep-corrected free-day mid-sleep and its reading, when there are two workday and two free-day nights. */
  chronotype: { msfSc: number; label: string } | null;
  /** Hours the circadian peak moved from the model's published one, and from what: MSF_sc, the median night, the person's stated best hours. */
  phaseShift: number; phaseSource: "chronotype" | "sleep" | "stated" | "default";
  reports: number;
  /** Two-hour bands where the person's reports overrode the model. */
  reportBands: Array<{ from: number; to: number; level: EnergyLevel; count: number }>;
  workedHours: number;
  /** Hours the person often timed work in that the rule reads as low (shown, not used to raise the level). */
  workedInLow: number[];
};

export type EnergyAdviceRule = { levels: AdviceGrid; summary: string; basis: string[]; evidence: EnergyAdviceEvidence } | { insufficient: string; evidence: EnergyAdviceEvidence };

/**
 * The rule. `episodes`: the person's sleep (any source, merged); `reports`: their self-reports of the last eight weeks; `worked`: timed
 * minutes per weekday × hour over the last eight weeks (`workedRhythm`).
 */
export function energyAdviceRule(input: { now: string; zone: string; episodes: SleepEpisode[]; reports: Array<{ at: string; level: EnergyLevel }>;
  worked: number[][];
  /** The person's own best hours (their high-energy window), local hours: the phase when no night is on record. */
  statedPeak?: { start: number; end: number } | null }): EnergyAdviceRule {
  const clock = zoneClock(input.zone);
  const since = Date.parse(input.now) - 28 * 24 * HOUR;
  const nights: Night[] = input.episodes.filter((episode) => Date.parse(episode.wakeAt) >= since && Date.parse(episode.wakeAt) <= Date.parse(input.now))
    .map((episode) => {
      const onsetRaw = clock.hour(episode.sleepAt);
      const weekday = clock.weekday(episode.wakeAt);
      return { onset: onsetRaw < 12 ? onsetRaw + 24 : onsetRaw, wake: clock.hour(episode.wakeAt), free: weekday === 0 || weekday === 6 };
    });
  const reports = settledReports(input.reports).filter((report) => Date.parse(report.at) >= Date.parse(input.now) - 56 * 24 * HOUR);
  const workN = nights.filter((night) => !night.free), freeN = nights.filter((night) => night.free);
  const split = workN.length >= 2 && freeN.length >= 2;
  const usualOf = (list: Night[]): UsualNight => list.length ? { from: median(list.map((night) => night.onset)), to: median(list.map((night) => night.wake)) } : DEFAULT_NIGHT;
  const workdays = usualOf(split ? workN : nights), free = split ? usualOf(freeN) : null;

  // The circadian phase follows sleep timing: MSF_sc when there are both kinds of night, else the median mid-sleep, else the default.
  const midOf = (night: UsualNight) => wrap24(night.from + (night.to + 24 - night.from) / 2);
  let chronotype: EnergyAdviceEvidence["chronotype"] = null;
  if (split && free) {
    const mctq = mctqLite({ workdays: 5, work: { sleep: hhmm(workdays.from), wake: hhmm(workdays.to) }, free: { sleep: hhmm(free.from), wake: hhmm(free.to) } });
    if (mctq.msfSc !== null) chronotype = { msfSc: Math.round(mctq.msfSc * 100) / 100, label: mctq.chronotype ? CHRONOTYPE_LABEL[mctq.chronotype] : "" };
  }
  // With no night on record the person's own statement of their best hours places the peak (as the energy model does); measured sleep
  // timing outranks it.
  const phaseSource: EnergyAdviceEvidence["phaseSource"] = chronotype ? "chronotype" : nights.length ? "sleep" : input.statedPeak ? "stated" : "default";
  const signed = phaseSource === "stated" ? phaseShiftFromPeak(input.statedPeak!.start, input.statedPeak!.end)
    : ((((chronotype?.msfSc ?? (nights.length ? midOf(workdays) : DEFAULT_MID_SLEEP)) - DEFAULT_MID_SLEEP + 36) % 24) - 12);
  const phaseShift = Math.round(Math.max(-6, Math.min(6, signed)) * 100) / 100;

  const workedHours = Math.round(input.worked.flat().reduce((sum, value) => sum + value, 0) / 6) / 10;
  const evidenceBase = { nights: nights.length, usual: { workdays, free }, chronotype, phaseShift, phaseSource, reports: reports.length, workedHours };
  if (nights.length < ADVICE_MIN_NIGHTS && reports.length < ADVICE_MIN_REPORTS)
    return { insufficient: `需要至少 ${ADVICE_MIN_NIGHTS} 晚睡眠记录或 ${ADVICE_MIN_REPORTS} 次精力自评`, evidence: { ...evidenceBase, reportBands: [], workedInLow: [] } };

  // The person's own word wins where it is consistent: a two-hour band with two or more reports, two thirds of them one level.
  const reportBands: EnergyAdviceEvidence["reportBands"] = [];
  for (let band = 0; band < 12; band += 1) {
    const inBand = reports.filter((report) => Math.floor(clock.hour(report.at) / 2) === band);
    if (inBand.length < 2) continue;
    const counts = (["low", "medium", "high"] as const).map((level) => ({ level, n: inBand.filter((report) => report.level === level).length }));
    const top = counts.sort((a, b) => b.n - a.n)[0]!;
    if (top.n * 3 >= inBand.length * 2) reportBands.push({ from: band * 2, to: band * 2 + 2, level: top.level, count: inBand.length });
  }
  const profile = (night: UsualNight) => {
    const levels = levelsOf(usualDayCurve(night, phaseShift));
    for (const band of reportBands) for (let slot = band.from * 2; slot < band.to * 2; slot += 1) if (levels[slot]! > 0) levels[slot] = LEVEL_OF[band.level];
    return smooth(levels);
  };
  const workRow = profile(workdays), freeRow = free ? profile(free) : workRow;
  const levels = Array.from({ length: 7 }, (_, day) => [...(day === 0 || day === 6 ? freeRow : workRow)]);

  // Timed work in an hour the rule reads as low is a contradiction worth saying (the review weighs it); it does not raise the level by
  // itself, because when someone works is not how alert they were.
  const byHour = Array.from({ length: 24 }, (_, hour) => input.worked.reduce((sum, row) => sum + (row[hour] ?? 0), 0));
  const busiest = Math.max(0, ...byHour);
  const workedInLow = byHour.flatMap((minutes, hour) => {
    const awake = [workRow[hour * 2]!, workRow[hour * 2 + 1]!].filter((level) => level > 0);
    return minutes >= Math.max(60, busiest * 0.3) && awake.length && awake.every((level) => level === 1) ? [hour] : [];
  });

  const lead = nights.length
    ? `按近四周 ${nights.length} 晚睡眠（通常 ${clockLabel(wrap24(workdays.from))} 入睡、${clockLabel(workdays.to)} 醒）`
    : "尚无睡眠记录，按通用作息（23:30 入睡、7:30 醒）";
  const high = levelRanges(workRow, 3), low = levelRanges(workRow, 1);
  const summary = `${lead}${reports.length ? `与 ${reports.length} 次自评` : ""}：${free ? "工作日" : ""}高精力 ${high.join("、") || "无"}${low.length ? `，低精力 ${low.join("、")}` : ""}。`;
  const basis = [
    nights.length ? `作息：近四周 ${nights.length} 晚记录${free ? `；休息日通常 ${clockLabel(wrap24(free.from))} 入睡、${clockLabel(free.to)} 醒` : ""}` : "作息：尚无记录，按通用作息",
    chronotype ? `时型：休息日睡眠中点（校正后）${clockLabel(chronotype.msfSc)}${chronotype.label ? `，${chronotype.label}` : ""}` : "时型：工作日与休息日各满两晚后计算",
    `节律峰值相对通用曲线${phaseShift === 0 ? "不移动" : `${phaseShift > 0 ? "推后" : "提前"} ${Math.abs(phaseShift).toFixed(1)} 小时`}（${PHASE_BASIS[phaseSource]}）`,
    ...reportBands.map((band) => `${band.from}–${band.to} 时按本人 ${band.count} 次自评定为${LEVEL_LABEL[LEVEL_OF[band.level]]}精力`),
    ...(workedInLow.length ? [`近八周 ${workedInLow.map((hour) => `${hour} 时`).join("、")}常有计时工作，规则仍判为低精力`] : [])
  ];
  return { levels, summary, basis, evidence: { ...evidenceBase, reportBands, workedInLow } };
}

/** Per day kind, the ranges of each level: what the review reads instead of 336 numbers. */
export function adviceProfiles(levels: AdviceGrid): Array<{ days: "workdays" | "free"; high: string[]; medium: string[]; low: string[] }> {
  const pick = (row: number[]) => ({ high: levelRanges(row, 3), medium: levelRanges(row, 2), low: levelRanges(row, 1) });
  return [{ days: "workdays", ...pick(levels[1] ?? []) }, { days: "free", ...pick(levels[6] ?? []) }];
}

/** Cells the person marked available whose advised level differs from theirs. */
export function adviceChanges(levels: AdviceGrid, grid: AdviceGrid): { cells: number; raised: number; lowered: number } {
  let raised = 0, lowered = 0;
  grid.forEach((row, day) => row.forEach((current, slot) => {
    const advised = levels[day]?.[slot] ?? 0;
    if (!current || !advised || advised === current) return;
    if (advised > current) raised += 1; else lowered += 1;
  }));
  return { cells: raised + lowered, raised, lowered };
}

/** The person's grid with the advice applied: only their available cells change, and only their level; a cell with no advice keeps its own. */
export function applyAdvice(grid: AdviceGrid, levels: AdviceGrid): AdviceGrid {
  return grid.map((row, day) => row.map((current, slot) => current && levels[day]?.[slot] ? levels[day]![slot]! : current));
}

export type EnergyAdjustment = { days: "workdays" | "free" | "all"; start: string; end: string; level: EnergyLevel; why: string; sourceIds: string[] };

/**
 * The review's adjustments on the rule's levels: within waking half hours, and never more than one level from the rule — the review
 * argues from published research about people in general, the rule from this person's own record.
 */
export function withAdjustments(levels: AdviceGrid, adjustments: EnergyAdjustment[]): { levels: AdviceGrid; applied: number } {
  const out = levels.map((row) => [...row]);
  let applied = 0;
  const slotOf = (clock: string) => { const [h, m] = clock.split(":").map(Number); return Math.round(((h ?? 0) * 60 + (m ?? 0)) / 30); };
  for (const adjustment of adjustments) {
    const days = adjustment.days === "workdays" ? [1, 2, 3, 4, 5] : adjustment.days === "free" ? [0, 6] : [0, 1, 2, 3, 4, 5, 6];
    const from = slotOf(adjustment.start), to = Math.min(SLOTS, slotOf(adjustment.end));
    let touched = false;
    for (const day of days) for (let slot = from; slot < to; slot += 1) {
      const rule = levels[day]?.[slot] ?? 0;
      if (!rule) continue;
      const target = Math.max(rule - 1, Math.min(rule + 1, LEVEL_OF[adjustment.level]));
      if (target !== out[day]![slot]) { out[day]![slot] = target; touched = true; }
    }
    if (touched) applied += 1;
  }
  return { levels: out, applied };
}

/** A short stable id for a grid (FNV-1a), so 「忽略」 sets aside exactly this advice. */
export function adviceId(levels: AdviceGrid): string {
  let hash = 0x811c9dc5;
  for (const char of levels.map((row) => row.join("")).join("|")) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}

export type EnergyAdviceReviewState = "agreed" | "adjusted" | "unverified" | "insufficient" | "skipped";
/** What the weekly review left after its sources were opened. */
export type EnergyAdviceReviewRecord = { state: EnergyAdviceReviewState; summary: string; findings: Array<{ claim: string; sourceIds: string[] }>;
  adjustments: EnergyAdjustment[]; droppedSources: number };
/** What the page reads from `ENERGY_ADVICE_SETTING`. */
export type EnergyAdvice = {
  computedAt: string;
  evidence: EnergyAdviceEvidence;
} & ({ insufficient: string } | {
  id: string;
  /** After the review's verified adjustments. */
  levels: AdviceGrid;
  ruleLevels: AdviceGrid;
  /** The one sentence the page shows beside the advice. */
  summary: string;
  basis: string[];
  review: EnergyAdviceReviewRecord;
  /** Only sources the worker opened. */
  sources: Array<{ id: string; url: string; title: string }>;
});

export function readEnergyAdvice(raw: string | null | undefined): EnergyAdvice | null {
  try {
    const value = raw ? JSON.parse(raw) as EnergyAdvice : null;
    if (!value || typeof value.computedAt !== "string") return null;
    if ("insufficient" in value) return value;
    const shaped = (grid: unknown) => Array.isArray(grid) && grid.length === 7 && grid.every((row) => Array.isArray(row) && row.length === SLOTS);
    return shaped(value.levels) && shaped(value.ruleLevels) ? value : null;
  } catch { return null; }
}

/* ── the weekly review's wire contract ── */

const CLOCK = { type: "string", pattern: "^([01][0-9]|2[0-3]):[03]0$|^24:00$" } as const;
const ID = { type: "string", pattern: "^s[0-9]{1,2}$" } as const;

export const ENERGY_ADVICE_REVIEW_SCHEMA = { type: "object", additionalProperties: false, required: ["verdict", "summary", "adjustments", "findings", "sources"], properties: {
  verdict: { type: "string", enum: ["agree", "adjust", "insufficient"] },
  summary: { type: "string", minLength: 4, maxLength: 120 },
  adjustments: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["days", "start", "end", "level", "why", "sourceIds"], properties: {
    days: { type: "string", enum: ["workdays", "free", "all"] }, start: CLOCK, end: CLOCK, level: { type: "string", enum: ["high", "medium", "low"] },
    why: { type: "string", minLength: 4, maxLength: 160 }, sourceIds: { type: "array", minItems: 1, maxItems: 3, items: ID } } } },
  findings: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["claim", "sourceIds"], properties: {
    claim: { type: "string", minLength: 4, maxLength: 200 }, sourceIds: { type: "array", minItems: 1, maxItems: 3, items: ID } } } },
  sources: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["id", "url", "title"], properties: {
    id: ID, url: { type: "string", minLength: 12, maxLength: 400 }, title: { type: "string", minLength: 2, maxLength: 200 } } } }
} } as const;

export type EnergyAdviceReview = {
  verdict: "agree" | "adjust" | "insufficient"; summary: string; adjustments: EnergyAdjustment[];
  findings: Array<{ claim: string; sourceIds: string[] }>; sources: Array<{ id: string; url: string; title: string }>;
};

/** Refuses what cannot be used; the message names the problem so the repair turn has something to fix. */
export function validateEnergyAdviceReview(value: unknown): EnergyAdviceReview {
  const answer = value as EnergyAdviceReview | undefined;
  if (!answer || !Array.isArray(answer.adjustments) || !Array.isArray(answer.findings) || !Array.isArray(answer.sources) || typeof answer.summary !== "string")
    throw new Error("ENERGY_REVIEW_SCHEMA_INVALID");
  const ids = new Set(answer.sources.map((source) => source.id));
  if (ids.size !== answer.sources.length) throw new Error("ENERGY_REVIEW_SOURCE_DUPLICATE: each source needs its own id");
  for (const source of answer.sources) if (!/^https:\/\//.test(source.url)) throw new Error(`ENERGY_REVIEW_SOURCE_NOT_HTTPS: ${source.id} must be a public https page`);
  const cited = (list: string[], where: string) => { const missing = list.filter((id) => !ids.has(id)); if (missing.length) throw new Error(`ENERGY_REVIEW_UNKNOWN_SOURCE: ${where} cites ${missing.join(", ")}, not in sources`); };
  const minutes = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  answer.adjustments.forEach((item, index) => {
    if (minutes(item.end) <= minutes(item.start)) throw new Error(`ENERGY_REVIEW_RANGE_INVALID: adjustment ${index + 1} ends at or before it starts`);
    cited(item.sourceIds, `adjustment ${index + 1}`);
  });
  answer.findings.forEach((item, index) => cited(item.sourceIds, `finding ${index + 1}`));
  if (answer.verdict === "adjust" && !answer.adjustments.length) throw new Error("ENERGY_REVIEW_ADJUST_EMPTY: verdict adjust needs at least one adjustment");
  if (answer.verdict !== "adjust" && answer.adjustments.length) throw new Error("ENERGY_REVIEW_ADJUST_UNEXPECTED: adjustments only with verdict adjust");
  if (/[你您我]/.test([answer.summary, ...answer.adjustments.map((item) => item.why), ...answer.findings.map((item) => item.claim)].join("")))
    throw new Error("ENERGY_REVIEW_PERSON: write in the third person, without 你/您/我");
  return answer;
}

