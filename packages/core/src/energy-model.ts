/**
 * Energy without asking every time (docs/one-input.md §5, docs/energy-and-ecosystem.md §3). A biomathematical prior — the three-process
 * model of alertness (Åkerstedt, Folkard & Portin 2004): a homeostatic term S that falls with time awake and recovers with sleep, carried
 * across the last fourteen nights so short nights add up; a 24-hour circadian cosine C; a 12-hour ultradian term U (the afternoon dip);
 * and sleep inertia W in the first hours after waking — driven by when the person slept and woke, read from where it is known (the
 * screen's long idle stretches, a phone's sleep record), then calibrated to the person by their own L/M/H reports. It says how sure it is;
 * below `medium` the schedule does not use it and the person is asked instead. Separately, a day's capacity (how much, not when) comes
 * from the sleep debt and the phone's heart-rate readings against the person's own baseline, and can only lower what the day holds.
 */

import type { EnergyLevel } from "./index";
import { tFor, type Locale } from "./i18n";

export type SleepEpisode = { sleepAt: string; wakeAt: string; source: string };

/**
 * 作息记录, its own consent (decided 2026-10-10: not folded into the activity aggregate). Off unless the person turns it on; off means
 * nothing is kept, and what was kept is deleted.
 */
export const SLEEP_TRACKING_CONSENT = "activity.sleepTracking";
export const ACTIVITY_LAST_ACTIVE = "activity.lastActiveAt";
export const ACTIVITY_LONG_GAPS = "activity.longGaps";
/**
 * 手机健康数据, its own consent (decided 2026-10-20): what a phone's shortcut sends (sleep, bed and wake moments, the day's heart-rate,
 * temperature, steps and daylight). Generating the health token turns it on, since that is the person setting the shortcut up; an
 * account that had a token before this consent existed counts as on. Off deletes what was kept and the token.
 */
export const PHONE_HEALTH_CONSENT = "health.phone";
export const phoneHealthGranted = (consent: string | null | undefined, hasToken: boolean) => consent === "granted" || (!consent && hasToken);

/** One day's readings from a phone or watch: heart-rate variability, resting heart rate, wrist temperature against its own baseline. */
export type DailyPhysiology = { day: string; hrvMs?: number; restingHr?: number; wristTempDeltaC?: number; steps?: number; daylightMin?: number };

/** Where sleep comes from: the screen's idle gaps, a phone's health record, later a ring or watch. */
export interface EnergySource {
  id: string;
  /** Sleep episodes known for the days around `day` (ISO instants). */
  sleep(): SleepEpisode[];
  /** Per-day physiology when the source has it. */
  physiology?(): DailyPhysiology[];
}

// Three-process model constants, as published in Åkerstedt, Folkard & Portin 2004 (Aviat Space Environ Med 75(3) A75–A83):
// S = (Sa − L)·e^(−0.0353t) + L awake; S′ = U − (U − Sr)·e^(−0.381t) asleep, recovering no faster below 12.5 than at 12.5;
// C = 2.5·cos(2π(t − p)/24); W = −5.7·e^(−kt) after waking.
// Two terms differ from the paper (2026-11-11, docs/energy-and-ecosystem.md §2.1), because with the published ones a usual day had no
// afternoon dip at all — alertness rose from waking to a single peak at 17:00:
// - the ultradian term U (12-hour period) has amplitude 1.5, not 0.5, with its trough 1.8 h before C's peak (15:00 on a 23:30–7:30
//   night), not 3 h: that gives the mid-afternoon dip in sleep propensity (Monk 2005; Carskadon & Dement 1992) and, at its crest six
//   hours later, the evening wake-maintenance zone 1–3 h before habitual bedtime (Strogatz 1987);
// - W fades with Jewett et al. 1999's time constant for cognitive throughput, 1.17 h (k = 0.855/h), not the paper's 1.52 h, which the
//   paper kept out of its fitted predictions anyway.
const S_LOWER = 2.4, S_UPPER = 14.3, AWAKE_DECAY = 0.0353, SLEEP_RECOVERY = 0.381, C_AMPLITUDE = 2.5, C_ACROPHASE = 16.8;
const S_CRITICAL = 12.5, U_AMPLITUDE = 1.5, U_LEAD = 1.8, W_INIT = 5.7, W_DECAY = 1 / 1.17;
const HOUR = 3_600_000;
/** How far back the homeostat is carried. */
const HISTORY_DAYS = 14;

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

