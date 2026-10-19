import {
  WEEKLY_INSIGHT_OUTPUT_SCHEMA, validateWeeklyInsight,
  type WeeklyInsightContext, type WeeklyInsightResult
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

import { ownerOf } from "./owner";
export const WEEKLY_INSIGHT_SKILL = "crossline:crossline-weekly-insight";

/**
 * The scenario in short; the Skill holds the rules and the examples. It used to say "if you cannot find three, say so in a blocker", and a
 * blocker throws away the whole run, estimate updates included: a week without a strong pattern is empty lists.
 */
const INSTRUCTIONS = "Read this week's execution record and propose only the patterns it supports, as the crossline-weekly-insight Skill describes, "
  + "and return only the requested JSON. The person reads each claim and its 建议 on the weekly review page and decides; nothing is changed by you. "
  + "Every insight rests on at least three comparable observations, cites ids from executions or notificationEvents only, and names its counterexamples; "
  + "a pattern with fewer observations is left out, not reported as a blocker. Interruption, missing input and estimation error are separate findings "
  + "and none is a judgement of the person. Count byproducts in an insight when at least three were planned.";

type InsightRunOutcome =
  | { state: "ready"; result: WeeklyInsightResult }
  | { state: "blocked"; code: string; message: string };

/** The past seven days of real ledger fact, assembled independently of `apps/web` the same way every
 * other worker-side context builder already is. */
export function buildWeeklyInsightContext(store: CrosslineStore, workspaceId: string, now: Date): WeeklyInsightContext {
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const to = now.toISOString();
  const inPeriod = (createdAt: string) => createdAt >= from && createdAt <= to;
  const orders = store.listWorkOrders(workspaceId);
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const familyOf = (workOrderId: string) => (orderById.get(workOrderId)?.payload as { family?: string } | undefined)?.family ?? "unknown";
  const executions = store.listExecutions(workspaceId)
    .filter((execution) => inPeriod(execution.startedAt))
    .map((execution) => ({
      id: execution.id, workOrderId: execution.workOrderId,
      identityId: orderById.get(execution.workOrderId)?.identityId ?? "unknown",
      family: familyOf(execution.workOrderId),
      startedAt: execution.startedAt, endedAt: execution.endedAt ?? null,
      pauseMinutes: execution.pauseMinutes, durationObserved: execution.durationObserved
    }));
  const estimates = orders.map((order) => ({
    workOrderId: order.id, identityId: order.identityId, family: familyOf(order.id), p50Minutes: order.estimate.p50Minutes
  }));
  const energyObservations = store.listEnergyObservations(workspaceId)
    .filter((item) => inPeriod(item.observedAt))
    .map((item) => ({ id: item.id, level: item.level, observedAt: item.observedAt }));
  // No dedicated "notification" concept exists in the ledger — the real signal a person would have
  // been notified about is a state transition, so that is what this reads rather than a fiction.
  const notificationEvents = store.listEvents(workspaceId, { type: ["work_order.transitioned", "materials.blocked", "milestone_gate.judged"] })
    .filter((event) => inPeriod(event.createdAt))
    .map((event) => ({ id: event.eventId, type: event.type, entityId: event.entityId, createdAt: event.createdAt }));
  const landedAt = (id: string) => store.listEvents(workspaceId, { type: "work_order.transitioned", entityId: id })
    .find((event) => (event.payload as { to?: string }).to === "accepted")?.createdAt;
  const byproductItems = store.listEvents(workspaceId, { type: "byproduct.planned" }).filter((event) => inPeriod(event.createdAt)).map((event) => {
    const payload = event.payload as { primaryId: string; lineId: string; artifact: string };
    const landing = orderById.get(event.entityId);
    const primaryDone = store.listExecutions(workspaceId, payload.primaryId).map((execution) => execution.endedAt).filter(Boolean).sort().at(-1);
    const status: "planned" | "landed" | "missed" = landing?.state === "accepted" || landedAt(event.entityId) ? "landed"
      : primaryDone && now.getTime() - Date.parse(primaryDone) > 2 * 86_400_000 ? "missed" : "planned";
    return { id: event.entityId, lineId: payload.lineId, artifact: payload.artifact, status };
  });
  return {
    version: "crossline.weekly-insight.v1",
    period: { from, to },
    byproducts: { planned: byproductItems.length, landed: byproductItems.filter((item) => item.status === "landed").length,
      missed: byproductItems.filter((item) => item.status === "missed").length, items: byproductItems },
    executions, estimates, energyObservations, notificationEvents,
    approvedMilestones: store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved")
      .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, title: milestone.title }))
  };
}

export function createWeeklyInsight(store: CrosslineStore, workspaceId: string, projectRoot: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function run(now = new Date()): Promise<InsightRunOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const context = buildWeeklyInsightContext(store, workspaceId, now);
    if (context.executions.length < 3) {
      return { state: "blocked", code: "WEEKLY_INSIGHT_INSUFFICIENT_EVIDENCE", message: "过去一周执行记录不足 3 条，无法生成有依据的洞察。" };
    }

    const result = await runCodexSkill<WeeklyInsightResult>(client, context, {
      skillName: WEEKLY_INSIGHT_SKILL,
      cwd: projectRoot,
      developerInstructions: INSTRUCTIONS,
      outputSchema: WEEKLY_INSIGHT_OUTPUT_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateWeeklyInsight(output, context),
      onAudit: () => {},
      timeoutMs: 60 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    const runId = `${now.toISOString().slice(0, 10)}:${Date.now()}`;
    store.appendEvent({
      ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `weekly-insight:${runId}`,
      type: "weekly_review.insight_run", entityId: runId, payload: result.output
    });
    // Each proposal also lands as its own event, so the Review page can list them the same way it
    // already lists flywheel findings and milestone-relation candidates — one row per reviewable claim.
    for (const proposal of result.output.insightProposals) {
      store.appendEvent({
        ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `weekly-insight:proposal:${proposal.id}`,
        type: "weekly_review.insight_proposal", entityId: proposal.id, payload: proposal
      });
    }
    return { state: "ready", result: result.output };
  };
}
