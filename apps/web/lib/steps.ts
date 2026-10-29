import "server-only";
import { randomUUID } from "node:crypto";
import { clipWidth, FIRST_ACTION_MAX, stepAnswerSlot, taskProgress, type AccessContext } from "@crossline/core";
import { chooseStepOwner, provideMaterial, type StoredStepPlan, type StoredWorkOrder } from "@crossline/db";
import { getStore } from "./crossline";
import { requestCodexSupervisor } from "./codex-runtime";
import { tOf } from "./locale";

/** Each task's next block on the calendar (today or later), for the card's 「下一次」 line. */
export function nextSlots(blocks: Array<{ id: string; day?: string | undefined; start: string; end: string }>, today: string): Map<string, { day: string; start: string; end: string }> {
  const slots = new Map<string, { day: string; start: string; end: string }>();
  for (const block of blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day || block.day < today) continue;
    const id = block.id.split(":")[1]!;
    const current = slots.get(id);
    if (!current || `${block.day} ${block.start}` < `${current.day} ${current.start}`) slots.set(id, { day: block.day, start: block.start, end: block.end });
  }
  return slots;
}

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
  requestTaskPass(ctx);
  return { ok: true };
}

/** Asks the worker to run its task pass now (planning, replans, progress reports) instead of at the next tick. */
export function requestTaskPass(ctx: AccessContext): void {
  requestCodexSupervisor(ctx, "/v1/tasks/pass", { method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

/** A progress report in the person's own words; the progress judge reads it against the steps and standards. */
export function reportProgress(ctx: AccessContext, workOrderId: string, text: string): { ok: true; reportId: string } | { ok: false; code: string } {
  const store = getStore();
  if (!text.trim()) return { ok: false, code: "PROGRESS_REPORT_EMPTY" };
  if (!store.listWorkOrders(ctx.workspaceId).some((order) => order.id === workOrderId)) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  const reportId = randomUUID();
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `task.progress_reported:${reportId}`,
    type: "task.progress_reported", entityId: workOrderId, payload: { reportId, text: text.trim().slice(0, 2000) } });
  requestTaskPass(ctx);
  return { ok: true, reportId };
}

/** The person saying a standard is met with nothing to hand in: the ring turns full. */
export function confirmCriterion(ctx: AccessContext, workOrderId: string, criterionId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  if (!store.listWorkOrders(ctx.workspaceId).some((order) => order.id === workOrderId)) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `criterion.confirmed:${workOrderId}:${criterionId}`,
    type: "criterion.confirmed", entityId: workOrderId, payload: { criterionId } });
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === workOrderId)!;
  const statement = store.listMilestones(ctx.workspaceId).filter((item) => item.id === order.milestoneId).at(-1)?.successCriteria
    .find((criterion) => criterion.id === criterionId)?.statement ?? criterionId;
  store.addPreference({ workspaceId: ctx.workspaceId, source: "standard_confirmed", scope: order.identityId, weight: 0.3, refId: `${workOrderId}:${criterionId}`,
    text: tOf(ctx)("任务「{{task}}」的标准「{{statement}}」由本人确认达成，未提交成果", { task: order.intent, statement }) });
  return { ok: true };
}

/**
 * The person's own edit of the step list: reordered, removed or added steps. Kept steps keep their estimates and criteria; a new step
 * gets a 30-minute estimate the planner's next pass can refine; the list is chained in its new order. Done steps are never touched.
 */
