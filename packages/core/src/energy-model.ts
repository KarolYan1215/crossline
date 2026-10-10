/**
 * Energy without asking every time (docs/one-input.md §5). A biomathematical prior — the three-process model of alertness (Åkerstedt &
 * Folkard): a homeostatic term that falls exponentially with time awake and recovers with sleep, plus a 24-hour circadian cosine —
 * driven by when the person slept and woke, read from where it is known (the screen's long idle stretches, a phone's sleep record),
 * then calibrated to the person by their own L/M/H reports. It says how sure it is; below `medium` the schedule does not use it and
 * the person is asked instead. A wearable is another `EnergySource`; nothing below changes.
 */

import type { EnergyLevel } from "./index";

export type SleepEpisode = { sleepAt: string; wakeAt: string; source: string };

/** Where sleep comes from: the screen's idle gaps, a phone's health record, later a ring or watch. */
export interface EnergySource {
  id: string;
  /** Sleep episodes known for the days around `day` (ISO instants). */
  sleep(): SleepEpisode[];
  /** Per-day physiology when the source has it (heart-rate variability, resting heart rate). */
  physiology?(): Array<{ day: string; hrvMs?: number; restingHr?: number }>;
}

// Three-process model constants (Åkerstedt & Folkard 1997; Åkerstedt, Folkard & Portin 2004).
const S_LOWER = 2.4, S_UPPER = 14.3, AWAKE_DECAY = 0.0353, SLEEP_RECOVERY = 0.381, C_AMPLITUDE = 2.5, C_ACROPHASE = 16.8;
const HOUR = 3_600_000;

/** A stretch of no activity is sleep when it lasts four hours or more and covers some of the night (00:00–06:00 local). */
export function sleepFromGaps(gaps: Array<{ from: string; to: string }>, localHour: (iso: string) => number): SleepEpisode[] {
  return gaps.filter((gap) => {
    const hours = (Date.parse(gap.to) - Date.parse(gap.from)) / HOUR;
    if (!(hours >= 4 && hours <= 16)) return false;
    // Covers part of the night: starts in the evening or night, or ends in the morning.
    const start = localHour(gap.from), end = localHour(gap.to);
    return start >= 19 || start < 6 || (end >= 3 && end <= 13 && hours >= 5);
  }).map((gap) => ({ sleepAt: gap.from, wakeAt: gap.to, source: "screen" }));
}

/** Several sources: a record the person's phone made wins over the screen's guess for the same night. */
export function mergeSleep(...sources: SleepEpisode[][]): SleepEpisode[] {
  const byWake = new Map<string, SleepEpisode>();
  for (const episode of sources.flat()) {
    const night = new Date(Date.parse(episode.wakeAt) - 12 * HOUR).toISOString().slice(0, 10);
    const existing = byWake.get(night);
    if (!existing || (existing.source === "screen" && episode.source !== "screen")) byWake.set(night, episode);
  }
  return [...byWake.values()].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt));
}

/**
 * Alertness at `at` on the model's scale (about 4–16), from the last sleep before it: S at waking after `sleepHours`, falling with time
 * awake, plus the circadian term at the local hour (shifted by `phaseShift` hours for an early or late person).
 */
export function alertness(at: string, episode: SleepEpisode, localHourOf: (iso: string) => number, phaseShift = 0): number {
  const sleepHours = Math.max(0, (Date.parse(episode.wakeAt) - Date.parse(episode.sleepAt)) / HOUR);
  // At sleep onset S stands where sixteen hours awake leave it; sleep recovers it towards the upper asymptote.
  const atOnset = S_LOWER + (S_UPPER - S_LOWER) * Math.exp(-AWAKE_DECAY * 16);
  const atWake = S_UPPER - (S_UPPER - atOnset) * Math.exp(-SLEEP_RECOVERY * sleepHours);
  const awake = Math.max(0, (Date.parse(at) - Date.parse(episode.wakeAt)) / HOUR);
  const s = S_LOWER + (atWake - S_LOWER) * Math.exp(-AWAKE_DECAY * awake);
  const c = C_AMPLITUDE * Math.cos((2 * Math.PI * (localHourOf(at) - (C_ACROPHASE + phaseShift))) / 24);
  return s + c;
}

