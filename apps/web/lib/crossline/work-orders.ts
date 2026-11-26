import "server-only";
import { randomUUID } from "node:crypto";
import { recordPersonNote, type EvidenceClaimInput } from "@crossline/db";
import { requiredApproval, taskTitleOf, restoreTargetOf, type AccessContext, type ChecklistAnswer } from "@crossline/core";
import { durationPriorFor } from "../estimate-calibration";
import { completionRule, type CompletionMode, type CompletionOutcome } from "@crossline/core";
import { localeFor, tOf } from "../locale";
import { ensureSeeded, seedIdentities } from "./seed";
import { getStore } from "./store";
import { appNow, planToday } from "./clock";

const FAMILIES = ["preparation", "review", "deep_work"] as const;
type Family = typeof FAMILIES[number];

export type ManualPromotionInput = {
  identityId: unknown; intent: unknown; milestoneId: unknown; family: unknown;
  estimate: unknown; evidenceContract: unknown;
};

/**
 * The manual fallback `docs/archive/crossline-plan-critical-review.md` §4 asked for and this app never built:
 * when Codex is unavailable, a capture can be promoted to a WorkOrder by hand instead of dying at
 * "分析服务不可用" with no other exit. Skips `awaiting_plan_approval` and lands directly on `approved` —
 * promoting it by hand already is the approval, so approving it again would be asking the same person
 * to confirm their own decision. `payload.manualPromotion` marks the result so nothing downstream
 * (Workbench, Approvals) mistakes it for an analysed proposal.
 */
