import { randomUUID } from "node:crypto";
import { MAIL_LOG_SETTING, moneySubjectVetoed, readMailLog, REFUND_WORDS } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";
import { tOfWorkspace } from "./locale";

export const MAIL_RECORDS_REPAIR = "repair.mail-records.v1";

/**
 * Once per workspace (2026-10-28, docs/mail-bookkeeping.md §4.7): records booked from mail before the event rules existed are judged again.
 * One whose mail's subject is a request, a hold, a statement or a failure (the owner's 「Your $61.00 USD request expired」) is voided; a
 * refund booked as income becomes a refund; the same mail booked twice (two mailboxes) keeps one record. One undo puts everything back.
 */
export function mailRecordsRepair(store: CrosslineStore, workspaceId: string, now = new Date()): { voided: number; refunds: number; merged: number } {
  const done = { voided: 0, refunds: 0, merged: 0 };
  if (store.getSetting(workspaceId, MAIL_RECORDS_REPAIR)) return done;
  store.setSetting(workspaceId, MAIL_RECORDS_REPAIR, now.toISOString());
  const log = readMailLog(store.getSetting(workspaceId, MAIL_LOG_SETTING));
  const subjectOf = (record: { sourceRef: string; note: string }) => {
    const [accountId, , uid] = record.sourceRef.split(":");
    return log.find((entry) => entry.accountId === accountId && String(entry.uid) === uid)?.subject ?? record.note;
  };
  const t = tOfWorkspace(store, workspaceId);
  const removed: string[] = [];
  const kinds: Array<{ id: string; patch: { kind: "income" } }> = [];
  const seen = new Map<string, string>();
  for (const record of store.listRecords(workspaceId, { domain: "wealth" }).filter((item) => item.source === "mail")) {
    const subject = subjectOf(record);
    const refund = REFUND_WORDS.test(subject);
    if (moneySubjectVetoed(subject, refund)) {
      store.updateRecord(workspaceId, record.id, { voidReason: t("不是一笔交易：{{subject}}", { subject: subject.slice(0, 120) }) });
      store.setRecordDeleted(workspaceId, record.id, true, now.toISOString());
      removed.push(record.id); done.voided += 1; continue;
    }
    if (record.kind === "income" && refund) {
      store.updateRecord(workspaceId, record.id, { kind: "refund" });
      kinds.push({ id: record.id, patch: { kind: "income" } }); done.refunds += 1;
    }
    const twin = `${record.value}|${record.currency}|${record.at.slice(0, 10)}|${subject.trim()}`;
    if (seen.has(twin)) {
      store.updateRecord(workspaceId, record.id, { voidReason: `merged:${seen.get(twin)}` });
      store.setRecordDeleted(workspaceId, record.id, true, now.toISOString());
      removed.push(record.id); done.merged += 1;
    } else seen.set(twin, record.id);
  }
  if (!removed.length && !kinds.length) return done;
  const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
    payload: { bySystem: true, label: t("整理邮件记账"), inverse: { kind: "batch", items: [
      ...(removed.length ? [{ kind: "records.deleted", ids: removed, deleted: false }] : []),
      ...(kinds.length ? [{ kind: "records.fields", entries: kinds }] : [])] } } });
  const parts = [
    ...(done.voided ? [t("撤回 {{count}} 笔不是交易的（如收款请求过期、预授权、账单提醒）", { count: done.voided })] : []),
    ...(done.refunds ? [t("{{count}} 笔退款改为冲减支出", { count: done.refunds })] : []),
    ...(done.merged ? [t("合并 {{count}} 笔重复记账", { count: done.merged })] : [])];
  sayToPerson(store, workspaceId, t("整理了邮件记账：{{list}}。", { list: parts.join(t("；")) }), "money_repair", `mail-records-repair:${workspaceId}`,
    [{ label: t("撤销"), action: { action: "undo", summary: t("撤销：恢复这些记账"), args: { opId } } }, { label: t("看总账"), href: "/ledger" }], now);
  return done;
}
