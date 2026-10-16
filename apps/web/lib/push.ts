import "server-only";
// Only the push module: the package index also carries the Microsoft sign-in code, whose native keychain binding cannot be bundled.
import { loadVapidKeys, sendWebPush, validPushSubscription } from "@crossline/connectors/web-push";
import type { AccessContext } from "@crossline/core";
import { listPushSubscriptions, removePushSubscriptions, savePushSubscription } from "@crossline/db";
import { dataDirectory, getStore } from "./crossline";
import { localeFor, tOf } from "./locale";

/** The public half of this install's push key, which the phone needs to subscribe. */
export function pushPublicKey(): string {
  return loadVapidKeys(dataDirectory()).publicKey;
}

export function pushDevices(ctx: AccessContext): Array<{ device: string; origin: string; createdAt: string; endpointHost: string }> {
  return listPushSubscriptions(getStore(), ctx.workspaceId).map((item) => ({ device: item.device, origin: item.origin, createdAt: item.createdAt,
    endpointHost: new URL(item.endpoint).hostname }));
}

/**
 * Stores the phone's subscription. The origin must be an https address (the tailnet one): a notification opens a page there, and a
 * phone cannot open this machine's loopback address.
 */
export function subscribePush(ctx: AccessContext, input: { subscription: unknown; origin: unknown; device: unknown }): { ok: true } | { ok: false; code: string } {
  if (!validPushSubscription(input.subscription)) return { ok: false, code: "PUSH_SUBSCRIPTION_INVALID" };
  const origin = typeof input.origin === "string" ? input.origin : "";
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) return { ok: false, code: "PUSH_ORIGIN_NOT_HTTPS" };
  const device = typeof input.device === "string" ? input.device.slice(0, 60) : tOf(ctx)("手机");
  savePushSubscription(getStore(), ctx.workspaceId, { endpoint: input.subscription.endpoint, keys: input.subscription.keys, origin, device,
    createdAt: new Date().toISOString() });
  return { ok: true };
}

export function unsubscribePush(ctx: AccessContext, endpoint: unknown): { ok: true } {
  if (typeof endpoint === "string") removePushSubscriptions(getStore(), ctx.workspaceId, [endpoint]);
  return { ok: true };
}

type PushPayload = { title: string; body: string; path: string; tag: string; start?: string };

/** One message to every subscribed device. Devices the push service has forgotten are dropped. */
export async function sendPush(ctx: AccessContext, payload: PushPayload): Promise<{ sent: number; gone: number; failed: number }> {
  const devices = listPushSubscriptions(getStore(), ctx.workspaceId);
  if (!devices.length) return { sent: 0, gone: 0, failed: 0 };
  const keys = loadVapidKeys(dataDirectory());
  // The text is written in the account's language; `lang` lets the service worker match its own button to it.
  const results = await Promise.all(devices.map((device) => sendWebPush(device, { ...payload, lang: localeFor(ctx) }, keys)));
  removePushSubscriptions(getStore(), ctx.workspaceId, devices.filter((_, index) => results[index] === "gone").map((device) => device.endpoint));
  return { sent: results.filter((r) => r === "sent").length, gone: results.filter((r) => r === "gone").length, failed: results.filter((r) => r === "failed").length };
}

/** One test message to every device, so the person sees it arrive before relying on it. */
export function sendTestPush(ctx: AccessContext): Promise<{ sent: number; gone: number; failed: number }> {
  const t = tOf(ctx);
  return sendPush(ctx, { title: t("Crossline 手机推送已接通"), body: t("早报和当天会误事的提醒会同时出现在这里和电脑上。"), path: "/", tag: "test" });
}