export function promoteCaptureManually(ctx: AccessContext, captureId: string, input: ManualPromotionInput):
  { ok: true } | { ok: false; code: string } {
  ensureSeeded(ctx);
  const identityId = typeof input.identityId === "string" ? input.identityId : "";
  if (!seedIdentities().some((pack) => pack.id === identityId)) return { ok: false, code: "IDENTITY_UNKNOWN" };
  const intent = typeof input.intent === "string" ? input.intent.trim() : "";
  if (!intent || intent.length > 400) return { ok: false, code: "INTENT_INVALID" };
  // Empty is a legitimate answer, the same sentinel `acceptWorkOrderEvidence` already treats as
  // "not milestone-bound" — this is not a lesser WorkOrder, just one with no gate to pass.
  const milestoneId = typeof input.milestoneId === "string" ? input.milestoneId : "";
  if (milestoneId && !getStore().listMilestones(ctx.workspaceId).some((item) =>
    item.id === milestoneId && item.status === "approved" && item.identityId === identityId))
    return { ok: false, code: "MILESTONE_NOT_APPROVED" };
  const estimateInput = input.estimate as { p25Minutes?: unknown; p50Minutes?: unknown; p85Minutes?: unknown } | null;
  const p25 = Number(estimateInput?.p25Minutes), p50 = Number(estimateInput?.p50Minutes), p85 = Number(estimateInput?.p85Minutes);
  if (![p25, p50, p85].every(Number.isFinite) || p25 < 1 || p25 > p50 || p50 > p85 || p85 > 10080)
    return { ok: false, code: "ESTIMATE_INVALID" };
  const evidenceContract = (Array.isArray(input.evidenceContract) ? input.evidenceContract : [])
    .filter((item): item is { kind?: unknown; description?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({
      kind: (["file", "link", "telemetry"] as const).includes(item.kind as never) ? item.kind as "file" | "link" | "telemetry" : "record" as const,
      description: typeof item.description === "string" ? item.description.trim().slice(0, 300) : "",
      required: true
    }))
    .filter((item) => item.description.length > 0);
  if (!evidenceContract.length) return { ok: false, code: "EVIDENCE_CONTRACT_REQUIRED" };
  const family = typeof input.family === "string" && FAMILIES.includes(input.family as Family) ? input.family : undefined;
  const workOrderId = `manual-${randomUUID()}`;
  return getStore().promoteCaptureManually(ctx.workspaceId, captureId, {
    id: workOrderId, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, identityId,
    projectId: `${identityId}-default`, milestoneId, intent, state: "approved", riskTier: "routine",
    estimate: { p25Minutes: p25, p50Minutes: p50, p85Minutes: p85, source: "manual", observationCount: 0, confidence: "low" },
    payload: { manualPromotion: true, promotedBy: ctx.principalId, promotedAt: new Date().toISOString(),
      materialContract: [], evidenceContract, ...(family ? { family } : {}) }
  // A fresh key per call, not one fixed per capture: a form resubmission can legitimately carry
  // different content (the person fixing a typo after a rejection), and that must reach the store's own
  // `CAPTURE_ALREADY_PROMOTED` check rather than being silently swallowed as an idempotent no-op that
  // reports success while keeping whichever content happened to land first.
  }, `manual-promotion:${captureId}:${randomUUID()}`);
}

export function addCapturedTaskWithId(
  ctx: AccessContext,
  input: { title: string; context?: string },
  id: string,
  idempotencyKey: string
): string {
  getStore().capture({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    title: input.title, context: input.context ?? "" }, idempotencyKey, ctx.authMethod === "mcp" ? ctx.via : undefined);
  return id;
}

export type ExecutionResult = { ok: true } | { ok: false; code: string };

// A WorkOrder can be executed more than once (blocked → approved → restarted), so every execution-scoped
// idempotency key is numbered by how many executions that WorkOrder already has.
function executionRun(workspaceId: string, workOrderId: string): number {
  return getStore().listExecutions(workspaceId).filter((item) => item.workOrderId === workOrderId).length;
}

function findWorkOrder(workspaceId: string, workOrderId: string) {
  return getStore().listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
}

/**
 * Approves a proposal. `acceptanceStandard` is the standard as the person edited it on the card before approving (one line per item, in
 * the order of the proposal's evidence contract): it replaces the contract's wording, and from then on the task is judged by it and
 * nothing more (the owner's decision of 2026-10-15). Without it the proposal's own contract is the standard, fixed at approval.
 */
export function approveWorkOrderProposal(ctx: AccessContext, workOrderId: string, options: { acceptanceStandard?: string[]; completionMode?: CompletionMode } = {}): ExecutionResult {
  if (requiredApproval("approve_work_orders") === "never") return { ok: false, code: "APPROVAL_NOT_PERMITTED" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "approved") return { ok: true };
  // A blocked WorkOrder is recoverable by the same human approval that admitted it; the transition table
  // has always allowed it, and refusing here would strand a real item with no way back.
  if (workOrder.state !== "awaiting_plan_approval" && workOrder.state !== "blocked") return { ok: false, code: "PROPOSAL_NOT_APPROVABLE" };
  const edited = (options.acceptanceStandard ?? []).map((line) => String(line).trim().slice(0, 300)).filter(Boolean).slice(0, 10);
  if (edited.length) {
    const payload = (workOrder.payload ?? {}) as { evidenceContract?: Array<{ kind?: string; description?: string; why?: string; required?: boolean }> };
    const before = payload.evidenceContract ?? [];
    const evidenceContract = edited.map((description, index) => ({ kind: before[index]?.kind ?? "record", description,
      why: before[index]?.why ?? tOf(ctx)("本人批准时定下的验收标准"), required: before[index]?.required ?? true }));
    getStore().saveWorkOrder({ ...workOrder, payload: { ...payload, evidenceContract,
      acceptanceStandard: { fixedAt: new Date().toISOString(), lines: edited, by: "person" } } });
  }
  if (options.completionMode) setCompletionMode(ctx, workOrderId, options.completionMode);
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "plan.approved", approvalId: ctx.principalId },
    `proposal-approved:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`);
  return { ok: true };
}

/**
 * The person's own choice of how finishing a task is taken (「点完成即验收」 / 「完成后再问结果」), on the proposal card or the task: it
 * overrides the model's judgement (`completionRule` in core). Any state before completion.
 */