/** A moment the phone noticed: the person went to bed (sleep focus on, 「就寝开始」) or got up (an alarm stopped, 「醒来」). */
export type PhoneSleepEvent = { type: "bed" | "wake"; at: string };

/**
 * Nights from the phone's bed and wake moments: each wake paired with the last bed moment 3–14 hours before it. A wake with no bed
 * moment is not a night — the screen's idle stretch, or nothing, tells when that sleep began.
 */
export function sleepFromPhoneEvents(events: PhoneSleepEvent[]): SleepEpisode[] {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.flatMap((event, index) => {
    if (event.type !== "wake") return [];
    const bed = sorted.slice(0, index).reverse().find((item) => item.type === "bed");
    const hours = bed ? (Date.parse(event.at) - Date.parse(bed.at)) / HOUR : 0;
    return bed && hours >= 3 && hours <= 14 ? [{ sleepAt: bed.at, wakeAt: event.at, source: "phone-focus" }] : [];
  });
}

/**
 * Several sources, one night each: what a phone's health record says wins over the phone's sleep-focus switch, which wins over the
 * screen's guess for the same night — and what the person said about that night (`self_report`, through the input box) wins over all.
 */
const SOURCE_RANK: Record<string, number> = { screen: 0, "phone-focus": 1, self_report: 3 };
/**
 * Nights the person reported in the input box (「昨晚一点睡、八点起」), the last 60. Read whatever the phone or screen consents say: it
 * is the person's own word, not a device's reading.
 */
export const SELF_SLEEP_SETTING = "energy.sleepReports";
export function readSelfSleep(raw: string | null | undefined): SleepEpisode[] {
  try {
    const value = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is SleepEpisode => Boolean(item) && typeof item.sleepAt === "string" && typeof item.wakeAt === "string")
      .map((item) => ({ sleepAt: item.sleepAt, wakeAt: item.wakeAt, source: "self_report" })) : [];
  } catch { return []; }
}
export function mergeSleep(...sources: SleepEpisode[][]): SleepEpisode[] {
  const rank = (episode: SleepEpisode) => SOURCE_RANK[episode.source] ?? 2;
  const byWake = new Map<string, SleepEpisode>();
  for (const episode of sources.flat()) {
    const night = new Date(Date.parse(episode.wakeAt) - 12 * HOUR).toISOString().slice(0, 10);
    const existing = byWake.get(night);
    if (!existing || rank(episode) > rank(existing)) byWake.set(night, episode);
  }
  return [...byWake.values()].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt));
}

/** S after `hours` awake. */
const decayAwake = (s: number, hours: number) => S_LOWER + (s - S_LOWER) * Math.exp(-AWAKE_DECAY * hours);
/** S after `hours` asleep: below the critical level it recovers at the rate it has at that level, then exponentially towards the top. */
function recoverAsleep(s: number, hours: number): number {
  let left = hours, value = s;
  if (value < S_CRITICAL) {
    const rate = SLEEP_RECOVERY * (S_UPPER - S_CRITICAL);
    const toCritical = (S_CRITICAL - value) / rate;
    if (left <= toCritical) return value + rate * left;
    left -= toCritical;
    value = S_CRITICAL;
  }
  return S_UPPER - (S_UPPER - value) * Math.exp(-SLEEP_RECOVERY * left);
}

/**
 * S at `at`, carried through the known sleep of the last fourteen days. Before the first record the person is taken as rested on a usual
 * rhythm. A stretch between two records too long to have been spent awake (over 30 hours — a weekend away from the computer, a phone left
 * off) is not invented as an all-nighter: each missing night is taken as a usual one, and counted in `assumedNights` so the basis says so.
 */
