/**
 * Capacity is reported on the same coarse scale a person would use about themselves, and never as a
 * number. The literature that supports inferring effort from interaction data supports a two-to-three
 * level, personalised, relative-to-own-baseline classification — the high-accuracy figures in that
 * literature come from clinical diagnosis, which this project does not do. So: three levels or
 * `uncalibrated`, always with what it was derived from and what is still missing.
 */
export type CapacityLevel = "low" | "medium" | "high" | "uncalibrated";
export type CapacityBasis = "self_report" | "execution_history" | "local_activity";

export type CapacityReading = {
  level: CapacityLevel;
  confidence?: "low" | "medium" | "high";
  observationCount: number;
  basis: CapacityBasis[];
  blockers: Array<{ code: string; message: string }>;
};

export type CapacityInput = {
  now: string;
  selfReports: Array<{ level: "low" | "medium" | "high"; confidence: "low" | "medium" | "high"; observedAt: string }>;
  /** One row per day of local activity, aggregate only — never a raw event stream. */
  dailyActivity: Array<{ day: string; activeMinutes: number; windowSwitches: number }>;
  /** Interruptions per active hour, from real executions. Corroborates; never classifies alone. */
  interruptionDensity: Array<{ day: string; perActiveHour: number }>;
  localActivityConsent: "granted" | "denied" | "unasked";
};

/** A self-report older than this says how the day started, not how it is now. */
const SELF_REPORT_FRESH_MINUTES = 240;
/** Fewer days than this cannot describe a personal baseline, so activity classifies nothing. */
export const BASELINE_DAYS = 14;

const tercile = (values: number[], value: number): "low" | "medium" | "high" => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
  if (value <= at(1 / 3)) return "low";
  if (value >= at(2 / 3)) return "high";
  return "medium";
};

export function deriveCapacity(input: CapacityInput): CapacityReading {
  const observationCount = input.selfReports.length + input.dailyActivity.length;
  const blockers: Array<{ code: string; message: string }> = [];

  // A person saying how they feel outranks anything inferred about them.
  const freshest = [...input.selfReports].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  if (freshest && Date.parse(input.now) - Date.parse(freshest.observedAt) <= SELF_REPORT_FRESH_MINUTES * 60_000) {
    return { level: freshest.level, confidence: freshest.confidence, observationCount, basis: ["self_report"], blockers };
  }

  if (input.localActivityConsent !== "granted") {
    blockers.push({ code: "LOCAL_ACTIVITY_NOT_AUTHORISED", message: "本机活动采集未开启；开启后可在没有自评时给出参考读数。" });
    return { level: "uncalibrated", observationCount, basis: [], blockers };
  }

  const [today, ...baseline] = [...input.dailyActivity].sort((a, b) => b.day.localeCompare(a.day));
  if (!today || baseline.length < BASELINE_DAYS) {
    blockers.push({
      code: "BASELINE_INSUFFICIENT",
      message: `需要至少 ${BASELINE_DAYS} 天本机活动观测才能与你自己的基线比较（当前 ${baseline.length} 天）。`
    });
    return { level: "uncalibrated", observationCount, basis: [], blockers };
  }

  const level = tercile(baseline.map((day) => day.activeMinutes), today.activeMinutes);
  const basis: CapacityBasis[] = ["local_activity"];

  // Real interruption data can only corroborate a level that activity already produced.
  const densityToday = input.interruptionDensity.find((day) => day.day === today.day);
  const densityBaseline = input.interruptionDensity.filter((day) => day.day !== today.day);
  let confidence: "low" | "medium" | "high" = "low";
  if (densityToday && densityBaseline.length >= BASELINE_DAYS) {
    const densityLevel = tercile(densityBaseline.map((day) => day.perActiveHour), densityToday.perActiveHour);
    // More interruptions than usual points the same way as less activity than usual.
    const agrees = (level === "low" && densityLevel === "high") || (level === "high" && densityLevel === "low");
    basis.push("execution_history");
    if (agrees) confidence = "medium";
  }
  return { level, confidence, observationCount, basis, blockers };
}
