import { autoApprovalEligible, AUTO_APPROVER_ID, taskTitleOf, tFor } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";
import { localeOf } from "./locale";

/**
 * Lets the proposals that qualify take effect without a click (see `autoApprovalEligible`), right where
 * they are produced — after an analysis or a backplan — and on every tick for proposals written before the
 * rule covered them, so the person's week fills in instead of waiting behind a queue of cards. Each one is
 * recorded as `work_order.auto_approved` with the system as approver, and stays undoable for a day from the
 * approvals page. What took effect in one call is told to the person in one message (the person's decision,
 * 2026-10-15: approve directly and say so), sent to the desktop and phone when no page is open.
 */
export function autoApproveEligible(store: CrosslineStore, workspaceId: string, ids?: string[], now = new Date()): string[] {
  const wanted = ids ? new Set(ids) : undefined;
  // The reason recorded and the message said are in the workspace's language.
  const locale = localeOf(store, workspaceId);
  const approved: Array<{ id: string; title: string }> = [];
  // An automatic approval the person took back is never re-applied: their undo is a decision.
  const revoked = new Set(store.listEvents(workspaceId, { type: "work_order.auto_approval_revoked" }).map((event) => event.entityId));
  for (const order of store.listWorkOrders(workspaceId)) {
    if (wanted && !wanted.has(order.id)) continue;
    const verdict = autoApprovalEligible(order, { revoked: revoked.has(order.id), locale });
    if (!verdict.eligible) continue;
    try {
      const result = store.transitionWorkOrder(workspaceId, order.id, { type: "plan.approved", approvalId: AUTO_APPROVER_ID },
        `auto-approved:${order.id}`, { expectedWorkOrder: order });
      if (!result.changed) continue;
    } catch (error) {
      if (error instanceof Error && error.message === "PROPOSAL_VERSION_CHANGED") continue;
      throw error;
    }
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `work_order.auto_approved:${order.id}`,
      type: "work_order.auto_approved", entityId: order.id, payload: { reason: verdict.reason } });
    approved.push({ id: order.id, title: taskTitleOf(order) });
  }
  if (approved.length) {
    const t = tFor(locale);
    const shown = approved.slice(0, 5).map((item) => locale === "en" ? `"${item.title.slice(0, 30)}"` : `「${item.title.slice(0, 30)}」`);
    const names = locale === "en" ? shown.join(", ") : shown.join("、");
    const values = { count: approved.length, names };
    const said = approved.length > 5 ? t("{{count}} 项任务已自动生效并排进日程：{{names}} 等。", values) : t("{{count}} 项任务已自动生效并排进日程：{{names}}。", values);
    sayToPerson(store, workspaceId, said + t("它们无需本人选择、授权或对外动作；24 小时内可在待确认页「最近自动生效」撤销。"),
      "auto_approved", `auto-approved:${approved.map((item) => item.id).sort().join(",")}`, [{ label: t("去看看"), href: "/approvals" }], now);
  }
  return approved.map((item) => item.id);
}
