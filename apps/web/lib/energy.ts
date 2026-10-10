import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import {
  ACTIVITY_LONG_GAPS, SLEEP_TRACKING_CONSENT, calibrate, mergeSleep, phaseShiftFromPeak, predictEnergy, sleepFromGaps, lastSleepBefore, alertness,
  type AccessContext, type AvailabilityWindow, type EnergyCalibration, type EnergyLevel, type EnergyPrediction, type EnergySource, type SleepEpisode
} from "@crossline/core";
import { effectiveSchedulePreferences, getStore } from "./crossline";

/** Where a phone's sleep and heart-rate summaries are kept (the last 30 nights), and the hash of the token its shortcut sends. */
export const HEALTH_SLEEP_SETTING = "health.sleep";
export const HEALTH_DAILY_SETTING = "health.daily";
export const HEALTH_TOKEN_SETTING = "health.token.sha256";
const LONG_GAPS_SETTING = ACTIVITY_LONG_GAPS;

const read = <T>(raw: string | undefined | null, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** The screen's long idle stretches, read as sleep (docs/one-input.md §5.1 ①). */
function screenSource(ctx: AccessContext, hourOf: (iso: string) => number): EnergySource {
  const on = getStore().getSetting(ctx.workspaceId, SLEEP_TRACKING_CONSENT) === "granted";
  return { id: "screen-activity", sleep: () => on ? sleepFromGaps(read(getStore().getSetting(ctx.workspaceId, LONG_GAPS_SETTING), [] as Array<{ from: string; to: string }>), hourOf) : [] };
}
/** What the person's phone sent (③): sleep episodes and per-day heart-rate variability. */
function phoneSource(ctx: AccessContext): EnergySource {
  const store = getStore();
  return { id: "ios-health", sleep: () => read(store.getSetting(ctx.workspaceId, HEALTH_SLEEP_SETTING), [] as SleepEpisode[]),
    physiology: () => read(store.getSetting(ctx.workspaceId, HEALTH_DAILY_SETTING), [] as Array<{ day: string; hrvMs?: number; restingHr?: number }>) };
}

export type EnergyModel = {
  episodes: SleepEpisode[]; calibration: EnergyCalibration; phaseShift: number;
  hourOf: (iso: string) => number;
  predict: (at: string) => EnergyPrediction;
  /** When the person last said how they are, ISO, or "". */
  lastReportAt: string;
};

/**
 * The person's energy model as of now: sleep from every source (a phone's record wins over the screen's guess), the circadian peak
 * moved to their own high-energy hours, and the cut points calibrated by every L/M/H they reported at a time whose last sleep is known.
 */
export function energyModel(ctx: AccessContext, windows: AvailabilityWindow[]): EnergyModel {
  const store = getStore();
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const hourOf = (iso: string) => { const [h, m] = formatInTimeZone(new Date(iso), zone, "HH:mm").split(":").map(Number); return (h ?? 0) + (m ?? 0) / 60; };
  const episodes = mergeSleep(screenSource(ctx, hourOf).sleep(), phoneSource(ctx).sleep());
  // The circadian peak sits where the person said their best hours are (the high-energy windows of the availability pattern).
  const peak = windows.find((window) => window.energy === "high");
  const toHour = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) + (m ?? 0) / 60; };
  const phaseShift = peak ? phaseShiftFromPeak(toHour(peak.start), toHour(peak.end)) : 0;
  const reports = store.listEnergyObservations(ctx.workspaceId).filter((item) => item.source === "self_report" && item.level !== "uncalibrated");
  const calibration = calibrate(reports.flatMap((report) => {
    const episode = lastSleepBefore(episodes, report.observedAt);
    return episode ? [{ alertness: alertness(report.observedAt, episode, hourOf, phaseShift), level: report.level as EnergyLevel }] : [];
  }));
  const lastReportAt = reports.map((report) => report.observedAt).sort().at(-1) ?? "";
  return { episodes, calibration, phaseShift, hourOf, lastReportAt, predict: (at) => predictEnergy(at, episodes, calibration, hourOf, phaseShift) };
}

