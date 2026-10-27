import { budgetPolicy } from "./index";
import { tFor, type Locale } from "./i18n";
import type { QuotaSaver } from "./quota-saver";

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
  | { available: true; short?: CostWindow; long?: CostWindow; limitReached: boolean;
      /** A pay-per-use runtime has no windows: this month's spend against the person's cap, in the cap's own currency. */
      money?: { spent: number; cap: number } }
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
export function allowDiscretionarySpend(signal: CostSignal, policy: SpendPolicy, locale?: Locale): SpendDecision {
  const t = tFor(locale);
  if (!signal.available) {
    return { allowed: false, code: "COST_SIGNAL_UNAVAILABLE", message: t("读不到成本信号，暂不运行自动任务：{{reason}}", { reason: signal.reason }) };
  }
  if (signal.limitReached) {
    return { allowed: false, code: "RATE_LIMIT_REACHED", message: t("配额已用尽，等待窗口恢复后再运行。") };
  }
  if (signal.long && signal.long.usedPercent >= policy.longWindowCeilingPercent) {
    return {
      allowed: false,
      code: "LONG_WINDOW_BUDGET_SPENT",
      message: t("周窗口已用 {{used}}%，超过 {{ceiling}}% 上限，本轮搁置。", { used: Math.round(signal.long.usedPercent), ceiling: policy.longWindowCeilingPercent })
    };
  }
  const used = signal.short?.usedPercent ?? 0;
  const headroomPercent = policy.windowSharePercent - used;
  if (headroomPercent <= 0) {
    return {
      allowed: false,
      code: "WINDOW_BUDGET_SPENT",
      message: t("当前窗口已用 {{used}}%，达到 {{share}}% 的自动任务上限。", { used: Math.round(used), share: policy.windowSharePercent })
    };
  }
  // The three-tier degradation is real here because it reads a measured percentage, not an estimate.
  return { allowed: true, headroomPercent, mode: budgetPolicy(signal.long?.usedPercent ?? used).mode };
}

/**
 * Background work the tick starts on its own. `core` is what keeps the person's own captures and tasks moving (analysis,
 * backplanning, step plans); `discretionary` is what nobody is waiting on (curation, titles, tutorials, research, the assistant).
 */
/**
 * `intake`: what turns the person's own input into something usable — capture analysis, filing calendar events under lines. It runs
 * while the person is cooling off; everything else waits for them to come back (docs/review-2026-10-13.md §6.1).
 */
export type SpendKind = "intake" | "core" | "discretionary";

/**
 * How recently the person did something themselves: within 48 hours `active`; up to seven days `cooling` (only intake runs); beyond that
 * `dormant` (no model calls at all — the calendar is still read and reminders still go out, neither costs a model call). Background work
 * that nobody will look at is spending without value: the real account spent 51% of a week's tokens on manuals for work never started.
 */
export type Engagement = "active" | "cooling" | "dormant";
export const ENGAGEMENT_ACTIVE_HOURS = 48;
export const ENGAGEMENT_DORMANT_DAYS = 7;

/** `lastActiveAt`: the person's latest own action; `since`: when the workspace began, standing in for it before there is any. */
export function engagementTier(lastActiveAt: string | undefined, now: Date, since?: string): Engagement {
  const from = lastActiveAt ?? since;
  if (!from) return "active";
  const hours = (now.getTime() - Date.parse(from)) / 3_600_000;
  return hours <= ENGAGEMENT_ACTIVE_HOURS ? "active" : hours <= ENGAGEMENT_DORMANT_DAYS * 24 ? "cooling" : "dormant";
}
/** Setting the worker writes when it pauses a workspace's background passes, `{code, message, resetsAt?, at}`; the web asks about it. */
export const BACKGROUND_BLOCKER = "background.blocker";
/** `message` is for the person; `reason` is the runtime's own words, kept for logs and for telling a down worker apart. */
export type BackgroundSpend = { mode: SpendMode; blocker?: { code: string; message: string; resetsAt?: string; reason?: string };
  /** Absent reads as `active` (callers that do not track the person). */
  engagement?: Engagement;
  /** The fullest window's share used, when the reading has one: core work stops at `CORE_STOP_PERCENT`, intake runs on to 100%. */
  usedPercent?: number;
  /** A local evaluation is spending this account's quota (`EVAL_HOLD_FILE`): discretionary work waits until it ends. */
  held?: boolean;
  /** 节省额度 (`quotaSaverReading`): absent reads as off, the rules before it. */
  saver?: QuotaSaver };