export function editSteps(ctx: AccessContext, workOrderId: string, edited: Array<{ id?: string; title: string }>): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const plan = store.getStepPlan(ctx.workspaceId, workOrderId);
  if (!plan) return { ok: false, code: "STEP_PLAN_NOT_FOUND" };
  const byId = new Map(plan.steps.filter((step) => step.status === "planned").map((step) => [step.id, step]));
  const kept = edited.filter((item) => item.title.trim()).slice(0, 40);
  if (!kept.length) return { ok: false, code: "STEPS_EMPTY" };
  const steps = kept.map((item, index) => {
    const old = item.id ? byId.get(item.id) : undefined;
    return { id: `e${index + 1}`, role: old?.role ?? "deliver", title: item.title.trim().slice(0, 120), deliverable: old?.deliverable ?? "",
      doneCriterion: old?.doneCriterion ?? "", share: old?.share ?? 0, estimate: old?.estimate ?? { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 },
      dependsOn: index ? [`e${index}`] : [], notBefore: old?.notBefore ?? "", dueBy: old?.dueBy ?? "", schedulable: old?.schedulable ?? true,
      executor: old?.executor ?? "human" as const, tickOutcome: old?.tickOutcome ?? "", covers: old?.covers ?? [], why: old?.why ?? "", ...(old?.aiAssist ? { aiAssist: old.aiAssist } : {}),
      // A renamed step's first move may no longer fit it; an unchanged one keeps it.
      ...(old?.firstAction && old.title === item.title.trim() ? { firstAction: old.firstAction } : {}) };
  });
  const total = steps.reduce((sum, step) => sum + step.share, 0) || 1;
  const remaining = 1 - plan.steps.filter((step) => step.status !== "planned").reduce((sum, step) => sum + step.share, 0);
  for (const step of steps) step.share = step.share ? (step.share / total) * remaining : remaining / steps.length;
  store.saveStepPlan(ctx.workspaceId, workOrderId, { archetypeId: plan.archetypeId, quantity: plan.quantity, rationale: plan.rationale,
    units: plan.units, questions: plan.questions, steps },
    ctx.principalId, "edited");
  return { ok: true };
}

/**
 * The person hands one step to the assistant or takes it back (the owner's 4A, 2026-10-22); the choice holds for that kind of step on the
 * line. A step handed over is started by the worker's next pass.
 */
export function chooseOwnerOfStep(ctx: AccessContext, workOrderId: string, stepId: string, owner: "person" | "assistant"): { ok: true } | { ok: false; code: string; message: string } {
  const result = chooseStepOwner(getStore(), ctx.workspaceId, workOrderId, stepId, owner, ctx.principalId);
  if (!result.ok) return { ok: false, code: "STEP_OWNER_REFUSED", message: result.reason };
  if (owner === "assistant") requestTaskPass(ctx);
  return { ok: true };
}

/** A provide step settled: the files (already stored under the task's project) or 「没有」; what waited on it goes ahead. */
export function settleProvideStep(ctx: AccessContext, workOrderId: string, stepId: string, how: "file" | "none", documentIds: string[] = []):
  { ok: true } | { ok: false; code: string; message: string } {
  const result = provideMaterial(getStore(), ctx.workspaceId, workOrderId, stepId, how, documentIds, ctx.principalId);
  if (!result.ok) return { ok: false, code: "STEP_PROVIDE_REFUSED", message: result.reason };
  requestTaskPass(ctx);
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

/** The person's 「下次从哪接」 when a session ends with the step unfinished: the step's first action from now on. */
export function noteResumePoint(ctx: AccessContext, workOrderId: string, stepId: string, text: string): { ok: true; changed: boolean } | { ok: false; code: string } {
  const note = clipWidth(text.replace(/\s+/gu, " ").trim(), FIRST_ACTION_MAX);
  if (!note) return { ok: false, code: "RESUME_NOTE_EMPTY" };
  try {
    return { ok: true, changed: getStore().setStepResumeNote(ctx.workspaceId, workOrderId, stepId, note, ctx.principalId).changed };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "RESUME_NOTE_FAILED" };
  }
}

/**
 * Records the person's answer to one step question as a confirmed fact under the question's slot (the project's, so it answers every
 * task of the project that asked it). Shared by the 待确认 cards and by changing an answer on the task.
 */
export function recordStepAnswer(ctx: AccessContext, order: Pick<StoredWorkOrder, "identityId" | "projectId">, question: string, answer: string, quote = answer): void {
  getStore().upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: order.identityId, projectId: order.projectId, slot: stepAnswerSlot(question),
    value: `【${question}】${answer}`, status: "confirmed", sourceRef: "ask", sourceQuote: quote, updatedAt: new Date().toISOString() });
}

/**
 * The person's answer to one of the task's plan questions, given or changed on the task itself: an assumption the app wrote becomes
 * their own word, and the task is planned again with it.
 */
export function changeStepAnswer(ctx: AccessContext, workOrderId: string, question: string, answer: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (!store.getStepPlan(ctx.workspaceId, workOrderId)?.questions.some((item) => item.text === question)) return { ok: false, code: "STEP_QUESTION_GONE" };
  const text = answer.trim();
  if (!text) return { ok: false, code: "STEP_ANSWER_EMPTY" };
  recordStepAnswer(ctx, order, question, text.slice(0, 300));
  // i18n-ignore: feedback for the step planner (model context)
  return requestStepReplan(ctx, workOrderId, `本人把「${question}」的回答定为：${text.slice(0, 300)}。按此重新安排步骤。`);
}
