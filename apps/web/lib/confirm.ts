import "server-only";
import { addDomainRecord, lineOfDomain } from "./records";
import type { AccessContext } from "@crossline/core";
import type { EvidenceClaimInput } from "@crossline/db";
import { activityMinutes, completeWorkOrderExecution, effectiveSchedulePreferences, getStore, startWorkOrderExecution, toZonedInstant } from "./crossline";
import { ANSWERED_SETTING, type NudgePayload } from "./nudges";
import { autoCloseFinished } from "./auto-close";
import type { Card } from "./conversation";

/**
 * The completion check (docs/loop-and-scout.md §3): a block ended, the person was asked once, and one tap says what happened —
 * 按预估完成, 超出 / 少于预估 by some minutes, or 未执行. The block's times are the ones it had when the question was asked: the
 * schedule is derived, and by now the unfinished step has already been moved elsewhere.
 */
export type ConfirmAnswer = { kind: "as_planned" | "over" | "under" | "partial" | "not_done"; minutes?: number; useActivity?: boolean; evidence?: EvidenceClaimInput[];
  /** Answered on the phone's notification (✓做了 / ✗没做) without opening the app: the event says so (`source: "push"`). */
  via?: "push";
  /** Answered by accepting what the passive signals inferred (the wrap-up's 「都对」): the event keeps that it was inferred. */
  inferred?: boolean };
export type ConfirmOutcome = { ok: true; done: "step" | "task" | "partial" | "not_done"; minutes?: number; needsEvidence?: true; already?: true } | { ok: false; code: string };
export type ConfirmView = {
  messageId: string; orderId: string; title: string; step: string; day: string; start: string; end: string; blockMinutes: number;
  lastStep: boolean; milestoneBound: boolean; activityMinutes?: number; answered?: { outcome: string; minutes?: number };
};

type Block = NonNullable<NudgePayload["block"]>;
const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

function blockOf(ctx: AccessContext, messageId: string): { block: Block; payload: Record<string, unknown> } | undefined {
  const message = getStore().getConversationMessage(ctx.workspaceId, messageId);
  const nudge = message?.payload.nudge as NudgePayload | undefined;
  return message && nudge?.kind === "block_confirm" && nudge.block ? { block: nudge.block, payload: message.payload } : undefined;
}

/** This step is the task's last one left (or the task has no step plan): confirming it finishes the task. */
function isLastStep(ctx: AccessContext, block: Block): boolean {
  const steps = getStore().getStepPlan(ctx.workspaceId, block.orderId)?.steps ?? [];
  return steps.every((step) => step.id === block.stepId || step.status === "done" || step.status === "skipped");
}

function instants(ctx: AccessContext, block: Block): { start: string; end: string } {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  return { start: toZonedInstant(block.day, block.start, zone), end: toZonedInstant(block.day, block.end, zone) };
}

const answeredOf = (ctx: AccessContext, messageId: string) => getStore().listEvents(ctx.workspaceId, { type: "block.confirmed" })
  .find((event) => event.entityId === messageId)?.payload as { outcome: string; minutes?: number } | undefined;

export function confirmView(ctx: AccessContext, messageId: string): ConfirmView | undefined {
  const found = blockOf(ctx, messageId);
  if (!found) return undefined;
  const { block } = found;
  const order = getStore().listWorkOrders(ctx.workspaceId).find((item) => item.id === block.orderId);
  if (!order) return undefined;
  const { start, end } = instants(ctx, block);
  const inferred = activityMinutes(ctx, start, end);
  const answered = answeredOf(ctx, messageId);
  return { messageId, orderId: block.orderId, title: block.title, step: block.step, day: block.day, start: block.start, end: block.end,
    blockMinutes: clockMinutes(block.end) - clockMinutes(block.start), lastStep: isLastStep(ctx, block), milestoneBound: Boolean(order.milestoneId),
    ...(inferred ? { activityMinutes: inferred } : {}), ...(answered ? { answered } : {}) };
}