/**
 * Core background work stops here and leaves the last of the quota to intake (capture analysis, calendar filing) and the person's own
 * turns: what the person just put in is turned into something usable last of all (2026-10-21).
 */
export const CORE_STOP_PERCENT = 95;

/**
 * The one reading of the quota for background work. It replaced eight copies of the same check that disagreed about an
 * unreadable quota (stop / treat as normal / keep going) and stopped the capture analysis in economy mode, where the
 * Skill runs at the same tier anyway. A quota that cannot be read pauses background work with a reason the person sees
 * (an API-key login reports no windows), instead of stopping silently or spending without knowing how much is left.
 */
export function backgroundSpend(signal: CostSignal, locale?: Locale): BackgroundSpend {
  const t = tFor(locale);
  if (!signal.available) return { mode: "manual_core_only", blocker: { code: "COST_SIGNAL_UNAVAILABLE", reason: signal.reason,
    message: /auth|login|apikey|api key/i.test(signal.reason)
      ? t("读不到模型额度（还没有登录模型账号，或 API key 登录没有额度窗口），后台自动工作已暂停；本人发起的操作照常运行。")
      : t("读不到模型额度，后台自动工作已暂停；本人发起的操作照常运行。") } };
  const used = Math.max(signal.short?.usedPercent ?? 0, signal.long?.usedPercent ?? 0);
  if (signal.limitReached) {
    const reset = [signal.short, signal.long].filter((window) => (window?.usedPercent ?? 0) >= 100).map((window) => window?.resetsAt).find((at) => at);
    const resetsAt = reset ? new Date(reset * 1000).toISOString() : undefined;
    return { mode: "manual_core_only", blocker: { code: "RATE_LIMIT_REACHED", message: t("模型额度已用尽，后台自动工作暂停到额度恢复。"),
      ...(resetsAt ? { resetsAt } : {}) } };
  }
  const { mode } = budgetPolicy(used);
  // The window that is spent says when it comes back: the person is told the hour, not just 「暂停」.
  const fullest = [signal.short, signal.long].filter((window): window is CostWindow => Boolean(window))
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const resetsAt = fullest?.resetsAt ? new Date(fullest.resetsAt * 1000).toISOString() : undefined;
  return mode === "manual_core_only"
    ? { mode, blocker: { code: "BUDGET_EXHAUSTED", message: t("模型额度已用 {{used}}%，后台自动工作暂停到额度恢复。", { used: Math.round(used) }), ...(resetsAt ? { resetsAt } : {}) } }
    : { mode, usedPercent: used };
}

/**
 * The account's own ChatGPT quota is spent while it also holds the developer's model (2026-10-21, the owner's 「chatgpt额度达到时，如果
 * 账号有赞助模型授权，应该切换成赞助模型继续」). The worker writes `{at, source, until?}` when a reading shows the quota spent (`quota`,
 * `until` the spent window's reset) or a run came back `SKILL_USAGE_LIMIT` (`usage_limit`, which carries no reset); every Skill the
 * developer's model may serve goes there until then, and the next reading that shows the quota back clears it.
 */
export const CHATGPT_EXHAUSTED_SETTING = "model.chatgptExhausted";
export type ChatgptExhausted = { at: string; source: "quota" | "usage_limit"; until?: string };
/** How long a refused run alone (no reading with a reset time) keeps the account on the developer's model before ChatGPT is tried again. */
export const USAGE_LIMIT_HOLD_MS = 30 * 60_000;

