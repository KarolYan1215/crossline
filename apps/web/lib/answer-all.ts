import "server-only";
import { randomUUID } from "node:crypto";
import { answerAllSteps, onPersonsBoard, safeAssistantResult, staleProposal, taskTitleOf, tidySentenceEnds, type AccessContext, type AnswerAllStep, type AskKind } from "@crossline/core";
import { resultsAwaitingReview, reviewAgentTask } from "@crossline/db";
import { appNow, archiveWorkOrder, getStore, milestoneDeadline, planToday } from "./crossline";
import { answerAsk, listed, openAsks, snoozeAsk, thisWeek } from "./asks";
import { preparingProposalIds } from "./proposal-ready";
import { withUndo } from "./undo";
import { tOf } from "./locale";

/**
 * 「全部按推荐」 on 待确认 and in the evening wrap-up (the owner's decision of 2026-10-28; docs/rituals.md): every decision this week that
 * has a safe, undoable default, settled in one step and taken back by one undo. Which kinds is `ANSWER_ALL_KINDS` in core; beside the
 * asks, the assistant's clean results are accepted and proposals whose day passed or that waited fourteen days are put away.
 */
export type AnswerAllGroup = "risk" | "missed" | "relation" | "assistant" | "proposal";
export type AnswerAllPlan = {
  asks: AnswerAllStep[];
  results: Array<{ taskId: string; title: string }>;
  proposals: Array<{ id: string; title: string }>;
  /** How many of each, for the button's confirmation (「将处理 N 项：…」). */
  groups: Array<{ group: AnswerAllGroup; count: number }>;
  total: number;
};

const GROUP_OF: Partial<Record<AskKind, AnswerAllGroup>> = { risk_digest: "risk", milestone_risk_review: "risk", missed_block: "missed", relation_check: "relation" };

export function answerAllPlan(ctx: AccessContext, now = appNow()): AnswerAllPlan {
  const store = getStore();
  const today = planToday(ctx, now);
  const asks = answerAllSteps(thisWeek(listed(openAsks(ctx, now))));
  const results = resultsAwaitingReview(store, ctx.workspaceId).filter(safeAssistantResult).map((row) => ({ taskId: row.taskId, title: row.title }));
  const proposedAt = new Map<string, string>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "work_order.transitioned" }))
    if ((proposedAt.get(event.entityId) ?? "") < event.createdAt) proposedAt.set(event.entityId, event.createdAt);
  const preparing = preparingProposalIds(ctx);
  const proposals = store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval" && onPersonsBoard(order)
    && !preparing.has(order.id) && proposedAt.has(order.id)).filter((order) => {
    const own = (order.payload as { dueDate?: string } | undefined)?.dueDate;
    const due = own ?? (order.milestoneId ? milestoneDeadline(ctx, order.milestoneId) : undefined);
    return staleProposal({ ...(due ? { dueDay: due } : {}), createdAt: proposedAt.get(order.id)!, today });
  }).map((order) => ({ id: order.id, title: taskTitleOf(order) }));
  const counts = new Map<AnswerAllGroup, number>();
  for (const step of asks) { const group = GROUP_OF[step.kind]; if (group) counts.set(group, (counts.get(group) ?? 0) + 1); }
  if (results.length) counts.set("assistant", results.length);
  if (proposals.length) counts.set("proposal", proposals.length);
  const groups = [...counts].map(([group, count]) => ({ group, count }));
  return { asks, results, proposals, groups, total: asks.length + results.length + proposals.length };
}

/** Carries the plan out under one undo. What failed (a thing that changed in the meantime) is counted and left as it was. */
export async function runAnswerAll(ctx: AccessContext, now = appNow()): Promise<{ ok: true; done: number; failed: number; op?: { id: string; label: string } }> {
  const plan = answerAllPlan(ctx, now);
  return carryOut(ctx, plan, tOf(ctx)("全部按推荐处理 {{count}} 项", { count: plan.total }), now);
}

