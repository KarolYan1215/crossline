import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { lastNight } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("a night skipped for an unreadable quota is said in words, not as the runtime's error body", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.appendEvent({ ownerId: "o", workspaceId: TEST_CTX.workspaceId, idempotencyKey: "night", type: "flywheel.nightly.skipped", entityId: "flywheel",
    payload: { code: "COST_SIGNAL_UNAVAILABLE", message: "读不到成本信号，今晚不运行：{\"code\":-32603,\"message\":\"failed to fetch codex rate limits\"}" } });
  expect(lastNight(TEST_CTX.workspaceId, new Date())).toEqual({ state: "skipped", reason: "读不到模型额度，今晚不运行。" });
});
