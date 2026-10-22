import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import {
  ACTIVITY_LONG_GAPS, CAMERA_ENERGY_CONSENT, INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT, PHONE_HEALTH_CONSENT, SLEEP_TRACKING_CONSENT, phoneHealthGranted, calibrate, covariateShift, inputRhythmAt, judgeCovariate, dayCapacity, mergeSleep, phaseShiftFromPeak, predictEnergy, sleepFromGaps, sleepFromPhoneEvents, alertnessAt,
  type AccessContext, type AdmittedActivity, type AvailabilityWindow, type DailyActivityId, type CovariateVerdict, type DailyPhysiology, type InputRhythmBucket, type DayCapacity, type EnergyCalibration, type EnergyLevel, type EnergyPrediction, type EnergySource, type PhoneSleepEvent, type SleepEpisode
} from "@crossline/core";
import { effectiveSchedulePreferences, getStore } from "./crossline";

/** Where a phone's sleep and heart-rate summaries are kept (the last 30 nights), and the hash of the token its shortcut sends. */
export const HEALTH_SLEEP_SETTING = "health.sleep";
export const HEALTH_DAILY_SETTING = "health.daily";
export const HEALTH_TOKEN_SETTING = "health.token.sha256";
/** The phone's bed and wake moments (alarm stopped, sleep focus, 「就寝开始」/「醒来」), the last 30 days. */
export const HEALTH_EVENTS_SETTING = "health.events";
const LONG_GAPS_SETTING = ACTIVITY_LONG_GAPS;