/** How long a safe decision waits for the person before its recommendation is taken (2026-11-05, docs/hosted-hardening.md §5). */
export const AUTO_ANSWER_AFTER_MS = 48 * 3_600_000;
/** The asks (id and fingerprint) and proposals once settled by `autoAnswerDue`; the last 500. */
export const AUTO_ANSWERED_SETTING = "asks.autoAnswered";
/** When each open ask with a safe default was first seen by `autoAnswerDue`, for asks that carry no time of their own. */
export const AUTO_ANSWER_SEEN_SETTING = "asks.autoAnswerSeen";
const readSeen = (raw: string | undefined): Record<string, string> => {
  try { const value: unknown = JSON.parse(raw ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {}; } catch { return {}; }
};
const readKeys = (raw: string | undefined): string[] => { try { const value: unknown = JSON.parse(raw ?? "[]"); return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []; } catch { return []; } };

/**
 * The default effect of 待确认 (the owner's decision of 2026-11-05): a decision with a safe, undoable default that has waited 48 hours is
 * settled by that default, the way 「全部按推荐」 would, under one undo kept 24 hours and said once in the day's conversation. Before, a
 * person away for a week came back to dozens of open items, each of which had only one sensible answer. Only what the button settles is
 * touched (`ANSWER_ALL_KINDS`: risk digests, missed blocks, relation checks) and proposals already past their day; the assistant's results
 * are the worker's (date-advance adopts the safe ones after a day). An ask without a time it was raised counts from the first pass that saw it.
 */
export async function autoAnswerDue(ctx: AccessContext, now = appNow()): Promise<{ done: number; op?: { id: string; label: string } }> {
  const store = getStore();
  const plan = answerAllPlan(ctx, now);
  const open = new Map(thisWeek(listed(openAsks(ctx, now))).map((ask) => [ask.id, ask]));
  // What was settled this way once is never settled again by itself: an undo is the person saying no, and the ask comes back with its old time.
  const before = new Set<string>(readKeys(store.getSetting(ctx.workspaceId, AUTO_ANSWERED_SETTING)));
  const keyOf = (id: string) => `${id}|${open.get(id)?.fingerprint ?? ""}`;
  // An ask without a time it was raised (the weekly risk digest is one) counts from the first pass that saw it; kept only while it is open.
  const seenBefore = readSeen(store.getSetting(ctx.workspaceId, AUTO_ANSWER_SEEN_SETTING));
  const seen: Record<string, string> = {};
  for (const step of plan.asks) seen[keyOf(step.askId)] = seenBefore[keyOf(step.askId)] ?? now.toISOString();
  store.setSetting(ctx.workspaceId, AUTO_ANSWER_SEEN_SETTING, JSON.stringify(seen));
  const due = (id: string) => {
    const raised = Date.parse(open.get(id)?.raisedAt ?? "");
    const at = Number.isFinite(raised) ? raised : Date.parse(seen[keyOf(id)] ?? "");
    return Number.isFinite(at) && now.getTime() - at >= AUTO_ANSWER_AFTER_MS && !before.has(keyOf(id));
  };
  const asks = plan.asks.filter((step) => due(step.askId));
  const proposals = plan.proposals.filter((item) => !before.has(`proposal:${item.id}`));
  const total = asks.length + proposals.length;
  if (!total) return { done: 0 };
  const keys = [...before, ...asks.map((step) => keyOf(step.askId)), ...proposals.map((item) => `proposal:${item.id}`)];
  store.setSetting(ctx.workspaceId, AUTO_ANSWERED_SETTING, JSON.stringify(keys.slice(-500)));
  const t = tOf(ctx);
  const result = await carryOut(ctx, { ...plan, asks, results: [], proposals, total }, t("没有回应 48 小时，已按推荐处理 {{count}} 项", { count: total }), now);
  if (result.done && result.op) {
    const names = [...asks.map((step) => step.title), ...proposals.map((item) => item.title)].slice(0, 3).map((title) => t("「{{title}}」", { title })).join(t("、"));
    say(ctx, result.done > 3
      ? t("{{names}}等 {{count}} 项等了 48 小时没有回应，已按推荐处理。24 小时内可撤销。", { names, count: result.done })
      : t("{{names}}等了 48 小时没有回应，已按推荐处理。24 小时内可撤销。", { names }), result.op.id, now);
  }
  return { done: result.done, ...(result.op ? { op: result.op } : {}) };
}

async function carryOut(ctx: AccessContext, plan: AnswerAllPlan, label: string, now: Date): Promise<{ ok: true; done: number; failed: number; op?: { id: string; label: string } }> {
  const t = tOf(ctx);
  const accepted: string[] = [];
  let done = 0, failed = 0;
  const asks = new Map(thisWeek(listed(openAsks(ctx, now))).map((ask) => [ask.id, ask]));
  const result = await withUndo(ctx, label, async () => {
    for (const step of plan.asks) {
      const ask = asks.get(step.askId);
      const outcome = !ask ? { ok: false } : "snooze" in step ? snoozeAsk(ctx, step.askId, step.snooze, now, undefined, { undo: false, ask })
        : await answerAsk(ctx, step.askId, step.optionId, {}, now, { undo: false, ask });
      if (outcome.ok) done += 1; else failed += 1;
    }
    for (const item of plan.results) {
      if (reviewAgentTask(getStore(), ctx.workspaceId, item.taskId, "accepted", t("全部按推荐时采纳")).ok) { accepted.push(item.taskId); done += 1; } else failed += 1;
    }
    for (const item of plan.proposals) {
      if (archiveWorkOrder(ctx, item.id, t("全部按推荐：提议已过期，归档")).ok) done += 1; else failed += 1;
    }
    return { ok: true as const, done, failed };
  }, () => accepted.length ? [{ kind: "agent.reopen", taskIds: accepted }] : []);
  return { ...result, done, failed };
}

/** One message in the day's conversation with 撤销, left pending so the worker's notification pass sends it when no page is open. */
function say(ctx: AccessContext, text: string, opId: string, now: Date): void {
  const store = getStore();
  const t = tOf(ctx);
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "", createdAt: now.toISOString(),
    payload: { nudge: { kind: "auto_answered", fingerprint: `auto_answered:${opId}`, urgent: false, counted: false, delivery: "pending" },
      card: { actions: [{ action: "undo", summary: t("撤销自动处理"), args: { opId } }], items: [{ state: "pending" }], confidence: "high", nudgeKind: "auto_answered",
        clarify: { question: tidySentenceEnds(text), options: [{ label: t("撤销"), actions: [0], kind: "action" }, { label: t("知道了"), actions: [], kind: "ack" }] } } } });
}