export function setCompletionMode(ctx: AccessContext, workOrderId: string, mode: CompletionMode): ExecutionResult {
  if (mode !== "self_evident" && mode !== "needs_assessment") return { ok: false, code: "COMPLETION_MODE_INVALID" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (["accepted", "archived"].includes(workOrder.state)) return { ok: false, code: "WORK_ORDER_CLOSED" };
  getStore().saveWorkOrder({ ...workOrder, payload: { ...((workOrder.payload ?? {}) as object), completionMode: mode } });
  return { ok: true };
}

/**
 * Materials are ready. `source` records who actually prepared them: until AI preparation lands the
 * honest answer is "the human did", and a preparation that never finishes must not strand the item.
 */
export function markMaterialsReady(ctx: AccessContext, workOrderId: string, source: "human" | "ai"): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "ready_for_human") return { ok: true };
  if (workOrder.state !== "preparing") return { ok: false, code: "MATERIALS_NOT_PREPARING" };
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "materials.ready" },
    `materials-ready:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}:${source}`);
  return { ok: true };
}

/**
 * Asks for material preparation to be tried again.
 *
 * A failed preparation is deliberately not retried on a timer, so without this an order blocked by a
 * transient failure — or by a bug that has since been fixed — stayed blocked forever with only the
 * "I prepared them myself" escape.
 */
export function retryMaterialPreparation(ctx: AccessContext, workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "preparing") return { ok: false, code: "MATERIALS_NOT_PREPARING" };
  getStore().appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `materials:retry:${workOrderId}:${Date.now()}`,
    type: "materials.retry_requested", entityId: workOrderId, payload: { requestedBy: ctx.principalId }
  });
  return { ok: true };
}

/**
 * Reasons the system itself gave when it withdrew work (demo cleanup, a re-split, an input the person handed over). Those withdrawals are
 * the system's own drafts being replaced, not decisions the person made, and the 已丢弃 drawer does not show them — the person sees
 * the plan as it now stands, not every version it went through. Newer withdrawals carry `bySystem` on the event instead of relying on
 * this list; it covers the ones written before that flag existed.
 */
// Older rows carry the earlier wording, so both forms stay in the list.
// i18n-ignore-start: stored reasons matched by code
const SYSTEM_ARCHIVE_REASONS = ["示例作业自动清理", "自动反推旧版", "你已经在等这项输入", "你已经提供了这项输入", "你说这个里程碑先不拆",
  "该输入已在等待中", "该输入已由本人提供", "本人选择暂不拆分该里程碑"];
// i18n-ignore-end
export function archivedBySystem(payload: unknown): boolean {
  const value = payload as { bySystem?: boolean; reason?: string } | undefined;
  return value?.bySystem === true || SYSTEM_ARCHIVE_REASONS.some((reason) => (value?.reason ?? "").startsWith(reason));
}

/**
 * Discards a WorkOrder the person does not want, with their reason on the record.
 *
 * Every state in the machine has always allowed `archived`, but nothing in the app ever emitted it, so
 * a proposal the analysis got wrong stayed on the board forever with only "approve it" or "leave it
 * sitting there" as options. An accepted WorkOrder is excluded: discarding finished work would be
 * rewriting history rather than cleaning up an inbox.
 */
export function archiveWorkOrder(ctx: AccessContext, workOrderId: string, reason: string, options: { bySystem?: boolean } = {}): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "archived") return { ok: true };
  if (workOrder.state === "accepted") return { ok: false, code: "WORK_ORDER_ALREADY_ACCEPTED" };
  const store = getStore();
  // Keyed per attempt: a restored order can be archived again, and a fixed key would make that second archive a silent no-op.
  const attempt = store.listEvents(ctx.workspaceId, { type: "work_order.archived", entityId: workOrderId }).length;
  const suffix = attempt ? `:${attempt}` : "";
  // The reason rides on its own event rather than the transition: `transitionWorkOrder` carries only
  // the fields the state machine itself validates, and a discard reason is a note, not a state input.
  // It is optional — a slip or a duplicate needs no explanation. `from` is what a restore goes back to.
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `archive-reason:${workOrderId}${suffix}`,
    type: "work_order.archived", entityId: workOrderId,
    payload: { reason: reason.trim().slice(0, 200), from: workOrder.state, ...(options.bySystem ? { bySystem: true } : {}) }
  });
  const result = store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "archived" }, `archive:${workOrderId}${suffix}`);
  if (!result.changed) return { ok: false, code: "WORK_ORDER_NOT_ARCHIVABLE" };
  return { ok: true };
}

