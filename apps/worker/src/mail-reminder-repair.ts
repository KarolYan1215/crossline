import { randomUUID } from "node:crypto";
import { isMailReminderTitle, isMoneyRecordWork, taskTitleOf } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { archiveBySystem } from "./return-tidy";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";
import { tOfWorkspace } from "./locale";

export const MAIL_REMINDER_REPAIR = "repair.mail-reminders.v1";
const OPEN = new Set(["captured", "analyzing", "awaiting_plan_approval", "approved", "preparing", "ready_for_human", "blocked"]);

/**
 * Once per workspace (2026-10-27, the owner: 「检查所有任务，区分提醒和任务」): to-dos sorted out of mail before reminders existed — check an
 * unusual charge, a payment received, a provider's bulletin, a failed CI run — became tasks with analysis, steps and assistant preparation.
 * Each one nobody has started (no timer, no step done) is archived by the system and said once in the bell instead; one undo brings them
 * all back. Mail capture ids are the work orders' ids (`cap-mail-…`), so only what came from mail is touched.
 */
export function mailReminderRepair(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  if (store.getSetting(workspaceId, MAIL_REMINDER_REPAIR)) return [];
  store.setSetting(workspaceId, MAIL_REMINDER_REPAIR, now.toISOString());
  const started = new Set(store.listEvents(workspaceId, { type: "work_order.transitioned" })
    .filter((event) => (event.payload as { event?: { type?: string } }).event?.type === "human.started").map((event) => event.entityId));
  // Started by the person: a timer, or one of their own steps done or under way. The assistant's preparation counts for nothing here —
  // it ran by itself on every one of these (2026-10-27).
  const touched = (id: string) => started.has(id) || (store.getStepPlan(workspaceId, id)?.steps ?? [])
    .some((step) => step.executor !== "agent" && (step.status === "done" || (step.progressQuarter ?? 0) > 0));
  const reminders = store.listWorkOrders(workspaceId).filter((order) => order.id.startsWith("cap-mail-") && OPEN.has(order.state) && !order.tombstone
    && !touched(order.id) && isMailReminderTitle(taskTitleOf(order)));
  if (!reminders.length) return [];
  const t = tOfWorkspace(store, workspaceId);
  const archived = archiveBySystem(store, workspaceId, reminders.map((order) => ({ order, why: t("邮件里的核对事项") })), "mail");
  if (!archived.length) return [];
  const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
    payload: { bySystem: true, label: t("邮件核对事项转为提醒 {{count}} 个", { count: archived.length }), inverse: { kind: "work_order.restore", ids: archived.map((item) => item.id) } } });
  const titles = archived.map((item) => t("「{{title}}」", { title: item.title }));
  sayToPerson(store, workspaceId, (titles.length > 4
      ? t("{{count}} 个从邮件来的核对事项不再作为任务排程，改成提醒：{{titles}} 等。", { count: archived.length, titles: titles.slice(0, 4).join(t("、")) })
      : t("{{count}} 个从邮件来的核对事项不再作为任务排程，改成提醒：{{titles}}。", { count: archived.length, titles: titles.join(t("、")) }))
    + t("需要时在对应 App 或官网里看一眼即可；以后这类邮件直接出现在右上角的提醒里。"), "mail_check", `mail-reminder-repair:${workspaceId}`,
  [{ label: t("撤销"), action: { action: "undo", summary: t("撤销：恢复这些任务"), args: { opId } } }], now);
  return archived.map((item) => item.id);
}

export const MONEY_ASK_REPAIR = "repair.money-asks.v1";
const ASKING = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human"]);

/**
 * Once per workspace (2026-10-27, the owner: 「助手还要你上传交易记录太麻烦了，删掉，自动记录」): preparation that waited for the person to
 * upload account records, statements or holdings becomes the assistant's, to be done from what is recorded automatically (bookkeeping from
 * mail, connected mailboxes, earlier records) with the gaps marked. New work is judged the same way by `workOwner`.
 */
export function moneyAskRepair(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  if (store.getSetting(workspaceId, MONEY_ASK_REPAIR)) return [];
  store.setSetting(workspaceId, MONEY_ASK_REPAIR, now.toISOString());
  const t = tOfWorkspace(store, workspaceId);
  const answer = t("不问本人：用自动记下的账、已连邮箱里的账单和已有资料做，缺的写明缺失");
  const moved: string[] = [];
  for (const order of store.listWorkOrders(workspaceId)) {
    if ((order.payload as { owner?: unknown } | undefined)?.owner !== "ask" || order.tombstone || !ASKING.has(order.state)) continue;
    if (!isMoneyRecordWork(taskTitleOf(order)) && !isMoneyRecordWork(order.intent)) continue;
    store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), owner: "assistant", answer, answeredAt: now.toISOString() } });
    if (order.state === "awaiting_plan_approval")
      store.transitionWorkOrder(workspaceId, order.id, { type: "plan.approved", approvalId: "system:money-ask-repair" }, `money-ask-repair:${order.id}`);
    moved.push(order.id);
  }
  return moved;
}
