import { clockHours, type MctqLiteInput } from "@crossline/core/assess";
import { DEFAULT_CALIBRATION, energyRhythm, type EnergyRhythm } from "@crossline/core/energy-rhythm";

const DAY = 86_400_000;

/**
 * Two weeks of nights as the person described them (workday times on the five workdays they named, free-day times on the rest), on a
 * UTC calendar ending at `today` — so the energy model can draw their usual day without any record. Workdays are taken as Monday first.
 */
export function nightsFromAnswers(input: MctqLiteInput, today = "2026-01-15") {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: 14 }, (_, index) => {
    const wakeDay = new Date(end - (13 - index) * DAY);
    const weekday = wakeDay.getUTCDay() === 0 ? 7 : wakeDay.getUTCDay();
    const times = weekday <= input.workdays ? input.work : input.free;
    const onset = clockHours(times.sleep), wake = clockHours(times.wake);
    // An onset before noon is after midnight, on the wake day; otherwise the evening before.
    const sleepAt = wakeDay.getTime() + (onset < 12 ? onset : onset - 24) * 3_600_000;
    return { sleepAt: new Date(sleepAt).toISOString(), wakeAt: new Date(wakeDay.getTime() + wake * 3_600_000).toISOString(), source: "self-report" };
  });
}

/** The usual day's curve from the answers (no stated best hours, so the model's default phase). */
export function rhythmFromAnswers(input: MctqLiteInput, today = "2026-01-15"): EnergyRhythm {
  const utcHour = (iso: string) => { const date = new Date(iso); return date.getUTCHours() + date.getUTCMinutes() / 60; };
  const weekday = (iso: string) => { const day = new Date(iso).getUTCDay(); return day === 0 ? 7 : day; };
  return energyRhythm({ episodes: nightsFromAnswers(input, today), hourOf: utcHour, weekdayOf: weekday, phaseShift: 0,
    calibration: DEFAULT_CALIBRATION, reports: [], now: `${today}T12:00:00Z` });
}