export function confirmBlock(ctx: AccessContext, messageId: string, answer: ConfirmAnswer, now = new Date()): ConfirmOutcome {
  const found = blockOf(ctx, messageId);
  if (!found) return { ok: false, code: "CONFIRM_NOT_FOUND" };
  return confirmBlockAt(ctx, messageId, found.block, answer, now, found.payload);
}

/** Whether a block was already answered, under its question's id or the wrap-up's key (`lib/wrap.ts`). */
export const blockAnswer = (ctx: AccessContext, key: string) => answeredOf(ctx, key);

/**
 * One block's answer, written under `key`: the completion check's message id, or the evening wrap-up's `wrap:<day>:<block>`. Both write
 * the same `block.confirmed`, so the next day's 「昨天没开始」, the efficiency fit and the morning brief read them alike. `partial`
 * (the wrap-up's 「部分」) records the block's time as worked and half the step done; the step stays open and is placed again.
 */
export function confirmBlockAt(ctx: AccessContext, messageId: string, block: Block, answer: ConfirmAnswer, now = new Date(), payload?: Record<string, unknown>): ConfirmOutcome {
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === block.orderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  const previous = answeredOf(ctx, messageId);
  if (previous) return { ok: true, done: previous.outcome === "not_done" || previous.outcome === "partial" ? previous.outcome : isLastStep(ctx, block) ? "task" : "step", already: true,
    ...(previous.minutes ? { minutes: previous.minutes } : {}) };

  const { start, end } = instants(ctx, block);
  const blockMinutes = clockMinutes(block.end) - clockMinutes(block.start);
  const inferred = answer.useActivity ? activityMinutes(ctx, start, end) : undefined;
  if (answer.useActivity && !inferred) return { ok: false, code: "ACTIVITY_MINUTES_UNAVAILABLE" };
  const delta = Math.max(0, Math.round(answer.minutes ?? 0));
  if ((answer.kind === "over" || answer.kind === "under") && !delta && !inferred) return { ok: false, code: "CONFIRM_MINUTES_REQUIRED" };
  const minutes = inferred ?? (answer.kind === "over" ? blockMinutes + delta : answer.kind === "under" ? Math.max(1, blockMinutes - delta) : blockMinutes);
  const source = inferred ? "activity" as const : "one_tap" as const;
  const last = isLastStep(ctx, block);
  const record = (outcome: string, extra: Record<string, unknown> = {}) => {
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `block-confirmed:${messageId}`, type: "block.confirmed",
      entityId: messageId, payload: { blockId: block.id, workOrderId: block.orderId, stepId: block.stepId, day: block.day, outcome, blockMinutes,
        ...(block.energy ? { energy: block.energy } : {}), ...extra, ...(answer.via === "push" ? { source: "push" } : {}), ...(answer.inferred ? { inferred: true } : {}) } });
    // The card counts as answered, so the question is not taken as ignored (three ignored in a row would mute the kind).
    const card = payload?.card as Card | undefined;
    if (payload && card) store.updateConversationPayload(ctx.workspaceId, messageId, { ...payload, card: { ...card, clarify: { ...card.clarify, chosen: 0 } } });
    store.setSetting(ctx.workspaceId, ANSWERED_SETTING, now.toISOString());
    if (outcome !== "not_done") recordWorkout(ctx, order, block, typeof extra.minutes === "number" ? extra.minutes : blockMinutes);
  };

  if (answer.kind === "not_done") {
    record("not_done");
    return { ok: true, done: "not_done" };
  }

  if (answer.kind === "partial") {
    store.recordConfirmedSession(ctx.workspaceId, block.orderId, ctx.principalId, { startedAt: start, endedAt: end, minutes, source, key: `confirmed-session:${messageId}` });
    const step = block.stepId ? store.getStepPlan(ctx.workspaceId, block.orderId)?.steps.find((item) => item.id === block.stepId) : undefined;
    if (step && step.status !== "done") store.updateStepProgress(ctx.workspaceId, block.orderId, step.id, { progressQuarter: Math.max(step.progressQuarter, 2) }, ctx.principalId, "confirm");
    record("partial", { minutes, source });
    return { ok: true, done: "partial", minutes };
  }

  if (!last) {
    store.recordConfirmedSession(ctx.workspaceId, block.orderId, ctx.principalId, { startedAt: start, endedAt: end, minutes, source, key: `confirmed-session:${messageId}` });
    if (block.stepId && store.getStepPlan(ctx.workspaceId, block.orderId)?.steps.some((step) => step.id === block.stepId))
      store.updateStepProgress(ctx.workspaceId, block.orderId, block.stepId, { status: "done" }, ctx.principalId, "confirm");
    record(answer.kind, { minutes, source });
    // The person's last step done with only the assistant's or a wait left: the task hands itself in (docs/plans/closed-loop-1030.md §3).
    try { autoCloseFinished(ctx, now); } catch { /* the attention timer tries again */ }
    return { ok: true, done: "step", minutes };
  }

  // The last step finishes the task through the same path as 「完成并提交材料」. A task with no `family` would leave no duration
  // observation (the calibration has no baseline for it), so an older one is tagged here once.
  if (!(order.payload as { family?: string }).family)
    store.backfillWorkOrderFamily(ctx.workspaceId, ctx.principalId, order.id, "preparation", `confirm-family:${order.id}`);
  if (!["evidence_review", "accepted"].includes(order.state)) {
    if (order.state !== "active") {
      const started = startWorkOrderExecution(ctx, order.id, start);
      if (!started.ok) return started;
    }
    const completed = completeWorkOrderExecution(ctx, order.id, answer.evidence ?? [], [], end, { minutes, source });
    if (!completed.ok) return completed;
  }
  if (block.stepId && store.getStepPlan(ctx.workspaceId, block.orderId)?.steps.some((step) => step.id === block.stepId))
    store.updateStepProgress(ctx.workspaceId, block.orderId, block.stepId, { status: "done" }, ctx.principalId, "confirm");
  record(answer.kind, { minutes, source, finished: true });
  // Finishing is accepting (2026-10-15): a milestone-bound task no longer needs evidence, so `needsEvidence` is never set.
  return { ok: true, done: "task", minutes };
}

