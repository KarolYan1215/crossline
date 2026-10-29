import "server-only";
import { randomUUID } from "node:crypto";
import { onPersonsBoard, taskTitleOf, tidySentenceEnds, type AccessContext } from "@crossline/core";
import type { StoredTaskStep } from "@crossline/db";
import { appNow, completeWorkOrderExecution, getStore, inputsReady, planToday, startWorkOrderExecution } from "./crossline";
import { recordOp } from "./undo";
import { tOf } from "./locale";

/**
 * A task closes itself once the person's part is done (docs/plans/closed-loop-1030.md §3, the owner's decision of 2026-10-30): every step
 * of the person's is done and only the assistant's steps or waiting steps are left — or nothing is left at all and nobody pressed 完成.
 * It is handed in the way 「完成」 hands it in (finishing is accepting; work whose result comes later is still asked about afterwards),
 * said once in the day's conversation, and can be undone for 24 hours. The month simulation saw 149 confirmed blocks and 152 timed
 * sessions hand in no task at all, because the last step was someone else's reply.
 */
export const AUTO_CLOSED_EVENT = "work_order.auto_closed";
const OPEN = ["approved", "ready_for_human", "active"];

/** The person's own steps: not the assistant's and not a wait for someone else. */
export const isPersonStep = (step: Pick<StoredTaskStep, "executor" | "role">) => step.executor !== "agent" && step.role !== "wait";

/** Orders whose person's part is done and which are still open; each closes at most once (an undone close is left to the person). */
export function finishedByPerson(ctx: AccessContext): string[] {
  const store = getStore();
  const closedBefore = new Set(store.listEvents(ctx.workspaceId, { type: AUTO_CLOSED_EVENT }).map((event) => event.entityId));
  // Materials still to be prepared would be asked for by starting it; such work waits for them.
  return store.listWorkOrders(ctx.workspaceId).filter((order) => OPEN.includes(order.state) && !order.tombstone && onPersonsBoard(order) && !closedBefore.has(order.id)
    && inputsReady(order))
    .filter((order) => {
      const steps = store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? [];
      const person = steps.filter(isPersonStep);
      return person.length > 0 && person.every((step) => step.status !== "planned") && person.some((step) => step.status === "done");
    }).map((order) => order.id);
}

/** Closes every such order; returns the ids closed. Run by the attention timer and after a block is confirmed. */
export function autoCloseFinished(ctx: AccessContext, now = appNow()): string[] {
  const store = getStore();
  const t = tOf(ctx);
  const closed: Array<{ id: string; title: string; left: number }> = [];
  for (const id of finishedByPerson(ctx)) {
    const order = store.getWorkOrder(ctx.workspaceId, id);
    if (!order) continue;
    const at = now.toISOString();
    if (order.state !== "active") {
      const started = startWorkOrderExecution(ctx, id, at);
      if (!started.ok) continue;
    }
    if (!completeWorkOrderExecution(ctx, id, [], [], at).ok) continue;
    const left = (store.getStepPlan(ctx.workspaceId, id)?.steps ?? []).filter((step) => step.status === "planned").length;
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${AUTO_CLOSED_EVENT}:${id}`, type: AUTO_CLOSED_EVENT,
      entityId: id, payload: { at, left } });
    closed.push({ id, title: taskTitleOf(order), left });
  }
  if (!closed.length) return [];
  const label = closed.length === 1 ? t("自动交上「{{title}}」", { title: closed[0]!.title }) : t("自动交上 {{count}} 个任务", { count: closed.length });
  const op = recordOp(ctx, label, { kind: "work_order.reopen", ids: closed.map((item) => item.id) });
  const names = closed.slice(0, 3).map((item) => t("「{{title}}」", { title: item.title })).join(t("、"));
  const text = closed.length > 3
    ? t("{{names}}等 {{count}} 个任务本人的步骤都做完了，已按完成交上；剩下的助手或等待步骤不再占本人时间。24 小时内可撤销。", { names, count: closed.length })
    : t("{{names}}本人的步骤都做完了，已按完成交上；剩下的助手或等待步骤不再占本人时间。24 小时内可撤销。", { names });
  say(ctx, text, op.id, now);
  return closed.map((item) => item.id);
}

/** One message in the day's conversation with 撤销, left pending so the worker's notification pass sends it when no page is open. */
function say(ctx: AccessContext, text: string, opId: string, now: Date): void {
  const store = getStore();
  const t = tOf(ctx);
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  store.appendConversationMessage({ id: randomUUID(), workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "", createdAt: now.toISOString(),
    payload: { nudge: { kind: "auto_closed", fingerprint: `auto_closed:${opId}`, urgent: false, counted: false, delivery: "pending" },
      card: { actions: [{ action: "undo", summary: t("撤销自动交上"), args: { opId } }], items: [{ state: "pending" }], confidence: "high", nudgeKind: "auto_closed",
        clarify: { question: tidySentenceEnds(text), options: [{ label: t("撤销"), actions: [0], kind: "action" }, { label: t("知道了"), actions: [], kind: "ack" }] } } } });
}
