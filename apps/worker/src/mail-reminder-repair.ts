import { randomUUID } from "node:crypto";
import { isMailReminderTitle, taskTitleOf } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { archiveBySystem } from "./return-tidy";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";

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
  const touched = (id: string) => started.has(id) || (store.getStepPlan(workspaceId, id)?.steps ?? []).some((step) => step.status === "done" || (step.progressQuarter ?? 0) > 0);
  const reminders = store.listWorkOrders(workspaceId).filter((order) => order.id.startsWith("cap-mail-") && OPEN.has(order.state) && !order.tombstone
    && !touched(order.id) && isMailReminderTitle(taskTitleOf(order)));
  if (!reminders.length) return [];
  const archived = archiveBySystem(store, workspaceId, reminders.map((order) => ({ order, why: "邮件里的核对事项，转为提醒" })), "转为提醒：");
  if (!archived.length) return [];
  const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
    payload: { bySystem: true, label: `邮件核对事项转为提醒 ${archived.length} 个`, inverse: { kind: "work_order.restore", ids: archived.map((item) => item.id) } } });
  const titles = archived.map((item) => `「${item.title}」`);
  sayToPerson(store, workspaceId, `${archived.length} 个从邮件来的核对事项不再作为任务排程，改成提醒：${titles.slice(0, 4).join("、")}${titles.length > 4 ? " 等" : ""}。`
    + "需要时在对应 App 或官网里看一眼即可；以后这类邮件直接出现在右上角的提醒里。", "mail_check", `mail-reminder-repair:${workspaceId}`,
  [{ label: "撤销", action: { action: "undo", summary: "撤销：恢复这些任务", args: { opId } } }], now);
  return archived.map((item) => item.id);
}
