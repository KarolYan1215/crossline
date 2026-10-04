import { budgetPolicy } from "./index";

/**
 * What discretionary work is allowed to spend, expressed without naming a currency or a vendor.
 *
 * Today the backing runtime reports quota windows; a different backend might report money. Consumers
 * only ever see "how much of the window is gone" and "when does it reset", so swapping the backend
 * means writing one adapter, not rewriting every gate. A monetary ceiling stays a policy statement in
 * the design document — deliberately not a number here, because nothing in this process can measure it.
 */
export type CostWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds, as the runtime reports it. */
  resetsAt: number | null;
};

export type CostSignal =
  | { available: true; short?: CostWindow; long?: CostWindow; limitReached: boolean }
  | { available: false; reason: string };

export type SpendPolicy = {
  /** Share of the short window a single discretionary run may consume. */
  windowSharePercent: number;
  /** Long-window usage at or above which discretionary work stops entirely. */
  longWindowCeilingPercent: number;
};

export type SpendMode = "normal" | "economy" | "manual_core_only";

export type SpendDecision =
  | { allowed: true; headroomPercent: number; mode: SpendMode }
  | { allowed: false; code: string; message: string };

/**
 * Discretionary work is the flywheel and other background spending — never the work a person asked
 * for. Absence of a signal is a refusal, not a green light: without a reading there is no way to know
 * whether spending now would take the quota a person needs when they sit down.
 */
export function allowDiscretionarySpend(signal: CostSignal, policy: SpendPolicy): SpendDecision {
  if (!signal.available) {
    return { allowed: false, code: "COST_SIGNAL_UNAVAILABLE", message: `读不到成本信号，暂不运行自动任务：${signal.reason}` };
  }
  if (signal.limitReached) {
    return { allowed: false, code: "RATE_LIMIT_REACHED", message: "配额已用尽，等待窗口恢复后再运行。" };
  }
  if (signal.long && signal.long.usedPercent >= policy.longWindowCeilingPercent) {
    return {
      allowed: false,
      code: "LONG_WINDOW_BUDGET_SPENT",
      message: `周窗口已用 ${Math.round(signal.long.usedPercent)}%，超过 ${policy.longWindowCeilingPercent}% 上限，本轮搁置。`
    };
  }
  const used = signal.short?.usedPercent ?? 0;
  const headroomPercent = policy.windowSharePercent - used;
  if (headroomPercent <= 0) {
    return {
      allowed: false,
      code: "WINDOW_BUDGET_SPENT",
      message: `当前窗口已用 ${Math.round(used)}%，达到 ${policy.windowSharePercent}% 的自动任务上限。`
    };
  }
  // The three-tier degradation is real here because it reads a measured percentage, not an estimate.
  return { allowed: true, headroomPercent, mode: budgetPolicy(signal.long?.usedPercent ?? used).mode };
}
