import "server-only";
import { computeEffectiveness, type AccessContext, type Effectiveness } from "@crossline/core";
import { relationChecks } from "@crossline/db";
import { getStore, loadCurrentPlan, loadGoalForecast, planToday, resolvedEstimate, workspaceCalibration } from "./crossline";
import { countPending } from "./pending";
import { identityLines } from "./lines";

const DAY = 86_400_000;
const ACTIONABLE = new Set(["approved", "preparing", "ready_for_human", "active"]);

/**
 * The 系统体检 numbers, gathered from the ledger (see `computeEffectiveness`). Estimate accuracy uses the
 * calibration's own rolling backtest (each finished task predicted only from the ones before it), not an
 * in-sample fit, so the calibrated figure is not flattered by having seen the answer.
 */
export async function loadEffectiveness(ctx: AccessContext, now = new Date()): Promise<Effectiveness & { decisionMinutesMeasured: false }> {
  const store = getStore();
  const today = planToday(ctx, now);
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const approved = store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved");
  const judged = store.listEvents(ctx.workspaceId, { type: "milestone_gate.judged" });
  const forecast = loadGoalForecast(ctx);
  const p85 = new Map(forecast.goals.map((goal) => [goal.milestoneId, goal.p85Day]));

  const milestones = approved.filter((milestone) => anchors.get(milestone.id)).map((milestone) => {
    const metOn: Record<string, string> = {};
    for (const event of judged) {
      const payload = event.payload as { milestoneId?: string; criteriaVerdict?: Array<{ criterionId: string; met: string }> };
      if (payload.milestoneId !== milestone.id) continue;
      for (const item of payload.criteriaVerdict ?? []) {
        const day = event.createdAt.slice(0, 10);
        if (item.met === "met" && (!metOn[item.criterionId] || day < metOn[item.criterionId]!)) metOn[item.criterionId] = day;
      }
    }
    return { id: milestone.id, title: milestone.title, deadline: anchors.get(milestone.id)!, metOn,
      requiredCriteria: milestone.successCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id),
      p85Finish: p85.get(milestone.id) ?? null };
  });

  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const durations = store.listAllDurationObservations(ctx.workspaceId).filter((row) => row.llmP50Minutes && row.llmP85Minutes && !row.censored).map((row) => {
    const order = orders.get(row.workOrderId);
    const calibrated = order ? resolvedEstimate(ctx, order) : undefined;
    return { llmP50: row.llmP50Minutes!, llmP85: row.llmP85Minutes!, calibratedP50: calibrated?.p50Minutes ?? row.llmP50Minutes!,
      calibratedP85: calibrated?.p85Minutes ?? row.llmP85Minutes!, actual: row.observedMinutes };
  });

  const minutesByLine: Record<string, number> = {};
  let deadlineMinutes = 0;
  let totalMinutes = 0;
  for (const execution of store.listExecutions(ctx.workspaceId).filter((item) => item.endedAt && item.endedAt >= weekAgo)) {
    const order = orders.get(execution.workOrderId);
    if (!order) continue;
    const minutes = Math.max(0, Math.round((Date.parse(execution.endedAt!) - Date.parse(execution.startedAt)) / 60_000) - execution.pauseMinutes);
    minutesByLine[order.identityId] = (minutesByLine[order.identityId] ?? 0) + minutes;
    totalMinutes += minutes;
    if (anchors.get(order.milestoneId) || (order.payload as { dueDate?: string }).dueDate) deadlineMinutes += minutes;
  }

  // Decisions the person made this week: approvals, accepted drafts, answered follow-ups and relation decisions.
  const decisionEvents = store.listEvents(ctx.workspaceId, { type: ["work_order.transitioned", "milestone.revised", "waiting.arrived", "waiting.deferred",
    "waiting.cancelled", "milestone_relation.decided", "work_order.auto_approval_revoked", "ask.answered"] })
    .filter((event) => event.createdAt >= weekAgo && (event.type !== "work_order.transitioned"
      || (event.payload as { event?: { type?: string; approvalId?: string } }).event?.approvalId === ctx.principalId));

  const captureToScheduled = store.listEvents(ctx.workspaceId, { type: "capture.created" }).filter((event) => event.createdAt >= new Date(now.getTime() - 30 * DAY).toISOString())
    .flatMap((event) => {
      const approvedAt = store.listEvents(ctx.workspaceId, { type: "work_order.transitioned", entityId: event.entityId })
        .find((item) => (item.payload as { to?: string }).to === "approved")?.createdAt;
      return approvedAt ? [Math.round((Date.parse(approvedAt) - Date.parse(event.createdAt)) / 60_000)] : [];
    });

  const plan = await loadCurrentPlan(ctx);
  const scheduled = new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:")).map((block) => block.id.split(":")[1]));
  const committed = [...orders.values()].filter((order) => ACTIONABLE.has(order.state) && !(order.payload as { seeded?: boolean }).seeded);
  const progressed = new Set(judged.filter((event) => event.createdAt >= weekAgo).map((event) => (event.payload as { milestoneId?: string }).milestoneId));
  const waiting = store.listWaitingItems(ctx.workspaceId).filter((item) => item.state !== "open");
  const onTime = waiting.filter((item) => Date.parse(item.updatedAt) <= Date.parse(`${item.followUpAt}T00:00:00Z`) + 2 * DAY);

  const result = computeEffectiveness({
    today, milestones, durations, minutesByLine, deadlineMinutes, totalMinutes,
    priorityOrder: identityLines(ctx).map((pack) => pack.id),
    decisions: { count: decisionEvents.length, minutes: 0 }, captureToScheduledMinutes: captureToScheduled, pendingNow: countPending(ctx).total,
    committedOrders: committed.length, committedWithBlock: committed.filter((order) => scheduled.has(order.id)).length,
    liveMilestones: approved.length, milestonesWithProgressLast7d: approved.filter((milestone) => progressed.has(milestone.id)).length,
    waitingAnswered: waiting.length, waitingAnsweredOnTime: onTime.length,
    relationChecks: relationChecks(store, ctx.workspaceId)
  });
  // Out-of-sample accuracy from the calibration's own rolling backtest, when it has evaluated anything.
  const backtest = workspaceCalibration(ctx, now).backtest;
  if (backtest.evaluated > 0) {
    result.estimates = { ...result.estimates, maeRaw: round(backtest.maeRaw), maeCalibrated: round(backtest.maeCalibrated),
      coverageRaw: round(backtest.coverageRaw), coverageCalibrated: round(backtest.coverageCalibrated) };
  }
  return { ...result, decisionMinutesMeasured: false };
}

const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;