/** Takes an archived order back to the state it was archived from (恢复 in the archive drawer, or an undo). */
export function restoreWorkOrder(ctx: AccessContext, workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "archived") return { ok: true };
  const store = getStore();
  const archives = store.listEvents(ctx.workspaceId, { type: "work_order.archived", entityId: workOrderId });
  const to = restoreTargetOf((archives.at(-1)?.payload as { from?: string } | undefined)?.from);
  const result = store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "archive.restored", to },
    `archive-restored:${workOrderId}:${archives.length}`);
  return result.changed ? { ok: true } : { ok: false, code: "WORK_ORDER_NOT_RESTORABLE" };
}

/** Takes a discarded capture back to where it was. */
export function restoreCapture(ctx: AccessContext, captureId: string): ExecutionResult {
  try {
    getStore().restoreCapture(ctx.workspaceId, captureId);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CAPTURE_RESTORE_FAILED";
    return { ok: false, code };
  }
}

/** Discards a raw capture. The WorkOrder equivalent is `archiveWorkOrder`; captures had no exit. */
export function discardCapture(ctx: AccessContext, captureId: string, reason: string): ExecutionResult {
  try {
    getStore().discardCapture(ctx.workspaceId, captureId, reason);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CAPTURE_DISCARD_FAILED";
    return { ok: false, code };
  }
}

/** Whether the person could start this order now without waiting for materials (see `plannerTaskOf`). */
export function inputsReady(order: { state: string; payload: unknown }): boolean {
  if (order.state === "ready_for_human" || order.state === "active") return true;
  return order.state === "approved" && !((order.payload as { materialContract?: unknown[] } | undefined)?.materialContract ?? []).length;
}

/**
 * The step a session is about: started from a block, it is that block's step, not the task's first open one (2026-11-11, W-258: the
 * owner started step 7 from its block and the timer and the completion sheet said step 5). Kept as an event the timer reads
 * (`activeTimers`), so the executions table needs no new column. A step that is not the task's or is no longer open is not taken.
 */