/** The last sleep that ended before `at` (and not more than a day before it), or undefined. */
export const lastSleepBefore = (episodes: SleepEpisode[], at: string): SleepEpisode | undefined =>
  [...episodes].reverse().find((episode) => episode.wakeAt <= at && Date.parse(at) - Date.parse(episode.wakeAt) < 24 * HOUR);

export type EnergyCalibration = { low: number; high: number; reports: number; agreement: number };
/** Before the person has said anything: cut points that read a rested morning as high and a late, short-slept evening as low. */
export const DEFAULT_CALIBRATION: EnergyCalibration = { low: 9.5, high: 12.5, reports: 0, agreement: 0 };

/**
 * The person's own reports turn the scale into their L/M/H: the two cut points that agree with the most reports, pulled towards the
 * default while there are few (each default cut point counts as three reports' worth).
 */
export function calibrate(reports: Array<{ alertness: number; level: EnergyLevel }>): EnergyCalibration {
  if (!reports.length) return DEFAULT_CALIBRATION;
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const levelOf = (value: number, low: number, high: number) => value < low ? 0 : value < high ? 1 : 2;
  let best = { low: DEFAULT_CALIBRATION.low, high: DEFAULT_CALIBRATION.high, score: -Infinity, agreement: 0 };
  for (let low = 6; low <= 14; low += 0.25) {
    for (let high = low + 0.5; high <= 16; high += 0.25) {
      const agree = reports.filter((report) => levelOf(report.alertness, low, high) === rank[report.level]).length;
      // Prior: three reports' worth of preference for the default cut points.
      const penalty = 3 * ((Math.abs(low - DEFAULT_CALIBRATION.low) + Math.abs(high - DEFAULT_CALIBRATION.high)) / 8);
      const score = agree - penalty;
      if (score > best.score) best = { low, high, score, agreement: agree / reports.length };
    }
  }
  return { low: best.low, high: best.high, reports: reports.length, agreement: best.agreement };
}

export type EnergyPrediction = { level: EnergyLevel; confidence: "low" | "medium" | "high"; alertness?: number; basis: string[] };

/**
 * The energy expected at `at`. Without a known last sleep it is unknown (`low` confidence); with one, the calibrated level, as sure as
 * the reports behind it allow: `high` from eight reports agreeing seven times in ten, `medium` from four agreeing six in ten.
 */
export function predictEnergy(at: string, episodes: SleepEpisode[], calibration: EnergyCalibration, localHourOf: (iso: string) => number,
  phaseShift = 0): EnergyPrediction {
  const episode = lastSleepBefore(episodes, at);
  if (!episode) return { level: "medium", confidence: "low", basis: ["不知道最近一次睡眠"] };
  const value = alertness(at, episode, localHourOf, phaseShift);
  const level: EnergyLevel = value < calibration.low ? "low" : value < calibration.high ? "medium" : "high";
  const awake = (Date.parse(at) - Date.parse(episode.wakeAt)) / HOUR;
  const slept = (Date.parse(episode.wakeAt) - Date.parse(episode.sleepAt)) / HOUR;
  const confidence = calibration.reports >= 8 && calibration.agreement >= 0.7 ? "high"
    : calibration.reports >= 4 && calibration.agreement >= 0.6 ? "medium" : "low";
  return { level, confidence, alertness: Math.round(value * 10) / 10,
    basis: [`睡了约 ${slept.toFixed(1)} 小时（${episode.source === "screen" ? "由电脑空闲推断" : "手机记录"}）`, `已醒 ${awake.toFixed(1)} 小时`,
      calibration.reports ? `按本人 ${calibration.reports} 次自评校准` : "尚无自评，用通用曲线"] };
}

/**
 * The person's stated best hours (「上午 9–12 点效率最高」) move the circadian peak: the default peak is late afternoon, and a person at
 * their best in the morning peaks earlier. Returns the shift in hours, bounded to ±6.
 */
export function phaseShiftFromPeak(peakStartHour: number | undefined, peakEndHour: number | undefined): number {
  if (peakStartHour === undefined || peakEndHour === undefined) return 0;
  const mid = (peakStartHour + peakEndHour) / 2;
  return Math.max(-6, Math.min(6, mid - C_ACROPHASE));
}
