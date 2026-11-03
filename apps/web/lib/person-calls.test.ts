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

test("a registration the form service handed back is a call: a check urgent, a filled form waiting for the person's submission not", async () => {
  const { queueFormRun, saveFormRun } = await import("@crossline/db");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const opportunity = { id: "opp-1", key: "k", lineId: "startup", kind: "event", title: "AI Night", organizer: "", url: "https://lu.ma/ai", registrationHost: "lu.ma",
    deadlines: [], eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z" } as never;
  const run = queueFormRun(store, TEST_CTX.workspaceId, { opportunity, choice: "register" });
  saveFormRun(store, TEST_CTX.workspaceId, { ...run, state: "waiting_person", stoppedFor: "captcha", pageNo: 2 });
  let call = personCalls(TEST_CTX, new Date(), false).find((item) => item.id.startsWith("form:"));
  expect(call).toMatchObject({ urgent: true, action: { kind: "href", href: "/settings#apply" } });
  expect(call!.text).toContain("第 2 页");
  saveFormRun(store, TEST_CTX.workspaceId, { ...run, state: "ready_to_submit", stoppedFor: undefined });
  call = personCalls(TEST_CTX, new Date(), false).find((item) => item.id.startsWith("form:"));
  expect(call).toMatchObject({ urgent: false });
  expect(call!.text).toContain("等本人在窗口里核对后提交");
});
