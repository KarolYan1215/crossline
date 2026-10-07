import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore, listPushSubscriptions } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { pushPublicKey, subscribePush, unsubscribePush } from "./push";
import { TEST_CTX } from "./test-support";

const dir = mkdtempSync(path.join(tmpdir(), "crossline-push-"));
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const subscription = { endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };

test("a phone subscribes from the https tailnet address; anything else is refused; it can be removed", () => {
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(pushPublicKey().length).toBeGreaterThan(40);
  expect(subscribePush(TEST_CTX, { subscription, origin: "http://127.0.0.1:3210", device: "iPhone" })).toEqual({ ok: false, code: "PUSH_ORIGIN_NOT_HTTPS" });
  expect(subscribePush(TEST_CTX, { subscription: { ...subscription, endpoint: "https://evil.example/x" }, origin: "https://a.ts.net", device: "iPhone" }))
    .toEqual({ ok: false, code: "PUSH_SUBSCRIPTION_INVALID" });
  expect(subscribePush(TEST_CTX, { subscription, origin: "https://karols-laptop.tailb8a366.ts.net", device: "iPhone" })).toEqual({ ok: true });
  expect(subscribePush(TEST_CTX, { subscription, origin: "https://karols-laptop.tailb8a366.ts.net", device: "iPhone" })).toEqual({ ok: true });
  expect(listPushSubscriptions(store, TEST_CTX.workspaceId)).toHaveLength(1);
  unsubscribePush(TEST_CTX, subscription.endpoint);
  expect(listPushSubscriptions(store, TEST_CTX.workspaceId)).toHaveLength(0);
  rmSync(dir, { recursive: true, force: true });
});
