import "server-only";
import { PROGRESS_LEVELS, taskTitleOf, type AccessContext, type Ask, type NudgeInput } from "@crossline/core";
import { getStore } from "./crossline";
import { reportProgress } from "./steps";

/**
 * 「做到哪了」 (the owner's decision of 2026-10-15): on the return page 「做了一部分」 may be sent with nothing chosen and nothing said.
 * That answer is kept (`return.answered` with `unclear`), and the 小帮手 asks once at an idle moment how far the step got — the same
 * mechanism as `outcome_check`: never listed among the decisions, never urgent, answerable from the nudge's buttons or by typing.
 *
 * Ledger: `return.answered {verdict: "partial", unclear: true}` → `progress.answered {refEventId, level?, note?}`.
 */
const OPEN = ["approved", "preparing", "ready_for_human", "active"];
const DAY = 86_400_000;
/** Asked about only while it is recent: an answer two weeks later says nothing the step plan does not already know. */
const ASK_DAYS = 14;
const short = (text: string, length = 30) => text.length > length ? `${text.slice(0, length)}…` : text;

/** Records how far a step got as quarters done (never less than already recorded, never on a finished step). */
export function applyProgressLevel(ctx: AccessContext, orderId: string, stepId: string, levelId: string | undefined): boolean {
  const level = PROGRESS_LEVELS.find((item) => item.id === levelId);
  const store = getStore();
  const step = store.getStepPlan(ctx.workspaceId, orderId)?.steps.find((item) => item.id === stepId);
  if (!level || !step || step.status === "done") return false;
  store.updateStepProgress(ctx.workspaceId, orderId, stepId, { progressQuarter: Math.max(level.quarter, step.progressQuarter) }, ctx.principalId, "return");
  return true;
}

export function progressAsks(ctx: AccessContext, now: Date): Ask[] {
  const store = getStore();
  const answered = new Set(store.listEvents(ctx.workspaceId, { type: "progress.answered" })
    .map((event) => String((event.payload as { refEventId?: string }).refEventId ?? "")));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  return store.listEvents(ctx.workspaceId, { type: "return.answered" }).flatMap((event): Ask[] => {
    const payload = event.payload as { verdict?: string; unclear?: boolean; stepId?: string };
    const order = orders.get(event.entityId);
    if (payload.verdict !== "partial" || !payload.unclear || answered.has(event.eventId) || !order || !OPEN.includes(order.state)
      || now.getTime() - Date.parse(event.createdAt) > ASK_DAYS * DAY) return [];
    const step = payload.stepId ? store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.id === payload.stepId) : undefined;
    if (step?.status === "done") return [];
    return [{ id: `progress:${event.eventId}`, kind: "progress_check", entityId: order.id, line: order.identityId, urgency: "later",
      raisedAt: event.createdAt, fingerprint: event.eventId,
      title: `「${short(taskTitleOf(order))}${step ? ` · ${short(step.title, 20)}` : ""}」做到哪了？`,
      why: "回来时记为做了一部分，没有说做到哪。说一下，排程按剩下的部分安排；不答也不影响别的事。",
      freeText: { placeholder: "例如：推完了第 1 题，第 2 题写了一半" },
      preview: { kind: "task", href: `/workbench/${encodeURIComponent(order.id)}`, label: "看任务" },
      options: [...PROGRESS_LEVELS.map((level, index) => ({ id: level.id, label: level.label, ...(index === 0 ? { recommended: true } : {}),
        detail: `记为这一步完成 ${level.quarter}/4` })), { id: "stop", label: "不记得了", detail: "不再问，进度保持原样" }] }];
  });
}

/** What the nudge pass offers the 小帮手: the levels as one-tap buttons, and a cue to say it in words. */
export function progressNudgeInputs(ctx: AccessContext, now: Date): NonNullable<NudgeInput["progressChecks"]> {
  return progressAsks(ctx, now).map((ask) => ({ askId: ask.id, orderId: ask.entityId, question: ask.title, fingerprint: ask.fingerprint,
    options: PROGRESS_LEVELS.map((level) => ({ id: level.id, label: level.label })), laterLabel: "说说做到哪了" }));
}

/** Carries out the answer: a level on the step, words to the progress judge (the box's own `task.op progress`), or 「不记得了」. */
export function answerProgress(ctx: AccessContext, ask: Ask, optionId: string, note: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const refEventId = ask.id.slice("progress:".length);
  const event = store.listEvents(ctx.workspaceId, { type: "return.answered", entityId: ask.entityId }).find((item) => item.eventId === refEventId);
  if (!event) return { ok: false, code: "ASK_NOT_FOUND" };
  const stepId = (event.payload as { stepId?: string }).stepId ?? "";
  const level = optionId === "stop" ? "" : optionId;
  if (!level && !note.trim() && optionId !== "stop") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  if (note.trim()) { const reported = reportProgress(ctx, ask.entityId, note); if (!reported.ok) return reported; }
  if (level) applyProgressLevel(ctx, ask.entityId, stepId, level);
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `progress.answered:${refEventId}`, type: "progress.answered",
    entityId: ask.entityId, payload: { refEventId, ...(level ? { level } : {}), ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}), ...(optionId === "stop" ? { stopped: true } : {}) } });
  return { ok: true };
}