export function homeostat(at: string, episodes: SleepEpisode[]): { s: number; assumedNights: number } {
  const end = Date.parse(at), start = end - HISTORY_DAYS * 24 * HOUR;
  const within = episodes.filter((episode) => Date.parse(episode.wakeAt) > start && Date.parse(episode.sleepAt) < end)
    .sort((a, b) => a.sleepAt.localeCompare(b.sleepAt));
  let s = RESTED_WAKE, assumedNights = 0;
  let clock = within.length ? Math.max(start, Date.parse(within[0]!.sleepAt) - USUAL_AWAKE_HOURS * HOUR) : end - USUAL_AWAKE_HOURS * HOUR;
  const awakeFor = (hours: number) => {
    let left = hours;
    while (left > MAX_AWAKE_HOURS) {
      s = recoverAsleep(decayAwake(s, USUAL_AWAKE_HOURS), 24 - USUAL_AWAKE_HOURS);
      left -= 24;
      assumedNights += 1;
    }
    s = decayAwake(s, Math.max(0, left));
  };
  for (const episode of within) {
    const sleepAt = Math.max(clock, Date.parse(episode.sleepAt)), wakeAt = Math.min(end, Date.parse(episode.wakeAt));
    if (wakeAt <= clock) continue;
    awakeFor((sleepAt - clock) / HOUR);
    s = recoverAsleep(s, Math.max(0, wakeAt - sleepAt) / HOUR);
    clock = wakeAt;
  }
  awakeFor((end - clock) / HOUR);
  return { s, assumedNights };
}
const MAX_AWAKE_HOURS = 30;
const USUAL_AWAKE_HOURS = 16;
/** The steady wake level of eight hours' sleep after sixteen awake (the fixed point of one usual day). */
const RESTED_WAKE = (() => {
  let s = 13;
  for (let day = 0; day < 30; day += 1) s = recoverAsleep(decayAwake(s, USUAL_AWAKE_HOURS), 8);
  return s;
})();

/** The rhythm terms at a local hour: the circadian cosine and the ultradian afternoon dip, both shifted for an early or late person. */
function rhythm(localHour: number, phaseShift: number): number {
  const peak = C_ACROPHASE + phaseShift;
  const c = C_AMPLITUDE * Math.cos((2 * Math.PI * (localHour - peak)) / 24);
  const u = -U_AMPLITUDE * Math.cos((2 * Math.PI * (localHour - (peak - U_LEAD))) / 12);
  return c + u;
}
/** Sleep inertia: how much lower alertness stands `hoursAwake` after waking. */
export const inertia = (hoursAwake: number): number => -W_INIT * Math.exp(-W_DECAY * Math.max(0, hoursAwake));

/**
 * Alertness at `at` on the model's scale (about 3–17): S carried across the recorded nights, the rhythm terms at the local hour (shifted
 * by `phaseShift` hours for an early or late person) and sleep inertia since the last waking. Undefined when the last sleep is unknown.
 */
export function alertnessAt(at: string, episodes: SleepEpisode[], localHourOf: (iso: string) => number, phaseShift = 0): number | undefined {
  const last = lastSleepBefore(episodes, at);
  if (!last) return undefined;
  const awake = (Date.parse(at) - Date.parse(last.wakeAt)) / HOUR;
  return homeostat(at, episodes).s + rhythm(localHourOf(at), phaseShift) + inertia(awake);
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
  phaseShift = 0, locale?: Locale): EnergyPrediction {
  const t = tFor(locale);
  const episode = lastSleepBefore(episodes, at);
  const value = alertnessAt(at, episodes, localHourOf, phaseShift);
  if (!episode || value === undefined) return { level: "medium", confidence: "low", basis: [t("不知道最近一次睡眠")] };
  const level: EnergyLevel = value < calibration.low ? "low" : value < calibration.high ? "medium" : "high";
  const awake = (Date.parse(at) - Date.parse(episode.wakeAt)) / HOUR;
  const slept = (Date.parse(episode.wakeAt) - Date.parse(episode.sleepAt)) / HOUR;
  const confidence = calibration.reports >= 8 && calibration.agreement >= 0.7 ? "high"
    : calibration.reports >= 4 && calibration.agreement >= 0.6 ? "medium" : "low";
  const debt = sleepDebt(at, episodes);
  return { level, confidence, alertness: Math.round(value * 10) / 10,
    basis: [t("睡了约 {{hours}} 小时（{{source}}）", { hours: slept.toFixed(1), source: t(SOURCE_LABEL[episode.source] ?? "手机记录") }),
      t("已醒 {{hours}} 小时", { hours: awake.toFixed(1) }),
      ...(awake < 1 ? [t("刚醒不久，头一小时偏低")] : []),
      ...(debt.nights >= 3 && debt.hours >= 2 ? [t("近两周少睡约 {{hours}} 小时", { hours: Math.round(debt.hours) })] : []),
      calibration.reports ? t("按本人 {{count}} 次自评校准", { count: calibration.reports }) : t("尚无自评，用通用曲线")] };
}
const SOURCE_LABEL: Record<string, string> = { screen: "由电脑空闲推断", "phone-focus": "手机睡眠模式" };

