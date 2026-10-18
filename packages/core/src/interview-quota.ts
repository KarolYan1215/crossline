import type { CostSignal } from "./cost";

/**
 * Whether a ChatGPT account's quota will carry the interview to the end (2026-10-18: some testers sign in with a Free account). Nobody
 * publishes what a Free account's window holds, so it is measured: the interview page records the account's usage after each round
 * (`ONBOARDING_QUOTA_TRACE`), the usage a round costs is read off those readings, and the rounds still to go are projected against what
 * is left of the window. Until two readings exist a Free account is told plainly that the quota may not last; an account whose quota is
 * gone is told what to do next — Plus, or an invite code for the developer's model.
 */
export const ONBOARDING_QUOTA_TRACE = "onboarding.quotaTrace";
/** Rounds a full interview usually takes, start standard and portrait together (scripts/onboarding-eval.ts runs land at 10–14). */
export const INTERVIEW_ROUNDS_EXPECTED = 12;

export type QuotaReading = { round: number; at: string; long?: number; short?: number; longResetsAt?: number | null; shortResetsAt?: number | null };
export type InterviewQuotaVerdict = "ok" | "tight" | "insufficient" | "spent";
export type InterviewQuotaOutlook = {
  verdict: InterviewQuotaVerdict;
  /** One or two sentences for the person; empty when there is nothing to say. */
  message: string;
  /** Usage (percent of the window) one round has cost, when measured. */
  perRound?: number;
  /** Rounds the remaining quota is projected to carry, when measured. */
  roundsLeft?: number;
  remainingRounds: number;
};

/** Adds this round's reading, once per round; a window that reset starts the trace again. */
export function addQuotaReading(trace: QuotaReading[], reading: QuotaReading): QuotaReading[] {
  if (trace.some((item) => item.round === reading.round)) return trace;
  return [...trace, reading].sort((a, b) => a.round - b.round).slice(-30);
}

/** A reading from the account's quota, or undefined when it cannot be read. */
export function quotaReading(signal: CostSignal, round: number, at: string): QuotaReading | undefined {
  if (!signal.available) return undefined;
  if (!signal.long && !signal.short) return undefined;
  return { round, at, ...(signal.long ? { long: signal.long.usedPercent, longResetsAt: signal.long.resetsAt } : {}),
    ...(signal.short ? { short: signal.short.usedPercent, shortResetsAt: signal.short.resetsAt } : {}) };
}

/** What one round costs of the window that binds (the long one when the account has it): the median rise between readings in one window. */
export function perRoundCost(trace: QuotaReading[]): { window: "long" | "short"; cost: number } | undefined {
  for (const window of ["long", "short"] as const) {
    const rises: number[] = [];
    for (let index = 1; index < trace.length; index += 1) {
      const before = trace[index - 1]!, after = trace[index]!;
      const a = before[window], b = after[window];
      if (a === undefined || b === undefined || before[`${window}ResetsAt`] !== after[`${window}ResetsAt`] || b < a) continue;
      rises.push((b - a) / Math.max(1, after.round - before.round));
    }
    if (rises.length) {
      const sorted = rises.sort((x, y) => x - y);
      return { window, cost: sorted[Math.floor(sorted.length / 2)]! };
    }
  }
  return undefined;
}

const PLUS_OR_INVITE = "可以升级到 ChatGPT Plus，或申请内测邀请码，用开发者提供的模型继续访谈。";

export function interviewQuotaOutlook(input: { plan?: string | undefined; signal: CostSignal; trace: QuotaReading[]; roundsDone: number;
  complete: boolean; usageLimitHit?: boolean }): InterviewQuotaOutlook {
  const remainingRounds = input.complete ? 0 : Math.max(2, INTERVIEW_ROUNDS_EXPECTED - input.roundsDone);
  if (input.complete) return { verdict: "ok", message: "", remainingRounds };
  const free = input.plan === "free";
  const used = input.signal.available ? Math.max(input.signal.long?.usedPercent ?? 0, input.signal.short?.usedPercent ?? 0) : undefined;
  if (input.usageLimitHit || (input.signal.available && (input.signal.limitReached || (used ?? 0) >= 100)))
    return { verdict: "spent", remainingRounds, message: `这个 ChatGPT 账号的额度已用完，访谈停在这里。${PLUS_OR_INVITE}` };
  const cost = perRoundCost(input.trace);
  const left = input.signal.available ? 100 - ((cost?.window === "short" ? input.signal.short?.usedPercent : input.signal.long?.usedPercent) ?? used ?? 0) : undefined;
  if (cost && cost.cost > 0 && left !== undefined) {
    const roundsLeft = Math.floor(left / cost.cost);
    const base = { perRound: Math.round(cost.cost * 10) / 10, roundsLeft, remainingRounds };
    // A short window comes back within hours: running out of it only means waiting, not stopping.
    if (roundsLeft < remainingRounds && cost.window === "long")
      return { ...base, verdict: "insufficient", message: `按前几轮的用量，这个${free ? "免费" : ""}账号剩下的额度大约还够 ${roundsLeft} 轮，访谈通常还要 ${remainingRounds} 轮左右。${PLUS_OR_INVITE}` };
    if (roundsLeft < remainingRounds)
      return { ...base, verdict: "tight", message: `按前几轮的用量，当前额度窗口大约还够 ${roundsLeft} 轮；用完后要等几个小时恢复再继续。${free ? PLUS_OR_INVITE : ""}` };
    return { ...base, verdict: "ok", message: "" };
  }
  if (free) return { verdict: "tight", remainingRounds, message: `免费账号的额度较少，访谈约 ${INTERVIEW_ROUNDS_EXPECTED} 轮，可能做不完；做两轮后这里会按实际用量估算还够几轮。${PLUS_OR_INVITE}` };
  return { verdict: "ok", message: "", remainingRounds };
}