const read = <T>(raw: string | undefined | null, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** 手机健康数据 is on (`phoneHealthGranted`: the person's switch, or a token made before the switch existed). */
export function phoneHealthOn(workspaceId: string): boolean {
  const store = getStore();
  return phoneHealthGranted(store.getSetting(workspaceId, PHONE_HEALTH_CONSENT), Boolean(store.getSetting(workspaceId, HEALTH_TOKEN_SETTING)));
}

/** The latest day the phone sent steps or daylight for, shown on the settings card; undefined while 手机健康数据 is off or none came. */
export function phoneDailyLatest(workspaceId: string): { day: string; steps?: number; daylightMin?: number } | undefined {
  if (!phoneHealthOn(workspaceId)) return undefined;
  const latest = read(getStore().getSetting(workspaceId, HEALTH_DAILY_SETTING), [] as DailyPhysiology[])
    .filter((item) => item.steps !== undefined || item.daylightMin !== undefined).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
  return latest ? { day: latest.day, ...(latest.steps !== undefined ? { steps: latest.steps } : {}), ...(latest.daylightMin !== undefined ? { daylightMin: latest.daylightMin } : {}) } : undefined;
}

/** Turns 手机健康数据 on or off; off deletes every phone summary and the health token, so the shortcut stops at once. */
export function setPhoneHealth(workspaceId: string, on: boolean): void {
  const store = getStore();
  store.setSetting(workspaceId, PHONE_HEALTH_CONSENT, on ? "granted" : "denied");
  if (on) return;
  for (const key of [HEALTH_SLEEP_SETTING, HEALTH_DAILY_SETTING, HEALTH_EVENTS_SETTING, HEALTH_TOKEN_SETTING]) store.deleteSetting(workspaceId, key);
}

/** The screen's long idle stretches, read as sleep (docs/one-input.md §5.1 ①). */
function screenSource(ctx: AccessContext, hourOf: (iso: string) => number): EnergySource {
  const on = getStore().getSetting(ctx.workspaceId, SLEEP_TRACKING_CONSENT) === "granted";
  return { id: "screen-activity", sleep: () => on ? sleepFromGaps(read(getStore().getSetting(ctx.workspaceId, LONG_GAPS_SETTING), [] as Array<{ from: string; to: string }>), hourOf) : [] };
}
/** What the person's phone sent (③): sleep episodes, nights from its bed and wake moments, and per-day heart-rate readings. */
function phoneSource(ctx: AccessContext): EnergySource {
  const store = getStore();
  if (!phoneHealthOn(ctx.workspaceId)) return { id: "ios-health", sleep: () => [], physiology: () => [] };
  return { id: "ios-health", sleep: () => [...read(store.getSetting(ctx.workspaceId, HEALTH_SLEEP_SETTING), [] as SleepEpisode[]),
      ...sleepFromPhoneEvents(read(store.getSetting(ctx.workspaceId, HEALTH_EVENTS_SETTING), [] as PhoneSleepEvent[]))],
    physiology: () => read(store.getSetting(ctx.workspaceId, HEALTH_DAILY_SETTING), [] as DailyPhysiology[]) };
}

export type EnergyModel = {
  episodes: SleepEpisode[]; calibration: EnergyCalibration; phaseShift: number;
  hourOf: (iso: string) => number;
  predict: (at: string) => EnergyPrediction;
  /** How much of the person's local `day` can be filled (only ever below 1), from sleep debt and the phone's readings. */
  capacity: (at: string, day: string) => DayCapacity;
  /** When the person last said how they are, ISO, or "". */
  lastReportAt: string;
  /**
   * Each optional signal the person turned on, with its backtest: only an `enabled` one moves anything — a reading of now (`use: "now"`),
   * or, for the phone's daily steps and daylight, only the day's capacity, and only downwards (`use: "capacity"`).
   */
  covariates: Array<CovariateVerdict & { label: string; use: "now" | "capacity" }>;
};

type Signal = { id: string; label: string; valueAt: (at: string) => number | undefined; use: "now" | "capacity"; daily?: DailyActivityId };

/**
 * The optional signals (docs/energy-and-ecosystem.md §8), each read only with its own consent: the input rhythm over the hour before a
 * moment, and the camera's last window within half an hour before it. Both exist only for the past, so they can move a reading of now and
 * never one of a later slot.
 */
function optionalSignals(ctx: AccessContext, physiology: DailyPhysiology[], dayOf: (iso: string) => string): Signal[] {
  const store = getStore(), ws = ctx.workspaceId;
  const signals: Signal[] = [];
  if (store.getSetting(ws, INPUT_RHYTHM_CONSENT) === "granted") {
    const buckets = read(store.getSetting(ws, INPUT_RHYTHM_BUCKETS), [] as InputRhythmBucket[]);
    signals.push({ id: "input.fragmentation", label: "键鼠停顿", use: "now", valueAt: (at) => inputRhythmAt(buckets, at)?.fragmentation },
      { id: "input.pointer", label: "鼠标移动", use: "now", valueAt: (at) => inputRhythmAt(buckets, at)?.pointerPace });
  }
  if (store.getSetting(ws, CAMERA_ENERGY_CONSENT) === "granted") {
    const windows = store.listEnergyObservations(ws).filter((item) => item.source === "camera_aggregate");
    const near = (at: string) => windows.find((item) => item.observedAt <= at && Date.parse(at) - Date.parse(item.observedAt) <= 30 * 60_000);
    signals.push({ id: "camera.perclos", label: "闭眼比例", use: "now", valueAt: (at) => near(at)?.aggregate.perclos },
      { id: "camera.blinks", label: "眨眼频率", use: "now", valueAt: (at) => near(at)?.aggregate.blinkRate },
      { id: "camera.pulse", label: "心率", use: "now", valueAt: (at) => { const item = near(at); return item && (item.aggregate.quality ?? 0) >= 0.4 ? item.aggregate.heartRate : undefined; } });
  }
  // The phone's steps and minutes in daylight (2026-10-20), under 手机健康数据: the figures filed under a report's local day, judged on
  // the same reports; one admitted lowers only that day's capacity (`dayCapacity`), never a reading.
  if (phoneHealthOn(ws)) {
    const byDay = new Map(physiology.map((item) => [item.day, item]));
    signals.push({ id: "phone.steps", label: "步数", use: "capacity", daily: "steps", valueAt: (at) => byDay.get(dayOf(at))?.steps },
      { id: "phone.daylight", label: "日照", use: "capacity", daily: "daylightMin", valueAt: (at) => byDay.get(dayOf(at))?.daylightMin });
  }
  return signals;
}

/**
 * The person's energy model as of now: sleep from every source (a phone's record wins over the screen's guess), the circadian peak
 * moved to their own high-energy hours, and the cut points calibrated by every L/M/H they reported at a time whose last sleep is known.
 */
export function energyModel(ctx: AccessContext, windows: AvailabilityWindow[]): EnergyModel {
  const store = getStore();
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const hourOf = (iso: string) => { const [h, m] = formatInTimeZone(new Date(iso), zone, "HH:mm").split(":").map(Number); return (h ?? 0) + (m ?? 0) / 60; };
  const phone = phoneSource(ctx);
  const episodes = mergeSleep(screenSource(ctx, hourOf).sleep(), phone.sleep());
  // The circadian peak sits where the person said their best hours are (the high-energy windows of the availability pattern).
  const peak = windows.find((window) => window.energy === "high");
  const toHour = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) + (m ?? 0) / 60; };
  const phaseShift = peak ? phaseShiftFromPeak(toHour(peak.start), toHour(peak.end)) : 0;
  const reports = store.listEnergyObservations(ctx.workspaceId).filter((item) => item.source === "self_report" && item.level !== "uncalibrated");
  const calibration = calibrate(reports.flatMap((report) => {
    const value = alertnessAt(report.observedAt, episodes, hourOf, phaseShift);
    return value === undefined ? [] : [{ alertness: value, level: report.level as EnergyLevel }];
  }));
  const lastReportAt = reports.map((report) => report.observedAt).sort().at(-1) ?? "";
  // Each optional signal judged on the person's own reports; only one the backtest admits moves a reading.
  const physiology = phone.physiology?.() ?? [];
  const signals = optionalSignals(ctx, physiology, (iso) => formatInTimeZone(new Date(iso), zone, "yyyy-MM-dd"));
  const covariates = signals.map((signal) => ({ label: signal.label, use: signal.use, ...judgeCovariate(signal.id, reports.flatMap((report) => {
    const value = alertnessAt(report.observedAt, episodes, hourOf, phaseShift);
    return value === undefined ? [] : [{ at: report.observedAt, alertness: value, level: report.level as EnergyLevel, value: signal.valueAt(report.observedAt) }];
  }), calibration) }));
  const predict = (at: string): EnergyPrediction => {
    const base = predictEnergy(at, episodes, calibration, hourOf, phaseShift);
    if (base.alertness === undefined) return base;
    let shift = 0;
    const used: string[] = [];
    for (const verdict of covariates) {
      const signal = signals.find((item) => item.id === verdict.id);
      if (!verdict.enabled || !verdict.fit || !signal || signal.use !== "now") continue;
      const moved = covariateShift(verdict.fit, signal.valueAt(at));
      if (moved !== 0) { shift += moved; used.push(verdict.label); }
    }
    if (!used.length) return base;
    const value = base.alertness + shift;
    const level: EnergyLevel = value < calibration.low ? "low" : value < calibration.high ? "medium" : "high";
    return { ...base, level, alertness: Math.round(value * 10) / 10, basis: [...base.basis, `按${used.join("、")}修正`] };
  };
  const admitted: AdmittedActivity = {};
  for (const verdict of covariates) {
    const daily = signals.find((item) => item.id === verdict.id)?.daily;
    if (daily && verdict.enabled && verdict.fit) admitted[daily] = verdict.fit.beta;
  }
  return { episodes, calibration, phaseShift, hourOf, lastReportAt, covariates, predict,
    capacity: (at, day) => dayCapacity(at, day, episodes, physiology, admitted) };
}

