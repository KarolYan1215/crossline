import "server-only";
import { answerAllSteps, onPersonsBoard, safeAssistantResult, staleProposal, taskTitleOf, type AccessContext, type AnswerAllStep, type AskKind } from "@crossline/core";
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
  const t = tOf(ctx);
  const accepted: string[] = [];
  let done = 0, failed = 0;
  const asks = new Map(thisWeek(listed(openAsks(ctx, now))).map((ask) => [ask.id, ask]));
  const result = await withUndo(ctx, t("全部按推荐处理 {{count}} 项", { count: plan.total }), async () => {
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
