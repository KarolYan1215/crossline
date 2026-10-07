import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { answerWaiting, releaseDayOf } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

function setup(expectedAt: string) {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-06T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWaitingItem({ id: "wait-wo", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, title: "真实测量数据", who: "师兄",
    expectedAt, approximate: true, followUpAt: expectedAt, state: "open", blocks: ["wo"], source: "analysis" });
  return store;
}

test("work waiting for data is not released before the day the data is expected", () => {
  setup("2026-10-08");
  expect(releaseDayOf(TEST_CTX, { id: "wo", payload: {} })).toBe("2026-10-08");
  expect(releaseDayOf(TEST_CTX, { id: "other", payload: { notBefore: "2026-10-09" } })).toBe("2026-10-09");
});

test("past the expected day with no answer, it stays off today; 「到了」 frees it at once", () => {
  setup("2026-10-05");
  expect(releaseDayOf(TEST_CTX, { id: "wo", payload: {} })).toBe("2026-10-07");
  expect(answerWaiting(TEST_CTX, "wait-wo", { kind: "deferred", followUpAt: "2026-10-04" })).toEqual({ ok: false, code: "WAITING_FOLLOW_UP_NOT_FUTURE" });
  expect(answerWaiting(TEST_CTX, "wait-wo", { kind: "arrived" })).toEqual({ ok: true });
  expect(releaseDayOf(TEST_CTX, { id: "wo", payload: { notBefore: "2026-10-05" } })).toBeUndefined();
  expect(answerWaiting(TEST_CTX, "wait-wo", { kind: "arrived" })).toEqual({ ok: false, code: "WAITING_ITEM_CLOSED" });
});
