import "server-only";
import { assistantAvailable as machineOwner } from "@crossline/db";
import { ACTIVITY_RULES, TIME_DRAFT_ASKED, TIME_DRAFT_DAYS, TIME_DRAFT_DECISIONS, TIME_DRAFTS, type AccessContext, type ActivityRule, type DraftDecision,
  type TimeDraft } from "@crossline/core";
import { ACTIVITY_DETAIL_CONSENT, appNow, getStore } from "./crossline";
import { setActivityConsent, type SwitchResult } from "./consents";

/**
 * 拟计时, the web's half (docs/plans/2026-11-11-walkthrough-decisions.md §1): the drafts the worker wrote (`TIME_DRAFTS`), what the person
 * decided about each (`TIME_DRAFT_DECISIONS`, written here only), and the one question that turns drafting on. A confirmed draft becomes an
 * execution marked `inferred_confirmed` (`recordInferredSession`) — measured time that feeds the estimate's calibration; an undecided one
 * never does.
 */
const DAY = 86_400_000;
const OPEN = new Set(["approved", "preparing", "ready_for_human", "active"]);
const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const detailOn = (ctx: AccessContext) => getStore().getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) === "granted";
const readDrafts = (ctx: AccessContext) => json<TimeDraft[]>(getStore().getSetting(ctx.workspaceId, TIME_DRAFTS), []);
const readDecisions = (ctx: AccessContext) => json<Record<string, DraftDecision>>(getStore().getSetting(ctx.workspaceId, TIME_DRAFT_DECISIONS), {});

/** The drafts waiting for the person: not decided, not older than fourteen days. None without the 「应用与窗口」 consent. */
export function pendingDrafts(ctx: AccessContext, now = appNow()): TimeDraft[] {
  if (!detailOn(ctx)) return [];
  const decided = readDecisions(ctx), since = now.getTime() - TIME_DRAFT_DAYS * DAY;
  return readDrafts(ctx).filter((draft) => !decided[draft.id] && Date.parse(draft.end) >= since);
}

/**
 * Every draft as it is placed now, for the block inference (`attributedBlockSpans`): an undecided one as drafted, a confirmed one on the
 * task the person chose and 不算工作 on none — both as the person's own rule, which decides like one.
 */
export function placedDrafts(ctx: AccessContext): TimeDraft[] {
  if (!detailOn(ctx)) return [];
  const decided = readDecisions(ctx);
  return readDrafts(ctx).map((draft) => {
    const decision = decided[draft.id];
    if (!decision) return draft;
    return { ...draft, workOrderId: decision.decision === "confirmed" ? decision.workOrderId ?? draft.workOrderId ?? "" : "", basis: "rule" as const };
  });
}

/** An open task of this workspace (and its open step, when the step is one of it), or undefined. */
function openTarget(ctx: AccessContext, workOrderId: string | undefined, stepId: string | undefined): { workOrderId: string; stepId?: string } | undefined {
  const store = getStore();
  const order = workOrderId ? store.getWorkOrder(ctx.workspaceId, workOrderId) : undefined;
  if (!order || !OPEN.has(order.state) || order.tombstone) return undefined;
  const step = stepId ? store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.id === stepId && item.status === "planned") : undefined;
  return { workOrderId: order.id, ...(step ? { stepId: step.id } : {}) };
}

export type DraftAnswer = { action: "confirm"; workOrderId?: string; stepId?: string } | { action: "not_work" } | { action: "rule"; workOrderId: string };
export type DraftResult = { ok: true; minutes?: number } | { ok: false; code: "DRAFT_NOT_FOUND" | "DRAFT_TASK_INVALID" };

/**
 * The person's answer to one draft: 记 (on the task it was drafted for, or the one picked), 不算工作, or 以后这类都算 X — recorded on X and a
 * rule written so the same app goes to X from now on (`activity.rules`, matched on the app: the draft keeps no title). Once per draft.
 */
export function answerDraft(ctx: AccessContext, id: string, answer: DraftAnswer, now = appNow()): DraftResult {
  const store = getStore();
  const draft = pendingDrafts(ctx, now).find((item) => item.id === id);
  if (!draft) return { ok: false, code: "DRAFT_NOT_FOUND" };
  const decide = (decision: DraftDecision) => {
    const since = new Date(now.getTime() - TIME_DRAFT_DAYS * DAY).toISOString();
    const kept = Object.fromEntries(Object.entries(readDecisions(ctx)).filter(([, item]) => item.at >= since));
    store.setSetting(ctx.workspaceId, TIME_DRAFT_DECISIONS, JSON.stringify({ ...kept, [id]: decision }));
  };
  if (answer.action === "not_work") { decide({ decision: "not_work", at: now.toISOString() }); return { ok: true }; }
  const picked = answer.workOrderId ?? draft.workOrderId;
  const target = openTarget(ctx, picked, answer.action === "confirm" ? answer.stepId ?? (picked === draft.workOrderId ? draft.stepId : undefined) : undefined);
  if (!target) return { ok: false, code: "DRAFT_TASK_INVALID" };
  store.recordInferredSession(ctx.workspaceId, target.workOrderId, ctx.principalId, { startedAt: draft.start, endedAt: draft.end, minutes: draft.minutes,
    key: `time-draft:${draft.id}`, ...(target.stepId ? { stepId: target.stepId } : {}) });
  decide({ decision: "confirmed", at: now.toISOString(), workOrderId: target.workOrderId });
  if (answer.action === "rule") {
    const rules = json<ActivityRule[]>(store.getSetting(ctx.workspaceId, ACTIVITY_RULES), []).filter((rule) => rule.match !== draft.app);
    store.setSetting(ctx.workspaceId, ACTIVITY_RULES, JSON.stringify([...rules, { match: draft.app, category: draft.category, workOrderId: target.workOrderId }]));
  }
  return { ok: true, minutes: draft.minutes };
}

/**
 * Whether the wrap-up asks to turn drafting on. The owner's rule (2026-11-11): a feature that needs a permission asks once whether the
 * person agrees; 「on」 with the 「应用与窗口」 level on, 「ask」 when it is off and was never asked here, 「off」 after the answer (or on
 * a computer whose screen is not this account's to record).
 */
export function draftConsent(ctx: AccessContext): "on" | "ask" | "off" {
  if (detailOn(ctx)) return "on";
  if (getStore().getSetting(ctx.workspaceId, TIME_DRAFT_ASKED) || !machineOwner(getStore(), ctx.workspaceId)) return "off";
  return "ask";
}

/** The answer to that question: yes turns 「应用与窗口」 on; no turns it off (the minutes level stays as it was). Either way it is not asked again. */
export function answerDraftConsent(ctx: AccessContext, yes: boolean): SwitchResult {
  const result = setActivityConsent(ctx, { detail: yes ? "granted" : "denied" });
  if (result.ok) getStore().setSetting(ctx.workspaceId, TIME_DRAFT_ASKED, yes ? "asked" : "declined");
  return result;
}
