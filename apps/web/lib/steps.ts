import "server-only";
import { randomUUID } from "node:crypto";
import { taskProgress, type AccessContext } from "@crossline/core";
import type { StoredStepPlan } from "@crossline/db";
import { getStore } from "./crossline";

/** A task's step plan with its overall progress (0–1), or undefined while it has not been planned yet. */
export function loadStepPlan(ctx: AccessContext, workOrderId: string): (StoredStepPlan & { progress: number }) | undefined {
  const plan = getStore().getStepPlan(ctx.workspaceId, workOrderId);
  return plan ? { ...plan, progress: taskProgress(plan.steps) } : undefined;
}

/**
 * Asks the worker to plan the task's steps again, with what to change in the person's own words. The worker picks it up on its next pass;
 * done steps are kept.
 */
export function requestStepReplan(ctx: AccessContext, workOrderId: string, feedback: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  if (!store.listWorkOrders(ctx.workspaceId).some((order) => order.id === workOrderId)) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `task.steps_replan_requested:${workOrderId}:${randomUUID()}`,
    type: "task.steps_replan_requested", entityId: workOrderId, payload: { feedback: feedback.trim().slice(0, 1000) } });
  return { ok: true };
}

/** The person's own reading of a step: quarters done, finished, or not needed after all. */
export function recordStepProgress(ctx: AccessContext, workOrderId: string, stepId: string,
  change: { progressQuarter?: number; status?: "planned" | "done" | "skipped" }): { ok: true; changed: boolean } | { ok: false; code: string } {
  try {
    return { ok: true, changed: getStore().updateStepProgress(ctx.workspaceId, workOrderId, stepId, change, ctx.principalId, "person").changed };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "STEP_PROGRESS_FAILED" };
  }
}