/** A slot's energy for the scheduler: the model's when it is at least moderately sure, the pattern's otherwise. */
export function slotEnergy(model: EnergyModel, startIso: string, fallback: EnergyLevel): EnergyLevel {
  const prediction = model.predict(startIso);
  return prediction.confidence === "low" ? fallback : prediction.level;
}

/**
 * A phone shortcut's token, one per kind of write: `health` may only send health summaries, `capture` may only write a line into the
 * box (Siri 「记一下」) — a leaked health token cannot create work. Made on request and shown once; only its hash is kept, so it can be
 * replaced but never read back. Replacing it cuts off the old shortcut at once.
 */
// `records` (docs/domain-lines.md) may only add money and health records through /api/records: payment notifications, a Wallet transaction.
// `recording` (docs/phone-recording.md) may only upload recordings for the server transcriber.
// `device` (docs/device-mode.md) may only send what a linked computer read on itself: activity aggregates, folder files' text, transcripts.
export type DeviceTokenScope = "health" | "capture" | "records" | "recording" | "device";
export const TOKEN_SETTING: Record<DeviceTokenScope, string> = { health: HEALTH_TOKEN_SETTING, capture: "capture.token.sha256", records: "records.token.sha256",
  recording: "recording.token.sha256", device: "device.token.sha256" };

