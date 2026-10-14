import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { saveSchedulePreferences } from "./crossline";
import { answerReturn, cleanStale, dismissReturn, returnDue, returnView } from "./return";
import { TEST_CTX } from "./test-support";

/** Coming back after days away, on a real store (docs/review-2026-10-13.md §6.3). */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const DAY = 86_400_000;
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const step = (id: string, title: string) => ({ id, role: "solve", title, deliverable: "解答", doneCriterion: "写完", share: 0.5,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 40 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "" });

function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }], importance: {} });
  const order = (id: string, intent: string, payload: Record<string, unknown> = {}, state = "approved") => store.saveWorkOrder({ id, ownerId: TEST_CTX.principalId, workspaceId: ws,
    identityId: "research", projectId: "ece555", milestoneId: "", intent, state, riskTier: "routine", estimate, payload: { family: "deep_work", materialContract: [], ...payload } });
  return { store, order };
}
// The person's last own action: something said in the input box.
const said = (store: CrosslineStore, at: Date) => store.appendConversationMessage({ id: `m-${at.getTime()}`, workspaceId: ws,
  conversationId: store.conversationFor(ws, at.toISOString().slice(0, 10)).id, role: "person", text: "作业 3 周二前交", payload: {}, createdAt: at.toISOString() });

test("the return page is due after two days away, once per absence; never for someone who has not done anything yet", () => {
  const { store } = setup();
  const now = new Date();
  expect(returnDue(TEST_CTX, now)).toBeUndefined();
  said(store, new Date(now.getTime() - 3 * DAY));
  const due = returnDue(TEST_CTX, now)!;
  expect(due.since).toBe(new Date(now.getTime() - 3 * DAY).toISOString());
  dismissReturn(TEST_CTX, due.since);
  expect(returnDue(TEST_CTX, now)).toBeUndefined();
  said(store, new Date(now.getTime() - 3_600_000));
  expect(returnDue(TEST_CTX, now)).toBeUndefined();
});

test("coming back by answering something elsewhere first keeps the absence's page until its work is settled or skipped", () => {
  const { store, order } = setup();
  const now = new Date();
  const left = new Date(now.getTime() - 4 * DAY);
  said(store, left);
  order("hw3", "完成 ECE 555 作业 3");
  const day = new Date(now.getTime() - 2 * DAY).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  store.setSetting(ws, `schedule.day:${day}`, JSON.stringify({ hw3: "09:00" }));
  // Back an hour ago, through the interview: still the page for the four days away, with the homework that had a time in them.
  store.appendOnboardingMessage({ sessionId: "s", workspaceId: ws, role: "user", content: { text: "没有截止" }, createdAt: new Date(now.getTime() - 3_600_000).toISOString() });
  const due = returnDue(TEST_CTX, now)!;
  expect(due.since).toBe(left.toISOString());
  const view = returnView(TEST_CTX, due.since, now, due.until);
  expect(view.daysAway).toBe(4);
  expect(view.items.map((item) => item.orderId)).toEqual(["hw3"]);
  // Settled — or skipped — it is gone.
  expect(answerReturn(TEST_CTX, "hw3", "rolled", {}, now)).toEqual({ ok: true });
  expect(returnDue(TEST_CTX, now)).toBeUndefined();
});

test("the work that had a time while away or whose due day passed is listed; what is done or untouched is not", () => {
  const { store, order } = setup();
  const now = new Date();
  const since = new Date(now.getTime() - 4 * DAY);
  said(store, since);
  order("hw3", "完成 ECE 555 作业 3");
  order("hw2", "完成 ECE 555 作业 2", { dueDate: new Date(now.getTime() - 2 * DAY).toISOString().slice(0, 10) });
  order("later", "期末复习");
  order("done", "已交的作业", {}, "accepted");
  store.saveStepPlan(ws, "hw3", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "按题拆分",
    steps: [step("s1", "推导第 1–2 题"), step("s2", "推导第 3–4 题")] }, TEST_CTX.principalId, "t");
  const day = new Date(now.getTime() - 2 * DAY).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  store.setSetting(ws, `schedule.day:${day}`, JSON.stringify({ hw3: "09:00", done: "14:00" }));
  const view = returnView(TEST_CTX, since.toISOString(), now);
  expect(view.daysAway).toBe(4);
  expect(view.items.map((item) => item.orderId)).toEqual(["hw2", "hw3"]);
  expect(view.items.find((item) => item.orderId === "hw3")).toMatchObject({ plannedDays: [day], lineLabel: expect.any(String),
    steps: [{ id: expect.any(String), title: "推导第 1–2 题", done: false }, { id: expect.any(String), title: "推导第 3–4 题", done: false }] });
});

