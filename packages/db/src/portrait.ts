import { answeredOnTime, sayDoReadings, scheduledMinutesKey, type SayDoReading } from "@crossline/core";
import type { CrosslineStore } from "./index";

const WINDOW_DAYS = 28;

/**
 * The portrait's say–do "does" side read from the ledger (decided 2026-10-12), shared by the page and the portrait writer. Read only.
 * Two approximations, both small over four weeks and replaced once completion confirmations record exact times (P-A step 3):
 * an execution is put on the UTC day it started while the plan's minutes are recorded per local day (at most a day apart), and a
 * step's completion day is its `updatedAt`, which a later edit moves.
 */
export function sayDoFor(store: CrosslineStore, workspaceId: string, now: Date): SayDoReading {
  const executions = store.listExecutions(workspaceId);
  const today = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  // Planned against worked, over the recent days the plan's minutes were recorded for.
  const planned = new Map<string, number>();
  for (const [key, raw] of store.listSettings(workspaceId, [scheduledMinutesKey("")])) {
    const day = key.slice(scheduledMinutesKey("").length);
    if (day < since || day > today) continue;
    try { planned.set(day, Object.values(JSON.parse(raw) as Record<string, number>).reduce((sum, minutes) => sum + (Number(minutes) || 0), 0)); } catch { /* unreadable day */ }
  }
  const workedMinutes = executions.filter((run) => run.endedAt && planned.has(run.startedAt.slice(0, 10)))
    .reduce((sum, run) => sum + Math.max(0, (Date.parse(run.endedAt!) - Date.parse(run.startedAt)) / 60_000 - run.pauseMinutes), 0);

  // Steps with a due day that is done or already past; on time when marked done no later than that day.
  const steps = store.listStepPlans(workspaceId).flatMap((plan) => plan.steps)
    .filter((step) => step.dueBy && step.status !== "skipped" && (step.status === "done" || step.dueBy < today));

  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order.state]));
  const started = [...new Set(executions.map((run) => run.workOrderId))];
  const handedIn = new Set(store.listEvents(workspaceId, { type: "work_order.transitioned" })
    .filter((event) => (event.payload as { to?: string }).to === "evidence_review").map((event) => event.entityId));
  const waiting = store.listWaitingItems(workspaceId).filter((item) => item.state !== "open");

  return sayDoReadings({
    now, firstExecutionAt: executions[0]?.startedAt ?? null, executions: executions.length,
    plannedMinutes: [...planned.values()].reduce((sum, minutes) => sum + minutes, 0), workedMinutes,
    stepsDue: steps.length, stepsOnTime: steps.filter((step) => step.status === "done" && step.updatedAt.slice(0, 10) <= step.dueBy).length,
    started: started.length, finished: started.filter((id) => orders.get(id) === "evidence_review" || orders.get(id) === "accepted").length,
    submitted: handedIn.size, passed: [...handedIn].filter((id) => orders.get(id) === "accepted").length,
    waitingAnswered: waiting.length, waitingOnTime: waiting.filter(answeredOnTime).length
  });
}
