import type { CrosslineStore } from "./index";
import { PUSH_SUBSCRIPTIONS } from "@crossline/core";

/** A device that receives push notifications (stored shape; the sender is `sendWebPush` in packages/connectors). */
export type StoredPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string }; origin: string; device: string; createdAt: string };
const KEY = PUSH_SUBSCRIPTIONS;

export function listPushSubscriptions(store: CrosslineStore, workspaceId: string): StoredPushSubscription[] {
  try { const value = JSON.parse(store.getSetting(workspaceId, KEY) ?? "[]") as unknown; return Array.isArray(value) ? value as StoredPushSubscription[] : []; }
  catch { return []; }
}

/** Adds or refreshes a device (one row per endpoint; a phone that subscribes again replaces its own row). At most ten devices. */
export function savePushSubscription(store: CrosslineStore, workspaceId: string, subscription: StoredPushSubscription): void {
  const rest = listPushSubscriptions(store, workspaceId).filter((item) => item.endpoint !== subscription.endpoint);
  store.setSetting(workspaceId, KEY, JSON.stringify([...rest, subscription].slice(-10)));
}

export function removePushSubscriptions(store: CrosslineStore, workspaceId: string, endpoints: string[]): number {
  const all = listPushSubscriptions(store, workspaceId);
  const kept = all.filter((item) => !endpoints.includes(item.endpoint));
  if (kept.length !== all.length) store.setSetting(workspaceId, KEY, JSON.stringify(kept));
  return all.length - kept.length;
}