/** A slot's energy for the scheduler: the model's when it is at least moderately sure, the pattern's otherwise. */
export function slotEnergy(model: EnergyModel, startIso: string, fallback: EnergyLevel): EnergyLevel {
  const prediction = model.predict(startIso);
  return prediction.confidence === "low" ? fallback : prediction.level;
}

/**
 * The token the phone's shortcut sends. Made on request and shown once; only its hash is kept, so it can be replaced but never read
 * back. Replacing it cuts off the old shortcut at once.
 */
export function issueHealthToken(ctx: AccessContext): string {
  const token = randomBytes(24).toString("base64url");
  getStore().setSetting(ctx.workspaceId, HEALTH_TOKEN_SETTING, createHash("sha256").update(token).digest("hex"));
  return token;
}

/** The workspace whose token this is, or undefined (compared in constant time). */
export function workspaceForHealthToken(token: string): string | undefined {
  const hash = createHash("sha256").update(token).digest();
  for (const workspace of getStore().listWorkspaces()) {
    const stored = getStore().getSetting(workspace.id, HEALTH_TOKEN_SETTING);
    if (stored && stored.length === 64 && timingSafeEqual(Buffer.from(stored, "hex"), hash)) return workspace.id;
  }
  return undefined;
}

/**
 * What a phone sent: sleep episodes (ISO start and end) and the day's heart-rate figures, kept as summaries for the last 30 nights.
 * Anything malformed is dropped, not stored; nothing finer than one episode or one day is kept.
 */
export function storeHealthSummary(workspaceId: string, input: { sleep?: unknown; hrvMs?: unknown; restingHr?: unknown; day?: unknown }): { stored: number } {
  const store = getStore();
  const iso = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  const incoming = (Array.isArray(input.sleep) ? input.sleep : []).flatMap((raw) => {
    const item = raw as { start?: unknown; end?: unknown };
    const start = iso(item?.start), end = iso(item?.end);
    const hours = start && end ? (Date.parse(end) - Date.parse(start)) / 3_600_000 : 0;
    return start && end && hours > 0.5 && hours < 16 ? [{ sleepAt: start, wakeAt: end, source: "ios-health" }] : [];
  });
  // Several sleep samples of one night (the phone splits them) become one episode: from the first fall to the last wake.
  const merged: SleepEpisode[] = [];
  for (const episode of incoming.sort((a, b) => a.sleepAt.localeCompare(b.sleepAt))) {
    const last = merged.at(-1);
    if (last && Date.parse(episode.sleepAt) - Date.parse(last.wakeAt) < 2 * 3_600_000) last.wakeAt = episode.wakeAt > last.wakeAt ? episode.wakeAt : last.wakeAt;
    else merged.push({ ...episode });
  }
  const existing = read(store.getSetting(workspaceId, HEALTH_SLEEP_SETTING), [] as SleepEpisode[]).filter((old) => !merged.some((item) => item.wakeAt.slice(0, 10) === old.wakeAt.slice(0, 10)));
  store.setSetting(workspaceId, HEALTH_SLEEP_SETTING, JSON.stringify([...existing, ...merged].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt)).slice(-30)));
  const day = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : undefined;
  const hrv = Number(input.hrvMs), resting = Number(input.restingHr);
  if (day && (Number.isFinite(hrv) || Number.isFinite(resting))) {
    const daily = read(store.getSetting(workspaceId, HEALTH_DAILY_SETTING), [] as Array<{ day: string; hrvMs?: number; restingHr?: number }>).filter((item) => item.day !== day);
    daily.push({ day, ...(Number.isFinite(hrv) && hrv > 0 && hrv < 400 ? { hrvMs: Math.round(hrv) } : {}), ...(Number.isFinite(resting) && resting > 20 && resting < 200 ? { restingHr: Math.round(resting) } : {}) });
    store.setSetting(workspaceId, HEALTH_DAILY_SETTING, JSON.stringify(daily.sort((a, b) => a.day.localeCompare(b.day)).slice(-30)));
  }
  return { stored: merged.length };
}
