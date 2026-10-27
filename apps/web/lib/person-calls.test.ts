import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { VERIFY_PENDING_SETTING } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { personCalls } from "./person-calls";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("a site waiting for the person's verification is an urgent call that opens the dialog; one past its time is not", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(TEST_CTX.workspaceId, VERIFY_PENDING_SETTING, JSON.stringify({ workflowId: "flow-x", service: "小红书", label: "小红书", where: "收藏列表第 123 屏", at: "2026-10-24T02:41:35Z" }));
  const calls = personCalls(TEST_CTX, new Date("2026-10-24T02:45:00Z"), true);
  expect(calls[0]).toMatchObject({ urgent: true, action: { kind: "remote", workflowId: "flow-x", purpose: "verify" } });
  expect(calls[0]!.text).toContain("第 123 屏");
  // No device takes notifications on the hosted site: asked in place.
  expect(calls.some((call) => call.action.kind === "push")).toBe(true);
  expect(personCalls(TEST_CTX, new Date("2026-10-24T03:30:00Z"), true).some((call) => call.urgent)).toBe(false);
});
