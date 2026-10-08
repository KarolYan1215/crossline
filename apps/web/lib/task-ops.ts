import "server-only";
import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import type { AccessContext, TaskOp } from "@crossline/core";
import { addWaitingForOrder, archiveWorkOrder, effectiveSchedulePreferences, getStore, planToday, startWorkOrderExecution } from "./crossline";
import { applyChange } from "./impact";
import { editSteps, recordStepProgress, reportProgress, requestStepReplan } from "./steps";
import { requestTutorial } from "./tutorial";

type Result = { ok: true } | { ok: false; code: string };

/** The person's own words about the task, kept in its record (the 记录 tab lists them). */
export function recordTaskNote(ctx: AccessContext, workOrderId: string, text: string, kind = "note"): Result {
  const note = text.trim().slice(0, 1000);
  if (!note) return { ok: false, code: "NOTE_EMPTY" };
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `task.note:${workOrderId}:${randomUUID()}`,
    type: "task.note", entityId: workOrderId, payload: { text: note, kind } });
  return { ok: true };
}

/** A self-report of energy right now, with what the person said about it; a low one is also remembered for when work is placed. */
export function recordEnergy(ctx: AccessContext, level: "low" | "medium" | "high", note: string, workOrderId?: string): Result {
  const store = getStore();
  const id = randomUUID(), at = new Date();
  store.saveEnergyObservation({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, source: "self_report", level, confidence: "medium",
    aggregate: {}, observedAt: at.toISOString() });
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `energy-observed:${id}`, type: "energy.observed", entityId: id,
    payload: { source: "self_report", level, confidence: "medium", context: "general", ...(workOrderId ? { workOrderId } : {}), ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}) } });
  if (level === "low") {
    const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
    const when = formatInTimeZone(at, zone, "EEEE HH:00");
    store.addPreference({ workspaceId: ctx.workspaceId, source: "postpone", scope: "all", weight: 0.5, refId: `energy:${formatInTimeZone(at, zone, "e-HH")}`,
      text: `${when} 前后自评精力低${note.trim() ? `（${note.trim().slice(0, 80)}）` : ""}，此时段宜安排低强度任务` });
  }
  return { ok: true };
}

/** Carries out one operation the task's assistant read out of what the person said. */
export async function applyTaskOp(ctx: AccessContext, workOrderId: string, op: TaskOp): Promise<Result> {
  switch (op.type) {
    case "due": return applyChange(ctx, { kind: "due", workOrderId, date: op.date });
    case "defer": return applyChange(ctx, { kind: "defer", workOrderId, date: op.date });
    case "estimate": return applyChange(ctx, { kind: "estimate", workOrderId, p50Minutes: op.minutes, ...(op.stepId ? { stepId: op.stepId } : {}) });
    case "step_done": return recordStepProgress(ctx, workOrderId, op.stepId, { status: "done" });
    case "step_add": {
      const plan = getStore().getStepPlan(ctx.workspaceId, workOrderId);
      if (!plan) return requestStepReplan(ctx, workOrderId, `增加步骤：${op.text}`);
      const open = plan.steps.filter((step) => step.status === "planned").map((step) => ({ id: step.id, title: step.title }));
      return editSteps(ctx, workOrderId, [...open, { title: op.text }]);
    }
    case "replan": return requestStepReplan(ctx, workOrderId, op.text);
    case "waiting": return addWaitingForOrder(ctx, workOrderId, { who: op.who, what: op.text, expectedAt: op.date, approximate: true });
    case "energy": return recordEnergy(ctx, op.energy as "low" | "medium" | "high", op.text, workOrderId);
    case "note": return recordTaskNote(ctx, workOrderId, op.text);
    case "progress": { const result = reportProgress(ctx, workOrderId, op.text); return result.ok ? { ok: true } : result; }
    case "archive": return archiveWorkOrder(ctx, workOrderId, op.text);
    case "start": return startWorkOrderExecution(ctx, workOrderId);
    case "tutorial": return requestTutorial(ctx, workOrderId);
    default: return { ok: false, code: "TASK_OP_UNKNOWN" };
  }
}

export type PostponeReason = "waiting" | "energy" | "conflict" | "time" | "other";
const REASON_LABEL: Record<PostponeReason, string> = { waiting: "等待他人提供", energy: "精力不足", conflict: "与其他事项冲突", time: "时间不够", other: "其他" };

/**
 * 推迟, with why: the reason decides what else changes. Waiting for someone becomes a waiting item (the task stays off the schedule until
 * it arrives); low energy records the energy at this moment (and, for placing work later, when it tends to be low); a clash or no time
 * moves the start to the chosen day. Every reason is kept on the record, and a free-text one is handed to the task's assistant.
 */
export function postponeTask(ctx: AccessContext, workOrderId: string, input: { reason: PostponeReason; date: string; who: string; what: string; text: string }): Result {
  const today = planToday(ctx);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date) && input.date > today ? input.date : tomorrow;
  let result: Result;
  if (input.reason === "waiting") {
    if (!input.what.trim()) return { ok: false, code: "POSTPONE_WHAT_REQUIRED" };
    result = addWaitingForOrder(ctx, workOrderId, { who: input.who, what: input.what, expectedAt: date, approximate: true });
  } else {
    if (input.reason === "energy") { const energy = recordEnergy(ctx, "low", input.text, workOrderId); if (!energy.ok) return energy; }
    result = applyChange(ctx, { kind: "defer", workOrderId, date });
  }
  if (!result.ok) return result;
  const store = getStore();
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `task.postponed:${workOrderId}:${randomUUID()}`,
    type: "task.postponed", entityId: workOrderId, payload: { reason: input.reason, until: date, text: input.text.trim().slice(0, 300) } });
  recordTaskNote(ctx, workOrderId, `推迟至 ${date} · ${REASON_LABEL[input.reason]}${input.reason === "waiting" ? `：${input.who ? `${input.who} · ` : ""}${input.what}` : input.text.trim() ? `：${input.text.trim()}` : ""}`, "postpone");
  return { ok: true };
}
