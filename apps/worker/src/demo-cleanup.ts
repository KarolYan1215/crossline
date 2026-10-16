import type { CrosslineStore } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { ownerOf } from "./owner";

/** The archive reason the web recognizes as the system's own (apps/web/lib/crossline.ts `SYSTEM_ARCHIVE_REASONS`): kept as written, shown through `t()`. */
export const DEMO_RETIRED_REASON = "示例作业自动清理：你已经有自己的任务了";

/**
 * The seeded demo orders exist to show the flow on an empty board. Once the person has work of their own,
 * `withoutShadowingDemos` already keeps them off Today and the plan — but they stayed on the Workbench, one
 * of them showing 「执行中 · 已暂停」 on the real account, looking like real work left half done. Archived
 * here instead, through the same `archived` transition and reason event the 丢弃 button writes, so they
 * land in the 已丢弃 drawer and can still be read. An accepted demo is history and is left alone.
 */
export function retireShadowedDemos(store: CrosslineStore, workspaceId: string): string[] {
  const capacityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const orders = store.listWorkOrders(workspaceId);
  const demo = (payload: unknown) => Boolean((payload as { seeded?: boolean } | undefined)?.seeded);
  const hasOwnWork = orders.some((order) => !demo(order.payload) && order.state !== "archived" && !capacityIds.has(order.identityId));
  if (!hasOwnWork) return [];
  const retired: string[] = [];
  for (const order of orders.filter((item) => demo(item.payload) && item.state !== "archived" && item.state !== "accepted")) {
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `archive-reason:${order.id}`,
      type: "work_order.archived", entityId: order.id, payload: { reason: DEMO_RETIRED_REASON, bySystem: true } });
    if (store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}`).changed) retired.push(order.id);
  }
  return retired;
}