export const STEP_FOCUSED = "task.step_focused";
export function focusStep(ctx: AccessContext, workOrderId: string, stepId: string): boolean {
  const store = getStore();
  if (!store.getStepPlan(ctx.workspaceId, workOrderId)?.steps.some((step) => step.id === stepId && step.status === "planned")) return false;
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${STEP_FOCUSED}:${workOrderId}:${randomUUID()}`,
    type: STEP_FOCUSED, entityId: workOrderId, payload: { stepId } });
  return true;
}

export function startWorkOrderExecution(ctx: AccessContext, workOrderId: string, at?: string): ExecutionResult {
  const store = getStore();
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "active") {
    // Active with no open session: a confirmed block closed the last one, and starting again has to time something.
    if (!store.listExecutions(ctx.workspaceId, workOrderId).some((execution) => !execution.endedAt))
      store.openSession(ctx.workspaceId, workOrderId, ctx.principalId, at);
    return { ok: true };
  }
  const run = executionRun(ctx.workspaceId, workOrderId);
  if (workOrder.state === "approved") {
    // Needing materials used to be a dead end: nothing emitted `automation.started`, so any WorkOrder
    // whose analysis did its job was stuck forever. Preparation is now a real state you pass through.
    const materials = (workOrder.payload as { materialContract?: unknown[] }).materialContract ?? [];
    // Already prepared once. Sending it back to `preparing` would strand it: the worker skips orders
    // that already have materials, so nothing would ever move it on, and the person would be looking at
    // 「材料准备中」 for materials sitting on disk. This is the path a restored-from-blocked order takes.
    if (materials.length && store.listMaterials(ctx.workspaceId, workOrderId).length === 0) {
      store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "automation.started" }, `materials-preparing:${workOrderId}:${run}`);
      return { ok: false, code: "MATERIALS_PREPARING" };
    }
    store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "materials.not_required" }, `materials-not-required:${workOrderId}:${run}`);
  } else if (workOrder.state === "preparing") {
    // Prepared ahead of its first block (docs/plans/closed-loop-1030.md §5) and not ready yet: said as what it is.
    return { ok: false, code: "MATERIALS_PREPARING" };
  } else if (workOrder.state !== "ready_for_human") {
    return { ok: false, code: "EXECUTION_NOT_STARTABLE" };
  }
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "human.started" }, `execution:${workOrderId}:${run}:started`,
    { durationObserved: true, ...(at ? { occurredAt: at } : {}) });
  return { ok: true };
}

export function pauseWorkOrderExecution(ctx: AccessContext, workOrderId: string, reason: string, at?: string): ExecutionResult {
  if (!reason.trim()) return { ok: false, code: "INTERRUPTION_REASON_REQUIRED" };
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active" || !hasOpenSession(ctx.workspaceId, workOrderId)) return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().pauseExecution(ctx.workspaceId, workOrderId, reason.trim(), at);
  return { ok: true };
}

export function resumeWorkOrderExecution(ctx: AccessContext, workOrderId: string, at?: string): ExecutionResult {
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active" || !hasOpenSession(ctx.workspaceId, workOrderId)) return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().resumeExecution(ctx.workspaceId, workOrderId, at);
  return { ok: true };
}

/**
 * The timed work ended at `at` (an ISO instant, or `minutes` after the open session began): 「早停了」 on the 「超时」 message, a forgotten
 * timer stopped by the nudge pass, or a correction (`stop_at` on the execution route). The session stays open and paused from then.
 */
export function stopWorkOrderExecutionAt(ctx: AccessContext, workOrderId: string, when: { at: string } | { minutes: number }, reason: string,
  now = appNow()): ExecutionResult & { stoppedAt?: string } {
  if (findWorkOrder(ctx.workspaceId, workOrderId)?.state !== "active") return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  const open = getStore().listExecutions(ctx.workspaceId, workOrderId).find((execution) => !execution.endedAt);
  if (!open) return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  const at = "at" in when ? when.at : new Date(Date.parse(open.startedAt) + Math.max(0, when.minutes) * 60_000).toISOString();
  if (!Number.isFinite(Date.parse(at))) return { ok: false, code: "STOP_TIME_INVALID" };
  const result = getStore().stopSessionAt(ctx.workspaceId, workOrderId, at, reason.trim() || "计时截止", now.toISOString()); // i18n-ignore: stored reason
  return { ok: true, ...(result.stoppedAt ? { stoppedAt: result.stoppedAt } : {}) };
}

/**
 * An active order can have no open session: a confirmed block (the completion check, the wrap-up, the return page) closes the session it
 * covers while the task stays active. Pausing or resuming it then is a refusal, not a store error: the floating timer's 结束 pressed after
 * answering 「做得怎么样」 on the phone threw `NO_ACTIVE_EXECUTION` out of the route (found by the month simulation).
 */
function hasOpenSession(workspaceId: string, workOrderId: string): boolean {
  return getStore().listExecutions(workspaceId, workOrderId).some((execution) => !execution.endedAt);
}

/** What a completion did: always accepted; `followUp` is the question the 小帮手 will ask later when the result is not known yet. */
export type CompletionResult = { ok: true; completion?: { mode: CompletionMode; followUp?: string } } | { ok: false; code: string };

/** Recorded on `assessment.pending`: what to ask about a finished task whose result is not known yet, and from when (`lib/outcome-check.ts`). */
export type PendingAssessment = { reason: string; question: string; askAfter: string; milestoneId: string };

/**
 * The person pressed 完成: that is the acceptance (the owner's decision of 2026-10-15, `completionRule` in core). The order goes through
 * `human.completed` (the session closes, the duration is observed, files are handed on) and straight on to `accepted` — no gate, no
 * question, no evidence required, milestone-bound or not. `outcome` is the optional 「完成情况」 the person gave (顺利 / 勉强 / 有遗漏 and a
 * line). Work whose result is not known when it is finished (`needs_assessment`: an exam's score, a draft's quality, an exploration) also
 * leaves an `assessment.pending` record the 小帮手 asks about later at an idle moment — unless the person already said how it went and
 * nothing else is to come (a score always is).
 */
export function completeWorkOrderExecution(ctx: AccessContext, workOrderId: string, evidence: EvidenceClaimInput[],
  checklistAnswers: ChecklistAnswer[] = [], at?: string, report?: { minutes: number; source: "one_tap" | "activity" },
  outcome?: CompletionOutcome): CompletionResult {
  const store = getStore();
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  // Already handed in (a replayed offline command, or an order completed before this rule that still waits for the gate).
  if (workOrder.state === "evidence_review" || workOrder.state === "accepted") return { ok: true };
  if (workOrder.state !== "active") return { ok: false, code: "EXECUTION_NOT_ACTIVE" };
  const baseline = durationPriorFor(workOrder.identityId, workOrder.payload);
  const run = executionRun(ctx.workspaceId, workOrderId) - 1;
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "human.completed" },
    `execution:${workOrderId}:${run}:completed`,
    { evidence, ...(checklistAnswers.length ? { checklistAnswers } : {}), ...(at ? { occurredAt: at } : {}),
      ...(report ? { reportedMinutes: report.minutes, reportedSource: report.source } : {}),
      ...(baseline ? { durationCalibrationBaseline: baseline } : {}) });
  store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "evidence.accepted", approvalId: ctx.principalId, onCompletion: true },
    `completion-accepted:${workOrderId}:${run}`, { ...(at ? { occurredAt: at } : {}), ...(baseline ? { durationCalibrationBaseline: baseline } : {}) });
  const doneAt = at ?? new Date().toISOString();
  if (outcome) store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.outcome:${workOrderId}:${run}`,
    type: "work_order.outcome_reported", entityId: workOrderId, payload: { level: outcome.level, note: outcome.note, at: doneAt, source: "completion" } });
  // The 「完成情况」 words were kept on the event and read by nothing: they are read for facts now (a score, a date, who said what).
  if (outcome?.note?.trim()) recordPersonNote(store, ctx.workspaceId, ctx.principalId,
    // i18n-ignore
    { text: outcome.note, source: { kind: "outcome", id: `${workOrderId}:${run}` }, about: `完成「${taskTitleOf(workOrder)}」后写的完成情况` }, doneAt);
  // The follow-up question is written now, in the language of this moment.
  const rule = completionRule(workOrder, localeFor(ctx));
  const followUp = rule.mode === "needs_assessment" && (rule.reason === "result_pending" || !outcome);
  if (followUp) {
    const pending: PendingAssessment = { reason: rule.reason ?? "quality", question: rule.question ?? "", milestoneId: workOrder.milestoneId,
      askAfter: new Date(Date.parse(doneAt) + (rule.askAfterHours ?? 2) * 3_600_000).toISOString() };
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `assessment.pending:${workOrderId}:${run}`,
      type: "assessment.pending", entityId: workOrderId, payload: pending });
  }
  return { ok: true, completion: { mode: rule.mode, ...(followUp && rule.question ? { followUp: rule.question } : {}) } };
}