export function issueDeviceToken(ctx: AccessContext, scope: DeviceTokenScope): string {
  const token = randomBytes(24).toString("base64url");
  getStore().setSetting(ctx.workspaceId, TOKEN_SETTING[scope], createHash("sha256").update(token).digest("hex"));
  // Making the health token is setting the phone up: it turns 手机健康数据 on, with no switch of its own to press first.
  if (scope === "health") getStore().setSetting(ctx.workspaceId, PHONE_HEALTH_CONSENT, "granted");
  return token;
}
export const issueHealthToken = (ctx: AccessContext) => issueDeviceToken(ctx, "health");

/** The workspace whose `scope` token this is, or undefined (compared in constant time). */
export function workspaceForDeviceToken(token: string, scope: DeviceTokenScope): string | undefined {
  const hash = createHash("sha256").update(token).digest();
  for (const workspace of getStore().listWorkspaces()) {
    const stored = getStore().getSetting(workspace.id, TOKEN_SETTING[scope]);
    if (stored && stored.length === 64 && timingSafeEqual(Buffer.from(stored, "hex"), hash)) return workspace.id;
  }
  return undefined;
}
export const workspaceForHealthToken = (token: string) => workspaceForDeviceToken(token, "health");

/**
 * What a phone sent: sleep episodes (ISO start and end), bed and wake moments, and the day's readings (heart-rate variability, resting
 * heart rate, wrist temperature against its own baseline, steps, minutes in daylight), kept as summaries for the last 30 days. An Android
 * phone sends the same shape with `source: "android-health"`. Anything malformed or out of range is dropped, not stored; nothing finer
 * than one episode, one moment or one day is kept.
 */
export function storeHealthSummary(workspaceId: string, input: { sleep?: unknown; events?: unknown; source?: unknown; hrvMs?: unknown; restingHr?: unknown;
  wristTempDeltaC?: unknown; steps?: unknown; daylightMin?: unknown; day?: unknown }): { stored: number } {
  const store = getStore();
  const iso = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  const source = input.source === "android-health" ? "android-health" : "ios-health";
  const incoming = (Array.isArray(input.sleep) ? input.sleep : []).flatMap((raw) => {
    const item = raw as { start?: unknown; end?: unknown };
    const start = iso(item?.start), end = iso(item?.end);
    const hours = start && end ? (Date.parse(end) - Date.parse(start)) / 3_600_000 : 0;
    return start && end && hours > 0.5 && hours < 16 ? [{ sleepAt: start, wakeAt: end, source }] : [];
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
  const events = (Array.isArray(input.events) ? input.events : []).flatMap((raw) => {
    const item = raw as { type?: unknown; at?: unknown };
    const at = iso(item?.at);
    return at && (item.type === "bed" || item.type === "wake") ? [{ type: item.type, at } as PhoneSleepEvent] : [];
  });
  if (events.length) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const kept = read(store.getSetting(workspaceId, HEALTH_EVENTS_SETTING), [] as PhoneSleepEvent[])
      .filter((old) => !events.some((item) => item.type === old.type && item.at === old.at));
    store.setSetting(workspaceId, HEALTH_EVENTS_SETTING, JSON.stringify([...kept, ...events].filter((item) => item.at >= since)
      .sort((a, b) => a.at.localeCompare(b.at)).slice(-120)));
  }
  const day = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : undefined;
  // Each reading only within the range a real one falls in.
  const within = (value: unknown, low: number, high: number, digits = 0) => {
    const number = Number(value);
    return value !== undefined && value !== null && value !== "" && Number.isFinite(number) && number > low && number < high
      ? Math.round(number * 10 ** digits) / 10 ** digits : undefined;
  };
  const readings: Omit<DailyPhysiology, "day"> = Object.fromEntries(Object.entries({
    hrvMs: within(input.hrvMs, 0, 400), restingHr: within(input.restingHr, 20, 200), wristTempDeltaC: within(input.wristTempDeltaC, -3, 3, 2),
    steps: within(input.steps, -1, 100_000), daylightMin: within(input.daylightMin, -1, 1_440)
  }).filter(([, value]) => value !== undefined));
  if (day && Object.keys(readings).length) {
    const daily = read(store.getSetting(workspaceId, HEALTH_DAILY_SETTING), [] as DailyPhysiology[]);
    const entry = { ...daily.find((item) => item.day === day), day, ...readings };
    store.setSetting(workspaceId, HEALTH_DAILY_SETTING, JSON.stringify([...daily.filter((item) => item.day !== day), entry]
      .sort((a, b) => a.day.localeCompare(b.day)).slice(-30)));
  }
  return { stored: merged.length + events.length };
}
