import { mctqLite, type MctqLiteResult } from "./assess";
import { alertnessAt, sleepDebt, type EnergyCalibration, type SleepEpisode } from "./energy-model";
import type { EnergyLevel } from "./index";

/** Re-exported so the static quick test can reach it through `@crossline/core/energy-rhythm` alone. */
export { DEFAULT_CALIBRATION } from "./energy-model";

/**
 * The portrait's 「精力节律」 page (docs/energy-and-ecosystem.md §7, decided 2026-10-14): the energy model drawn over one usual day. The
 * day is built from the person's usual sleep (the medians of the last four weeks' nights, else 23:30–7:30) repeated for two weeks, so
 * the curve is the model's steady rhythm at their phase, not one particular day's; their own L/M/H reports are placed on it by hour.
 */
export type EnergyRhythm = {
  /** Every half hour from 0:00 to 24:00, the model's alertness on its scale; null while usually asleep. */
  curve: Array<{ hour: number; value: number | null }>;
  /** Usual sleep onset and wake, local hours (onset may exceed 24 for after midnight). */
  sleep: { from: number; to: number };
  /** The three waking hours with the highest mean alertness. */
  peak: { start: number; end: number };
  /** The person's cut points between low, medium and high on the same scale. */
  thresholds: { low: number; high: number };
  reports: Array<{ hour: number; level: EnergyLevel }>;
  /** From workday and free-day nights (two of each at least); null otherwise. */
  chronotype: MctqLiteResult | null;
  debt: { perNight: number; nights: number };
  /** Recorded nights in the last four weeks behind the usual times (0 = the default night). */
  nights: number;
};

const HOUR = 3_600_000;
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length / 2; return s.length % 2 ? s[Math.floor(m)]! : (s[m - 1]! + s[m]!) / 2; };
/** Onset hour on the night's side: 1:00 is 25. */
const onsetHour = (hour: number) => (hour < 12 ? hour + 24 : hour);
const clock = (hours: number) => { const h = ((Math.round(hours * 60) % 1440) + 1440) % 1440; return `${Math.floor(h / 60)}:${String(h % 60).padStart(2, "0")}`; };

export function energyRhythm(input: {
  episodes: SleepEpisode[]; hourOf: (iso: string) => number;
  /** ISO weekday of a moment in the person's zone, 1 = Monday … 7 = Sunday. */
  weekdayOf: (iso: string) => number;
  phaseShift: number; calibration: EnergyCalibration; reports: Array<{ at: string; level: EnergyLevel }>; now: string;
}): EnergyRhythm {
  const since = Date.parse(input.now) - 28 * 24 * HOUR;
  const nights = input.episodes.filter((episode) => Date.parse(episode.wakeAt) >= since && Date.parse(episode.wakeAt) <= Date.parse(input.now))
    .map((episode) => ({ onset: onsetHour(input.hourOf(episode.sleepAt)), wake: input.hourOf(episode.wakeAt), free: input.weekdayOf(episode.wakeAt) >= 6 }));
  const usual = nights.length ? { from: median(nights.map((night) => night.onset)), to: median(nights.map((night) => night.wake)) } : { from: 23.5, to: 7.5 };

  // Two weeks of the usual night on a synthetic UTC calendar, read with the UTC hour, then one day after the last waking.
  const day0 = Date.parse("2000-01-01T00:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const episodes: SleepEpisode[] = Array.from({ length: 14 }, (_, index) => ({
    sleepAt: iso(day0 + (index * 24 + usual.from) * HOUR), wakeAt: iso(day0 + ((index + 1) * 24 + usual.to) * HOUR), source: "usual" }));
  const utcHour = (at: string) => { const date = new Date(at); return date.getUTCHours() + date.getUTCMinutes() / 60; };
  const today = day0 + 14 * 24 * HOUR;
  const asleep = (hour: number) => { const h = hour % 24; return usual.from >= 24 ? h >= usual.from - 24 && h < usual.to : h >= usual.from || h < usual.to; };
  const curve = Array.from({ length: 49 }, (_, index) => {
    const hour = index / 2;
    if (asleep(hour)) return { hour, value: null };
    const value = alertnessAt(iso(today + hour * HOUR), episodes, utcHour, input.phaseShift);
    return { hour, value: value === undefined ? null : Math.round(value * 100) / 100 };
  });
  // The best three hours: six consecutive half-hour points, all awake.
  let best = { start: usual.to, mean: -Infinity };
  for (let index = 0; index + 6 < curve.length; index += 1) {
    const window = curve.slice(index, index + 7).map((point) => point.value);
    if (window.some((value) => value === null)) continue;
    const mean = (window as number[]).reduce((sum, value) => sum + value, 0) / window.length;
    if (mean > best.mean) best = { start: curve[index]!.hour, mean };
  }
  const work = nights.filter((night) => !night.free), free = nights.filter((night) => night.free);
  const middle = (list: typeof nights) => ({ sleep: clock(median(list.map((night) => night.onset))), wake: clock(median(list.map((night) => night.wake))) });
  const debt = sleepDebt(input.now, input.episodes);
  return {
    curve, sleep: usual, peak: { start: best.start, end: best.start + 3 },
    thresholds: { low: input.calibration.low, high: input.calibration.high },
    reports: input.reports.filter((report) => Date.parse(report.at) >= since).map((report) => ({ hour: Math.round(input.hourOf(report.at) * 2) / 2, level: report.level })),
    chronotype: work.length >= 2 && free.length >= 2 ? mctqLite({ workdays: 5, work: middle(work), free: middle(free) }) : null,
    debt: { perNight: Math.round(debt.perNight * 10) / 10, nights: debt.nights },
    nights: nights.length
  };
}