export function acceptWorkOrderEvidence(ctx: AccessContext, workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "accepted") return { ok: true };
  if (workOrder.state !== "evidence_review") return { ok: false, code: "EVIDENCE_REVIEW_NOT_READY" };
  if (workOrder.milestoneId) return { ok: false, code: "MILESTONE_GATE_REQUIRED" };
  const baseline = durationPriorFor(workOrder.identityId, workOrder.payload);
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "evidence.accepted", approvalId: ctx.principalId },
    `evidence-accepted:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`,
    { ...(baseline ? { durationCalibrationBaseline: baseline } : {}) });
  return { ok: true };
}

export function revokeAutoAcceptedWorkOrder(ctx: AccessContext, workOrderId: string, reason: string): ExecutionResult {
  const store = getStore();
  // Keyed on the attempt, not just the work order — the same reason a gate re-judgement is. A work
  // order can be auto-accepted, revoked, re-judged and auto-accepted again more than once, and a key
  // that only named the work order reused a spent one on the second revoke: `appendEvent` silently
  // no-ops on a repeated idempotency key, `transitionWorkOrder` returned `changed: false`, and this
  // function returned `{ ok: true }` anyway without checking. The person saw the page reload and
  // believed the revoke worked; the ledger never left `accepted`.
  const attempt = store.listEvents(ctx.workspaceId, { type: "milestone_gate.auto_acceptance_revoked", entityId: workOrderId }).length;
  try {
    store.revokeAutoAcceptance(ctx.workspaceId, workOrderId, reason, `auto-acceptance-revoked:${workOrderId}:${attempt}`);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "AUTO_ACCEPTANCE_REVOKE_FAILED";
    return { ok: false, code };
  }
}