/**
 * The person's sleep need: the upper quartile of the nights on record (the nights they could sleep as long as they needed), between 7 and
 * 9.5 hours; 8 until there are seven nights. The median would understate it for anyone short of sleep through the week.
 */
export function sleepNeed(episodes: SleepEpisode[]): number {
  const hours = episodes.map((episode) => (Date.parse(episode.wakeAt) - Date.parse(episode.sleepAt)) / HOUR).filter((value) => value >= 3 && value <= 14)
    .sort((a, b) => a - b);
  if (hours.length < 7) return 8;
  return Math.max(7, Math.min(9.5, hours[Math.floor(hours.length * 0.75)]!));
}

/**
 * Sleep debt over the last fourteen recorded nights (RISE's weighting: last night 15%, the thirteen before 85% with the more recent
 * counting more): `perNight` is the weighted shortfall in hours a night, `hours` the plain total of shortfall less surplus. Nights not on
 * record are left out, never taken as short.
 */
export function sleepDebt(at: string, episodes: SleepEpisode[], need = sleepNeed(episodes)): { hours: number; perNight: number; nights: number } {
  const end = Date.parse(at);
  const nights = episodes.filter((episode) => Date.parse(episode.wakeAt) <= end && end - Date.parse(episode.wakeAt) < HISTORY_DAYS * 24 * HOUR)
    .sort((a, b) => b.wakeAt.localeCompare(a.wakeAt));
  if (!nights.length) return { hours: 0, perNight: 0, nights: 0 };
  const short = nights.map((episode) => need - (Date.parse(episode.wakeAt) - Date.parse(episode.sleepAt)) / HOUR);
  // Last night 0.15; the rest share 0.85, each 0.85 of the one after it.
  const rest = short.slice(1).map((_, index) => Math.pow(0.85, index));
  const restSum = rest.reduce((sum, weight) => sum + weight, 0) || 1;
  const weights = [short.length > 1 ? 0.15 : 1, ...rest.map((weight) => 0.85 * weight / restSum)];
  const perNight = short.reduce((sum, value, index) => sum + value * weights[index]!, 0);
  return { hours: Math.max(0, short.reduce((sum, value) => sum + value, 0)), perNight, nights: nights.length };
}

export type DayCapacity = { multiplier: number; basis: string[] };

/**
 * The phone's daily activity readings that may lower capacity (decided 2026-10-20), each only once its covariate has passed the rolling
 * backtest on the person's own reports (`judgeCovariate`): the value is the fitted coefficient, whose sign says which way the reading
 * moves the person's energy. Absent means not admitted.
 */
export type DailyActivityId = "steps" | "daylightMin";
export type AdmittedActivity = Partial<Record<DailyActivityId, number>>;
const ACTIVITY_LABEL: Record<DailyActivityId, [string, string]> = { steps: ["步数低于本人近期水平", "步数高于本人近期水平"],
  daylightMin: ["日照少于本人近期水平", "日照多于本人近期水平"] };

/**
 * How much of the day can be filled, as a multiplier on the day's share (decided 2026-10-14, docs/energy-and-ecosystem.md §3.3): it
 * only ever lowers, and only on evidence — a weighted sleep shortfall over half an hour a night, heart-rate variability or resting heart
 * rate a standard deviation off the person's own 28-day baseline (four days of baseline before either counts), a wrist temperature half a
 * degree up, and the phone's steps and daylight once their backtest admits them (`admitted`). The sizes are priors, not fitted: each
 * costs at most a tenth, and the day keeps at least 70%.
 */