test("one tap each: 完成 hands the task in with how long it took; 做了一部分 marks the ticked steps; 不做了 discards it; 没做顺延 only records", () => {
  const { store, order } = setup();
  const now = new Date();
  said(store, new Date(now.getTime() - 4 * DAY));
  order("hw3", "完成 ECE 555 作业 3");
  order("hw4", "完成 ECE 555 作业 4");
  order("club", "社团海报");
  order("read", "读第 5 讲");
  store.saveStepPlan(ws, "hw4", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "按题拆分",
    steps: [step("s1", "推导第 1–2 题"), step("s2", "推导第 3–4 题")] }, TEST_CTX.principalId, "t");
  expect(answerReturn(TEST_CTX, "hw3", "done", { minutes: 90 }, now)).toEqual({ ok: true });
  expect(store.getWorkOrder(ws, "hw3")!.state).toBe("evidence_review");
  expect(store.listDurationObservations(ws, "research", "deep_work")[0]).toMatchObject({ observedMinutes: 90, actualSource: "one_tap" });
  const first = store.getStepPlan(ws, "hw4")!.steps[0]!.id;
  expect(answerReturn(TEST_CTX, "hw4", "partial", { stepIds: [] }, now)).toEqual({ ok: false, code: "RETURN_STEPS_REQUIRED" });
  expect(answerReturn(TEST_CTX, "hw4", "partial", { stepIds: [first] }, now)).toEqual({ ok: true });
  expect(store.getStepPlan(ws, "hw4")!.steps.map((item) => item.status)).toEqual(["done", "planned"]);
  expect(answerReturn(TEST_CTX, "club", "dropped", {}, now)).toEqual({ ok: true });
  expect(store.getWorkOrder(ws, "club")!.state).toBe("archived");
  expect(answerReturn(TEST_CTX, "read", "rolled", {}, now)).toEqual({ ok: true });
  expect(store.getWorkOrder(ws, "read")!.state).toBe("approved");
  // Answering is the person acting: they are back.
  expect(returnDue(TEST_CTX, now)).toBeUndefined();
  expect(store.listEvents(ws, { type: "return.answered" }).map((event) => (event.payload as { verdict: string }).verdict)).toEqual(["done", "partial", "dropped", "rolled"]);
});

test("proposals and drafts nobody touched for fourteen days are archived, recoverable; newer and edited ones stay", () => {
  const { store, order } = setup();
  order("old", "旧提议", {}, "awaiting_plan_approval");
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "t-old", type: "work_order.transitioned", entityId: "old", payload: { to: "awaiting_plan_approval" } });
  store.saveMilestone({ id: "draft-old", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece555", title: "ECE 555 期中 85 分", status: "draft", version: 1 });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "p-old", type: "milestone.proposed", entityId: "draft-old", payload: {} });
  store.saveMilestone({ id: "draft-edited", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece555", title: "ECE 548 期中 90 分", status: "draft", version: 1 });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "p-ed", type: "milestone.proposed", entityId: "draft-edited", payload: {} });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "r-ed", type: "milestone.revised", entityId: "draft-edited", payload: {} });
  // Today nothing is fourteen days old.
  expect(cleanStale(TEST_CTX, new Date())).toEqual({ ok: true, orders: [], milestones: [] });
  const later = new Date(Date.now() + 15 * DAY);
  expect(returnView(TEST_CTX, new Date().toISOString(), later).stale).toEqual({ orders: [{ id: "old", title: "ECE 555 旧提议" }], milestones: [{ id: "draft-old", title: "ECE 555 期中 85 分" }] });
  expect(cleanStale(TEST_CTX, later)).toEqual({ ok: true, orders: ["old"], milestones: ["draft-old"] });
  expect(store.getWorkOrder(ws, "old")!.state).toBe("archived");
  expect(store.listMilestones(ws).find((item) => item.id === "draft-edited")!.status).toBe("draft");
});
