import type { CrosslineStore } from "./index";

/**
 * Pressing 完成 is the acceptance (the owner's decision of 2026-10-15, `completeWorkOrderExecution`). Work the person completed before
 * that rule went to `evidence_review` instead, and the milestone gate then refused some of it: on the real account 「完成 ECE 555 作业 2」,
 * marked done on the return page at 07:05 UTC that morning, judged `insufficient` four minutes later and asked about ever since
 * (「未通过验收」). `ownCompletion` says whether the person themselves completed an order the gate later blocked; `acceptOwnCompletion`
 * closes it the way 完成 does now (`evidence.accepted` with `onCompletion`, the one acceptance a blocked order takes).
 */
export const OWN_COMPLETION_REPAIR = "repair.own-completion.v1";

type Transition = { event?: { type?: string; reason?: string } };

/** Blocked by the gate after the person's own 完成, with nothing since that put the work back in their hands. */
export function ownCompletion(store: CrosslineStore, workspaceId: string, orderId: string): boolean {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
  if (order?.state !== "blocked") return false;
  const steps = store.listEvents(workspaceId, { type: "work_order.transitioned", entityId: orderId })
    .map((event) => (event.payload as Transition).event ?? {});
  const last = steps.at(-1);
  if (last?.type !== "blocked" || !String(last.reason ?? "").startsWith("MILESTONE_GATE")) return false;
  const lastIndex = (test: (step: { type?: string }) => boolean) => steps.reduce((found, step, index) => test(step) ? index : found, -1);
  const completed = lastIndex((step) => step.type === "human.completed");
  const reopened = lastIndex((step) => step.type === "plan.approved" || step.type === "acceptance.revoked");
  return completed >= 0 && completed > reopened;
}

export function acceptOwnCompletion(store: CrosslineStore, workspaceId: string, orderId: string, key: string): boolean {
  if (!ownCompletion(store, workspaceId, orderId)) return false;
  return store.transitionWorkOrder(workspaceId, orderId, { type: "evidence.accepted", onCompletion: true }, key, {}).changed;
}

/** Once per workspace: every order the person completed and the gate then blocked is accepted, and a `repair.own_completion` event names them. */
export function repairOwnCompletions(store: CrosslineStore, workspaceId: string, ownerId: string, now = new Date()): string[] | undefined {
  if (store.getSetting(workspaceId, OWN_COMPLETION_REPAIR)) return undefined;
  const accepted = store.listWorkOrders(workspaceId).filter((order) => order.state === "blocked")
    .filter((order) => acceptOwnCompletion(store, workspaceId, order.id, `own-completion:${order.id}`)).map((order) => order.id);
  store.setSetting(workspaceId, OWN_COMPLETION_REPAIR, now.toISOString());
  if (accepted.length) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `${OWN_COMPLETION_REPAIR}:${workspaceId}`, type: "repair.own_completion",
    entityId: workspaceId, payload: { accepted } });
  return accepted;
}
