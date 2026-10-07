import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { isAllowedPushEndpoint, loadVapidKeys, sendWebPush, validPushSubscription, type PushSubscriptionRecord } from "./web-push";

const device: PushSubscriptionRecord = { endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
  origin: "https://karols-laptop.tailb8a366.ts.net", device: "iPhone", createdAt: "2026-10-07T00:00:00Z" };

test("only a known push service is ever posted to", () => {
  expect(isAllowedPushEndpoint("https://web.push.apple.com/QAbc")).toBe(true);
  expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
  expect(isAllowedPushEndpoint("http://web.push.apple.com/x")).toBe(false);
  expect(isAllowedPushEndpoint("https://web.push.apple.com:8443/x")).toBe(false);
  expect(isAllowedPushEndpoint("https://127.0.0.1/x")).toBe(false);
  expect(isAllowedPushEndpoint("https://evil.example/web.push.apple.com")).toBe(false);
  expect(validPushSubscription({ endpoint: device.endpoint, keys: device.keys })).toBe(true);
  expect(validPushSubscription({ endpoint: "https://evil.example/x", keys: device.keys })).toBe(false);
  expect(validPushSubscription({ endpoint: device.endpoint, keys: { p256dh: "short", auth: device.keys.auth } })).toBe(false);
});

test("a message opens the page on the address the phone subscribed from; a forgotten subscription reports gone", async () => {
  const keys = { publicKey: "pub", privateKey: "priv" };
  const sent: Array<{ endpoint: string; payload: string; subject: string }> = [];
  const ok = await sendWebPush(device, { title: "今天到期：报告", body: "截止 10-09。", path: "/milestones" }, keys,
    (async (sub: { endpoint: string }, payload: string, options: { vapidDetails: { subject: string } }) => {
      sent.push({ endpoint: sub.endpoint, payload, subject: options.vapidDetails.subject }); return {} as never; }) as never);
  expect(ok).toBe("sent");
  expect(JSON.parse(sent[0]!.payload)).toMatchObject({ title: "今天到期：报告", url: "https://karols-laptop.tailb8a366.ts.net/milestones" });
  expect(sent[0]!.subject).toBe("https://karols-laptop.tailb8a366.ts.net");
  const gone = await sendWebPush(device, { title: "t", body: "b", path: "/" }, keys, (async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); }) as never);
  expect(gone).toBe("gone");
  const failed = await sendWebPush(device, { title: "t", body: "b", path: "/" }, keys, (async () => { throw Object.assign(new Error("x"), { statusCode: 500 }); }) as never);
  expect(failed).toBe("failed");
});

test("the VAPID key pair is made once and reused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-vapid-"));
  try {
    const first = loadVapidKeys(dir);
    expect(first.publicKey.length).toBeGreaterThan(40);
    expect(loadVapidKeys(dir)).toEqual(first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