export function blockWorkOrderEvidence(ctx: AccessContext, workOrderId: string, reason: string): ExecutionResult {
  if (!reason.trim()) return { ok: false, code: "BLOCK_REASON_REQUIRED" };
  const workOrder = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "evidence_review") return { ok: false, code: "EVIDENCE_REVIEW_NOT_READY" };
  getStore().transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "blocked", reason: reason.trim() },
    `evidence-blocked:${workOrderId}:${executionRun(ctx.workspaceId, workOrderId)}`);
  return { ok: true };
}

/**
 * The person saying a task waits for someone: 「师兄 10/8 左右给数据」. The same waiting item analysis would have
 * written, made by hand — for a task analysed before the analysis read such dates, or one it missed.
 */
export function addWaitingForOrder(ctx: AccessContext, workOrderId: string, input: { who: string; what: string; expectedAt: string; approximate: boolean }):
  { ok: true; id: string } | { ok: false; code: string } {
  const order = findWorkOrder(ctx.workspaceId, workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (["accepted", "archived"].includes(order.state)) return { ok: false, code: "WORK_ORDER_CLOSED" };
  const what = input.what.trim();
  if (!what || what.length > 200 || input.who.length > 60 || !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedAt)) return { ok: false, code: "INVALID_WAITING_INPUT" };
  const id = `wait-${workOrderId}-${getStore().listWaitingItems(ctx.workspaceId).filter((item) => item.blocks.includes(workOrderId)).length}`;
  getStore().saveWaitingItem({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, title: what, who: input.who.trim(),
    expectedAt: input.expectedAt, approximate: input.approximate, followUpAt: input.expectedAt, state: "open", blocks: [workOrderId], source: "manual" });
  return { ok: true, id };
}

/** The person's answer to a waiting item's 「到了吗？」. 「到了」 frees the work it held up for scheduling now. */
export function answerWaiting(ctx: AccessContext, id: string, answer: { kind: "arrived" } | { kind: "cancelled" } | { kind: "deferred"; followUpAt: string }):
  { ok: true } | { ok: false; code: string } {
  try {
    if (answer.kind === "deferred" && answer.followUpAt <= planToday(ctx)) return { ok: false, code: "WAITING_FOLLOW_UP_NOT_FUTURE" };
    return getStore().answerWaitingItem(ctx.workspaceId, id, answer, ctx.principalId).changed ? { ok: true } : { ok: false, code: "WAITING_ITEM_CLOSED" };
  } catch (error) {
    return { ok: false, code: error instanceof Error ? error.message : "WAITING_ANSWER_FAILED" };
  }
}
