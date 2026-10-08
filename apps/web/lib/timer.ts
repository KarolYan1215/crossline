import "server-only";
import type { AccessContext } from "@crossline/core";
import { getStore, resolvedEstimate } from "./crossline";

export type ActiveTimer = {
  workOrderId: string; intent: string; stepId?: string; stepTitle?: string;
  /** When the running session began (the start, or the last resume). */
  sessionStart: string; paused: boolean;
  /** What this session is expected to take: the current step's usual minutes, else the task's. */
  targetMinutes: number;
  /** Minutes already worked on this task before the running session. */
  workedBefore: number;
};

/**
 * Every task with a running or paused session, for the floating countdown. Read from the executions table, so a reload or another
 * device shows the same timer; nothing about the countdown lives only in the browser.
 */
export function activeTimers(ctx: AccessContext): ActiveTimer[] {
  const store = getStore();
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "active").map((order) => [order.id, order]));
  const executions = store.listExecutions(ctx.workspaceId);
  return executions.filter((execution) => !execution.endedAt && orders.has(execution.workOrderId)).map((execution) => {
    const order = orders.get(execution.workOrderId)!;
    const last = execution.interruptions.at(-1);
    const paused = Boolean(last && !last.resumedAt);
    const sessionStart = last?.resumedAt ?? execution.startedAt;
    const step = store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.status === "planned" && item.schedulable);
    const before = executions.filter((item) => item.workOrderId === order.id && item.durationObserved && item.id !== execution.id && item.endedAt)
      .reduce((sum, item) => sum + Math.max(0, Math.round((Date.parse(item.endedAt!) - Date.parse(item.startedAt)) / 60_000) - item.pauseMinutes), 0)
      + Math.max(0, Math.round((Date.parse(sessionStart) - Date.parse(execution.startedAt)) / 60_000) - execution.pauseMinutes);
    return { workOrderId: order.id, intent: order.intent, ...(step ? { stepId: step.id, stepTitle: step.title } : {}), sessionStart, paused,
      targetMinutes: step?.estimate.p50Minutes ?? resolvedEstimate(ctx, order).p50Minutes, workedBefore: before };
  });
}