/** `day` is the person's local date (YYYY-MM-DD) the phone's readings are filed under. */
export function dayCapacity(at: string, day: string, episodes: SleepEpisode[], physiology: DailyPhysiology[], admitted: AdmittedActivity = {},
  locale?: Locale): DayCapacity {
  const t = tFor(locale);
  let multiplier = 1;
  const basis: string[] = [];
  const debt = sleepDebt(at, episodes);
  if (debt.nights >= 3 && debt.perNight > 0.5) {
    const cut = Math.min(0.15, 0.06 * (debt.perNight - 0.5));
    multiplier -= cut;
    basis.push(t("近两周平均每晚少睡 {{hours}} 小时", { hours: debt.perNight.toFixed(1) }));
  }
  const today = physiology.find((item) => item.day === day);
  const before = physiology.filter((item) => item.day < day && Date.parse(day) - Date.parse(item.day) <= 28 * 24 * HOUR);
  const zOf = (value: number | undefined, history: number[]) => {
    if (value === undefined || history.length < 4) return undefined;
    const mean = history.reduce((sum, item) => sum + item, 0) / history.length;
    const sd = Math.sqrt(history.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (history.length - 1));
    return sd > 0 ? (value - mean) / sd : undefined;
  };
  const hrvZ = zOf(today?.hrvMs !== undefined ? Math.log(today.hrvMs) : undefined,
    before.flatMap((item) => item.hrvMs !== undefined ? [Math.log(item.hrvMs)] : []));
  if (hrvZ !== undefined && hrvZ < -1) {
    multiplier -= Math.min(0.1, 0.05 * (-hrvZ));
    basis.push(t("心率变异性低于本人近期水平"));
  }
  const restingZ = zOf(today?.restingHr, before.flatMap((item) => item.restingHr !== undefined ? [item.restingHr] : []));
  if (restingZ !== undefined && restingZ > 1) {
    multiplier -= Math.min(0.1, 0.05 * restingZ);
    basis.push(t("静息心率高于本人近期水平"));
  }
  // Steps and daylight by the same rule, in the direction the person's own reports showed: only a day a standard deviation off their
  // baseline on the side that went with lower energy counts.
  for (const id of ["steps", "daylightMin"] as const) {
    const beta = admitted[id];
    if (!beta) continue;
    const z = zOf(today?.[id], before.flatMap((item) => item[id] !== undefined ? [item[id]!] : []));
    if (z === undefined || Math.abs(z) <= 1 || Math.sign(beta) * z >= 0) continue;
    multiplier -= Math.min(0.1, 0.05 * Math.abs(z));
    basis.push(t(ACTIVITY_LABEL[id][z < 0 ? 0 : 1]));
  }
  if (today?.wristTempDeltaC !== undefined && today.wristTempDeltaC >= 0.5) {
    multiplier -= 0.1;
    basis.push(t("手腕温度比平时高 {{delta}}°C", { delta: today.wristTempDeltaC.toFixed(1) }));
  }
  return { multiplier: Math.max(0.7, Math.round(multiplier * 100) / 100), basis };
}

/**
 * The middles of the default day's two good stretches (23:30–7:30, no shift): the late-morning peak and the early-evening one. Pinned by
 * energy-prior.test.ts against the curve itself.
 */
export const DEFAULT_PEAKS = [10.75, 19] as const;
const clampShift = (hours: number) => Math.max(-6, Math.min(6, hours));
const round2 = (hours: number) => Math.round(hours * 100) / 100;

/**
 * The person's stated best hours (「上午 9–12 点效率最高」) move the circadian phase so that the default day's nearer good stretch lands on
 * them: best hours of 9–12 barely move it, 7–10 move it earlier. Returns the shift in hours, bounded to ±6. (Until 2026-11-11 this
 * aimed C's acrophase, 16.8, at the window, which put anyone keeping the default 9–12 pattern at the −6 bound.)
 */
export function phaseShiftFromPeak(peakStartHour: number | undefined, peakEndHour: number | undefined): number {
  if (peakStartHour === undefined || peakEndHour === undefined) return 0;
  const mid = (peakStartHour + peakEndHour) / 2;
  const nearest = DEFAULT_PEAKS.reduce((best, peak) => Math.abs(mid - peak) < Math.abs(mid - best) ? peak : best, DEFAULT_PEAKS[0]);
  return round2(clampShift(mid - nearest));
}

/** The mid-sleep of the default night (23:30–7:30), where the published acrophase applies unshifted. */
export const DEFAULT_MID_SLEEP = 3.5;
/** A mid-sleep (local hours) as a phase shift from the default night's: 5:30 is +2, 1:00 is −2.5; bounded to ±6. */
export const phaseShiftFromMidSleep = (midSleep: number): number => round2(clampShift(((((midSleep - DEFAULT_MID_SLEEP) % 24) + 36) % 24) - 12));

/**
 * Mid-sleep on work-free days by age, decimal hours (Fischer, Lombardi, Marucci-Wellman & Roenneberg 2017, PLoS ONE 12(6):e0178782,
 * Table 1, all respondents, n = 53,689 US time-use diaries; each point the mean of the five single years around it, 80 the 80+ row). The
 * latest is around 19–20; it moves about an hour earlier by 30 and slowly after. The same shape as the European MCTQ data (Roenneberg et
 * al. 2004, Curr Biol 14:R1038), whose swing with age is larger.
 */