/** Exercise named in a task or step title: only such work on the health line is a workout record. */
const EXERCISE = /跑步|慢跑|夜跑|晨跑|快走|散步|骑行|单车|游泳|健身|力量|撸铁|瑜伽|拉伸|普拉提|跳绳|徒步|爬山|球|运动|训练|有氧|HIIT|run|jog|gym|workout|yoga|swim|cycl|hike|lift/i;

/**
 * A block confirmed done on the health line (docs/domain-lines.md) is a workout record when its task or step names an exercise: the
 * confirmation already says how long it took, so the person never logs it twice. Once per block (`confirm:<order>:<step>:<day>`).
 */
function recordWorkout(ctx: AccessContext, order: { id: string; identityId: string; intent: string; payload: unknown },
  block: { stepId?: string | undefined; day: string; step?: string | undefined; title?: string | undefined }, minutes: number): void {
  const line = lineOfDomain(ctx, "wellness");
  if (!line || order.identityId !== line.id) return;
  const name = [block.step, block.title, (order.payload as { title?: string }).title, order.intent].filter(Boolean).join(" ");
  if (!EXERCISE.test(name)) return;
  /* i18n-ignore-start: the record's stored unit and category, as every other source writes them */
  addDomainRecord(ctx, { domain: "wellness", kind: "workout", at: block.day, value: Math.max(1, Math.round(minutes)), unit: "分钟", currency: "",
    category: (block.step || block.title || "运动").slice(0, 40), note: "", source: "confirm", sourceRef: order.id,
    dedupeKey: `confirm:${order.id}:${block.stepId ?? ""}:${block.day}` });
  /* i18n-ignore-end */
}