/** Whether a reading of the ChatGPT quota says it is spent, and until when: the same line `backgroundSpend` pauses at. */
export function chatgptQuotaSpent(signal: CostSignal): { until?: string } | undefined {
  if (!signal.available || signal.money) return undefined;
  const spend = backgroundSpend(signal);
  if (spend.mode !== "manual_core_only" || !spend.blocker) return undefined;
  return spend.blocker.resetsAt ? { until: spend.blocker.resetsAt } : {};
}

/** The stored mark while it still holds: until its reset time, or `USAGE_LIMIT_HOLD_MS` after a refused run that gave none. */
export function chatgptExhausted(raw: string | undefined, now: Date): ChatgptExhausted | undefined {
  if (!raw) return undefined;
  let mark: ChatgptExhausted;
  try { mark = JSON.parse(raw) as ChatgptExhausted; } catch { return undefined; }
  if (!mark?.at) return undefined;
  const end = mark.until ? Date.parse(mark.until) : Date.parse(mark.at) + USAGE_LIMIT_HOLD_MS;
  return Number.isFinite(end) && end > now.getTime() ? mark : undefined;
}

/**
 * What still works while background work is paused, and what waits (the 2026-10-18 evaluation: the person saw only 「已暂停」 and a
 * stopped-looking system). The schedule, the calendar, reminders, timing and completion need no model at all; analysis, step plans,
 * tutorials, research and the assistant do. A spent quota (`RATE_LIMIT_REACHED`, or `BUDGET_EXHAUSTED`, which the policy writes only
 * at 100%) also stops the person's own turns — the input box's replies and the interview; a quota that cannot be read does not say so.
 */
export function degradedService(code: string): { works: string[]; paused: string[]; personTurns: boolean } {
  const personTurns = code !== "RATE_LIMIT_REACHED" && code !== "BUDGET_EXHAUSTED";
  return {
    works: ["排程与日历：按现有任务和步骤照常重排，写入 Crossline 日历", "计时、完成确认与提交", "提醒与手机推送",
      "手动改截止、时长和步骤", "回答待决事项（需要重排的，恢复后补上）", ...(personTurns ? ["输入框对话与访谈"] : [])],
    paused: ["新收集事项的分析与拆分", "拆步骤与按回答重排", "教程与调研", "助手代办", ...(personTurns ? [] : ["输入框的对话回复与访谈"])],
    personTurns
  };
}

/**
 * The one gate for every background pass. `nonCore` marks the work the quota saver holds (docs/token-economy.md §2.3, `quota-saver.ts`):
 * with the saver on it must also pass its kind's own rule, find the quota normal or the person's night, and find non-core work under its
 * share of the week; with the saver off its kind's rule alone decides, as before. Core work is never held by the saver.
 */
export function spendAllows(spend: BackgroundSpend, kind: SpendKind, options: { nonCore?: boolean } = {}): boolean {
  if (!kindAllows(spend, kind)) return false;
  if (!options.nonCore || !spend.saver?.on) return true;
  return (spend.mode === "normal" || spend.saver.night) && !spend.saver.overShare;
}

/** Whether the saver, not the quota or the person's absence, is what stops non-core work now: the person is told once a week. */
export function saverStopsNonCore(spend: BackgroundSpend, kind: SpendKind): boolean {
  return Boolean(spend.saver?.on && spend.saver.overShare && kindAllows(spend, kind));
}

function kindAllows(spend: BackgroundSpend, kind: SpendKind): boolean {
  const engagement = spend.engagement ?? "active";
  if (engagement === "dormant" || (engagement === "cooling" && kind !== "intake")) return false;
  if (kind === "discretionary") return spend.mode === "normal" && !spend.held;
  if (kind === "core" && (spend.usedPercent ?? 0) >= CORE_STOP_PERCENT) return false;
  return spend.mode !== "manual_core_only";
}