const MID_SLEEP_BY_AGE: ReadonlyArray<readonly [number, number]> = [
  [17, 4.44], [19, 4.66], [22, 4.43], [25, 4.01], [30, 3.71], [35, 3.40], [40, 3.34], [45, 3.21], [50, 3.13], [55, 3.07], [60, 3.01],
  [65, 2.94], [70, 2.90], [75, 2.87], [80, 2.83]
];
/** The same survey's mean over every age (3:26), within five minutes of the default night's mid-sleep. */
export const POPULATION_MID_SLEEP = 3.43;

/** The typical free-day mid-sleep at `age`, interpolated, held at the table's ends. */
export function typicalMidSleep(age: number): number {
  const first = MID_SLEEP_BY_AGE[0]!, last = MID_SLEEP_BY_AGE[MID_SLEEP_BY_AGE.length - 1]!;
  if (age <= first[0]) return first[1];
  if (age >= last[0]) return last[1];
  const upper = MID_SLEEP_BY_AGE.findIndex(([at]) => at >= age);
  const [a0, m0] = MID_SLEEP_BY_AGE[upper - 1]!, [a1, m1] = MID_SLEEP_BY_AGE[upper]!;
  return m0 + ((m1 - m0) * (age - a0)) / (a1 - a0);
}
/**
 * The phase an age alone suggests: its typical mid-sleep against the population's. Small next to how people of one age differ (the
 * survey's SD is about 2 h at every age), so any measured sleep timing or stated best hours outrank it.
 */
export const phaseShiftFromAge = (age: number): number => round2(typicalMidSleep(age) - POPULATION_MID_SLEEP);

/**
 * The birth date the person chose to give (Settings → 时间与提醒, optional, never asked again), `YYYY-MM-DD`: a plain setting, kept apart
 * from the registration forms' secret items. The day rather than only the year since 2026-11-11 (the owner's request, so the birthday can
 * be marked later); the energy prior still reads only the age from it.
 */
export const BIRTH_DATE_SETTING = "profile.birthDate";
/** The year alone, asked before 2026-11-11: still read for the age when no date was given since. */
export const BIRTH_YEAR_SETTING = "profile.birthYear";
/** What the person gave: the date, else a year kept from before the date was asked. */
export const birthOf = (get: (key: string) => string | null | undefined): string | undefined =>
  get(BIRTH_DATE_SETTING)?.trim() || get(BIRTH_YEAR_SETTING)?.trim() || undefined;

/** A real calendar day written `YYYY-MM-DD` (no 02-30). */
export function isCalendarDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const day = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === raw;
}

/**
 * Age in whole years on `now`'s day from a birth date (or a year kept from before), or undefined when none was given or it is not a
 * plausible adult's (14–100). A date counts the birthday: someone born 1996-12-01 is 29 on 2026-11-11.
 */
export function ageFromBirth(raw: string | null | undefined, now: string): number | undefined {
  const text = raw?.trim() ?? "";
  const today = new Date(now).toISOString().slice(0, 10);
  const age = isCalendarDate(text) ? Number(today.slice(0, 4)) - Number(text.slice(0, 4)) - (today.slice(5) < text.slice(5) ? 1 : 0)
    : /^\d{4}$/.test(text) ? Number(today.slice(0, 4)) - Number(text) : undefined;
  return age !== undefined && age >= 14 && age <= 100 ? age : undefined;
}

export type PhaseSource = "chronotype" | "sleep" | "stated" | "age" | "default";
/**
 * Where the prior's circadian phase comes from, the most personal first: the person's measured or stated sleep timing (MCTQ's MSF_sc, else
 * the usual night's mid-sleep), then their stated best hours, then their age, else the default adult's (0).
 */
export function priorPhase(input: { midSleep?: { hours: number; source: "chronotype" | "sleep" } | undefined;
  statedPeak?: { start: number; end: number } | null | undefined; age?: number | undefined }): { shift: number; source: PhaseSource } {
  if (input.midSleep) return { shift: phaseShiftFromMidSleep(input.midSleep.hours), source: input.midSleep.source };
  if (input.statedPeak) return { shift: phaseShiftFromPeak(input.statedPeak.start, input.statedPeak.end), source: "stated" };
  if (input.age !== undefined) return { shift: phaseShiftFromAge(input.age), source: "age" };
  return { shift: 0, source: "default" };
}

/** The default night moved with the phase, for a person whose own night is not known: the whole usual day shifts, not only C. */
export const shiftedDefaultNight = (shift: number) => ({ from: 23.5 + shift, to: 7.5 + shift });
