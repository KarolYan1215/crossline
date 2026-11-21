import { DEFAULT_AVAILABILITY, type AvailabilitySource, type AvailabilityWindow } from "./availability";
import type { EnergyLevel } from "./index";

/**
 * Which half hours of a usual day are high, medium and low energy, and so where the best hours are — one function for the portrait's
 * 「精力节律」 (`energyRhythm`) and the plan page's weekly advice (`energyAdviceRule`), so the two never name different hours for the same
 * record (W-265; the owner's decision of 2026-11-20). What the person said wins over the generic model: the levels they stated for their
 * hours (the interview's proposed pattern or the one they painted) and their own L/M/H reports where two or more agree on a two-hour band.
 * The model's curve fills in only the hours nobody spoke for; and once the person named a high window, the model's own high hours elsewhere
 * drop to medium — they said where their best hours are.
 *
 * Rows are the plan page's: 48 half hours, 0 asleep, 1 low, 2 medium, 3 high.
 */

const SLOTS = 48;
const DAY = 86_400_000;
export const ENERGY_LEVEL_VALUE: Record<EnergyLevel, number> = { low: 1, medium: 2, high: 3 };
/** The workdays (0 = Sunday), whose levels the portrait shows and the advice summarises. */
export const WORKDAYS = [1, 2, 3, 4, 5];

/** A stretch of the day at one level the person gave; local hours, `to` may be 24. */
export type EnergyBand = { from: number; to: number; level: EnergyLevel };
export type ReportBand = EnergyBand & { count: number };

/** Self-reports with corrections folded in: a report followed by another within ten minutes was taken back by it. */
export function settledReports(reports: Array<{ at: string; level: EnergyLevel }>): Array<{ at: string; level: EnergyLevel }> {
  const sorted = [...reports].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.filter((report, index) => {
    const next = sorted[index + 1];
    return !next || Date.parse(next.at) - Date.parse(report.at) > 10 * 60_000;
  });
}

/** Two-hour bands where the last eight weeks' settled reports agree: two or more in the band, two thirds of them one level. */
export function reportBandsOf(reports: Array<{ at: string; level: EnergyLevel }>, hourOf: (iso: string) => number, now: string): ReportBand[] {
  const recent = settledReports(reports).filter((report) => Date.parse(report.at) >= Date.parse(now) - 56 * DAY);
  const bands: ReportBand[] = [];
  for (let band = 0; band < 12; band += 1) {
    const inBand = recent.filter((report) => Math.floor(hourOf(report.at) / 2) === band);
    if (inBand.length < 2) continue;
    const top = (["low", "medium", "high"] as const).map((level) => ({ level, n: inBand.filter((report) => report.level === level).length }))
      .sort((a, b) => b.n - a.n)[0]!;
    if (top.n * 3 >= inBand.length * 2) bands.push({ from: band * 2, to: band * 2 + 2, level: top.level, count: inBand.length });
  }
  return bands;
}

/**
 * The windows whose levels the person stated: the pattern they painted or the one the interview proposed from what they said (「10–13 点最累、
 * 18–23 点最清醒」). Not the default nor the pattern spread from their weekly hours — nobody said those levels.
 */
export function statedEnergyWindows(resolved: { windows: AvailabilityWindow[]; source: AvailabilitySource }): AvailabilityWindow[] {
  if (resolved.source !== "saved" && resolved.source !== "interview") return [];
  return JSON.stringify(resolved.windows) === JSON.stringify(DEFAULT_AVAILABILITY) ? [] : resolved.windows;
}

/** The stated windows that apply on any of `days`, as bands. */
export function statedBands(windows: AvailabilityWindow[], days: number[]): EnergyBand[] {
  const hours = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) + (m ?? 0) / 60; };
  return windows.filter((window) => window.days.some((day) => days.includes(day)))
    .map((window) => ({ from: hours(window.start), to: hours(window.end), level: window.energy }));
}

/**
 * Levels from the model's curve alone, by rank within the person's own waking day: the best quarter of the waking half hours high, the
 * worst quarter (inertia after waking, the hours before sleep, the afternoon dip when it is deep enough) low, the rest medium. By rank on
 * purpose: the model's curve is flat through most of a rested day, so a cut on its value marked twelve hours high; and the absolute cut
 * points are calibrated from reports, which a person with few of them does not have.
 */
function modelLevels(curve: Array<number | null>): number[] {
  const awake = curve.flatMap((value, slot) => value === null ? [] : [{ value, slot }]).sort((a, b) => b.value - a.value || a.slot - b.slot);
  const levels = curve.map(() => 0);
  const quarter = Math.round(awake.length * 0.25);
  awake.forEach((item, rank) => { levels[item.slot] = rank < quarter ? 3 : rank >= awake.length - quarter ? 1 : 2; });
  return levels;
}

/**
 * A run shorter than an hour takes its neighbour's level, so the levels read as a few windows rather than a scatter of half hours. Only
 * the model's own half hours move, and only towards another of the model's: what the person said keeps its edges (their 18–23 stays
 * 18–23, not 18–23:30 because the half hour before sleep was a lone one).
 */
function smooth(levels: number[], said: boolean[]): number[] {
  const out = [...levels];
  for (let slot = 0; slot < SLOTS;) {
    let end = slot;
    while (end < SLOTS && out[end] === out[slot] && said[end] === said[slot]) end += 1;
    if (out[slot]! > 0 && end - slot < 2 && !said[slot]) {
      const before = slot > 0 && !said[slot - 1] ? out[slot - 1]! : 0, after = end < SLOTS && !said[end] ? out[end]! : 0;
      const take = before > 0 ? before : after;
      if (take > 0) for (let index = slot; index < end; index += 1) out[index] = take;
    }
    slot = end;
  }
  return out;
}

/**
 * One usual day's levels. `curve`: the model's alertness at the middle of each half hour, null while usually asleep. `stated`: the bands
 * the person stated for this kind of day (`statedBands`); `reports`: where their reports agree (`reportBandsOf`), which outrank a statement
 * because they were given at the hour itself. Asleep half hours stay 0 whatever was said.
 */
export function dayLevels(curve: Array<number | null>, said: { stated: EnergyBand[]; reports: EnergyBand[] }): number[] {
  const levels = modelLevels(curve);
  const spoken = curve.map(() => false);
  if (said.stated.some((band) => band.level === "high")) for (let slot = 0; slot < levels.length; slot += 1) if (levels[slot] === 3) levels[slot] = 2;
  for (const band of [...said.stated, ...said.reports]) {
    for (let slot = Math.ceil(band.from * 2); slot < Math.min(SLOTS, Math.floor(band.to * 2)); slot += 1) {
      if (levels[slot]! > 0) { levels[slot] = ENERGY_LEVEL_VALUE[band.level]; spoken[slot] = true; }
    }
  }
  return smooth(levels, spoken);
}

/** The best hours of a day's levels: every run at its highest waking level, as local hours. */
export function bestWindows(levels: number[]): Array<{ start: number; end: number }> {
  const top = Math.max(0, ...levels);
  if (!top) return [];
  const windows: Array<{ start: number; end: number }> = [];
  for (let slot = 0; slot < levels.length;) {
    if (levels[slot] !== top) { slot += 1; continue; }
    let end = slot;
    while (end < levels.length && levels[end] === top) end += 1;
    windows.push({ start: slot / 2, end: end / 2 });
    slot = end;
  }
  return windows;
}
