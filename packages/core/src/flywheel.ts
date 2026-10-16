import { allowDiscretionarySpend, type CostSignal, type SpendPolicy } from "./cost";
import { tFor, type Locale } from "./i18n";

/**
 * When the nightly expansion may run.
 *
 * The window is anchored to the runtime's real reset time rather than a fixed hour: the quota window
 * rolls, so its reset drifts, and a hard-coded 3am lands before the reset about as often as after it.
 * Taking the earliest reset inside the night window leaves the rest of the night for the quota to
 * recover before the person sits down.
 */
export type NightWindow = { startHour: number; endHour: number };

export type NightlyTrigger =
  | { run: true; plannedAt: string; headroomPercent: number; mode: "normal" | "economy" | "manual_core_only" }
  | { run: false; code: string; message: string };

export type NightlyInput = {
  now: string;
  /** Unix seconds, as the runtime reports resets. */
  resetsAt: number[];
  night: NightWindow;
  cost: CostSignal;
  spend: SpendPolicy;
  /** Milliseconds since the last local input; absent when collection is off. */
  idleMs?: number;
  /** Below this the person is still using the machine, so the run defers. */
  idleRequiredMs: number;
  /** Already ran for this local date. */
  lastRunDay?: string;
  timeZoneOffsetMinutes: number;
  /** The language the skip reason is written in (shown on the review page's nightly status). */
  locale?: Locale;
};

const GRACE_MINUTES = 5;

const localParts = (epochMs: number, offsetMinutes: number) => {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
};

export function nightlyTrigger(input: NightlyInput): NightlyTrigger {
  const t = tFor(input.locale);
  const nowMs = Date.parse(input.now);
  const today = localParts(nowMs, input.timeZoneOffsetMinutes).day;
  if (input.lastRunDay === today) {
    return { run: false, code: "ALREADY_RAN_TODAY", message: t("今晚已经跑过一次扩展。") };
  }

  // An unreadable signal is reported as itself. Checking the window first would blame "no reset
  // tonight", which is a consequence of having no reading rather than the reason, and would send
  // anyone debugging it to the wrong place.
  if (!input.cost.available) {
    return { run: false, code: "COST_SIGNAL_UNAVAILABLE", message: t("读不到成本信号，今晚不运行：{{reason}}", { reason: input.cost.reason }) };
  }

  // Earliest reset that falls inside tonight's window, plus a short grace for the runtime to settle.
  const candidates = input.resetsAt
    .map((seconds) => seconds * 1000 + GRACE_MINUTES * 60_000)
    .filter((at) => {
      const local = localParts(at, input.timeZoneOffsetMinutes);
      return local.day === today && local.hour >= input.night.startHour && local.hour < input.night.endHour;
    })
    .sort((a, b) => a - b);
  const plannedAt = candidates[0];
  if (plannedAt === undefined) {
    return { run: false, code: "NO_RESET_IN_NIGHT_WINDOW", message: t("今晚窗口内没有配额刷新，本次不运行。") };
  }
  if (nowMs < plannedAt) {
    return { run: false, code: "BEFORE_PLANNED_TIME", message: t("还没到今晚的运行时刻。") };
  }

  // Collection being off is not a reason to skip; it only means the activity check cannot be made.
  if (input.idleMs !== undefined && input.idleMs < input.idleRequiredMs) {
    return { run: false, code: "USER_ACTIVE", message: t("电脑正在使用中，稍后重试，避免占用当前额度。") };
  }

  const decision = allowDiscretionarySpend(input.cost, input.spend, input.locale);
  if (!decision.allowed) return { run: false, code: decision.code, message: decision.message };
  return { run: true, plannedAt: new Date(plannedAt).toISOString(), headroomPercent: decision.headroomPercent, mode: decision.mode };
}

/**
 * Candidate relations, ranked by things that can be counted rather than by a model's opinion.
 *
 * A model ordering its own suggestions by "value" is a score driving a decision, which this system
 * does not do. Every field below is observed: whether the target has stalled, whether the work is
 * already done, whether anyone recorded a counterexample, and what it has cost so far.
 */
export type CandidateRelation = {
  id: string;
  targetMilestoneId: string;
  reusesExistingArtifact: boolean;
  counterexampleCount: number;
  costMinutes: number | null;
  targetStalledDays: number;
  createdAt: string;
  hasEvidence: boolean;
};

export type RankedCandidates = {
  highlighted: CandidateRelation[];
  kept: CandidateRelation[];
  archived: CandidateRelation[];
};

export function rankCandidates(candidates: CandidateRelation[], poolSize = 10, highlightCount = 3): RankedCandidates {
  const score = (candidate: CandidateRelation) => [
    candidate.counterexampleCount > 0 ? 1 : 0,          // a refuted-looking relation sinks
    candidate.targetStalledDays > 0 ? 0 : 1,            // stalled targets need outside help most
    candidate.reusesExistingArtifact ? 0 : 1,           // reuse costs nothing new
    -(candidate.targetStalledDays),                     // longer stall first
    candidate.costMinutes ?? Number.POSITIVE_INFINITY   // cheaper first; unknown cost last
  ];
  const ordered = [...candidates].sort((a, b) => {
    const left = score(a);
    const right = score(b);
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i]! - right[i]!;
    }
    return a.id.localeCompare(b.id);
  });
  const kept = ordered.slice(0, poolSize);
  // The pool is capped so it cannot become a second inbox; the oldest evidence-less ones go first.
  const overflow = ordered.slice(poolSize);
  const archived = [...overflow].sort((a, b) =>
    Number(a.hasEvidence) - Number(b.hasEvidence) || a.createdAt.localeCompare(b.createdAt));
  return { highlighted: kept.slice(0, highlightCount), kept, archived };
}

/** A mainline with no milestone passed in a while. Surfaced as a prompt; it never spends anything. */
export function stalledIdentities(
  input: Array<{ identityId: string; daysSinceLastPass: number | null }>,
  thresholdDays: number
): Array<{ identityId: string; daysSinceLastPass: number }> {
  return input
    .filter((item): item is { identityId: string; daysSinceLastPass: number } =>
      item.daysSinceLastPass !== null && item.daysSinceLastPass >= thresholdDays)
    .sort((a, b) => b.daysSinceLastPass - a.daysSinceLastPass);
}
