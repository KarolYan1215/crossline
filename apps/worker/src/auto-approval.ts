import { autoApprovalEligible, AUTO_APPROVER_ID } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";

/**
 * Lets the proposals that qualify take effect without a click (see `autoApprovalEligible`), right where
 * they are produced — after an analysis or a backplan — so the person's week fills in instead of waiting
 * behind a queue of cards. Each one is recorded as `work_order.auto_approved` with the system as approver,
 * and stays undoable for a day from the approvals page.
 */
export function autoApproveEligible(store: CrosslineStore, workspaceId: string, ids?: string[]): string[] {
  const wanted = ids ? new Set(ids) : undefined;
  const approved: string[] = [];
  // An automatic approval the person took back is never re-applied: their undo is a decision.
  const revoked = new Set(store.listEvents(workspaceId, { type: "work_order.auto_approval_revoked" }).map((event) => event.entityId));
  for (const order of store.listWorkOrders(workspaceId)) {
    if (wanted && !wanted.has(order.id)) continue;
    if (revoked.has(order.id)) continue;
    const verdict = autoApprovalEligible(order);
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
    approved.push(order.id);
  }
  return approved;
}
