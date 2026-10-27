import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ASSISTANT_PREP_HOURS, prepWindow, servedPersonStep, startingWithin } from "./schedule-window";

const WEEK = 7 * 24;
const estimate = { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("work starting within three days by default (or begun in the last hour) is in the window; later work and an unreadable record are not", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  expect(startingWithin(store, "w", now)).toEqual(new Set());
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ soon: "2026-10-14T09:00:00.000Z", begun: "2026-10-13T11:30:00.000Z",
    week: "2026-10-19T09:00:00.000Z", later: "2026-10-21T09:00:00.000Z", past: "2026-10-12T09:00:00.000Z" }));
  expect([...startingWithin(store, "w", now)].sort()).toEqual(["begun", "soon"]);
  expect([...startingWithin(store, "w", now, 7 * 24)].sort()).toEqual(["begun", "soon", "week"]);
  // The assistant's window stays two days.
  expect([...startingWithin(store, "w", now, ASSISTANT_PREP_HOURS)].sort()).toEqual(["begun", "soon"]);
  store.setSetting("w", "schedule.orderStarts", "{ not json");
  expect(startingWithin(store, "w", now)).toEqual(new Set());
  store.close();
});

test("approved work with no block is judged by its due day less its open work; proposals and undated work are not", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  const order = (id: string, dueDate: string | undefined, state = "approved") => store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId: "research",
    projectId: "p", milestoneId: "", intent: id, state: state as "approved", riskTier: "routine", estimate, payload: dueDate ? { dueDate } : {} });
  order("near", "2026-10-21");
  order("far", "2026-11-30");
  order("undated", undefined);
  order("proposal", "2026-10-15", "awaiting_plan_approval");
  order("overdue", "2026-10-10");
  // A big task due in two weeks starts within the week once its open work is counted: 60 hours at the default daily hours (without its
  // steps, its four-hour estimate would start it the day before).
  order("big", "2026-10-28");
  store.saveStepPlan("w", "big", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "",
    steps: [{ id: "s", role: "solve", title: "做", deliverable: "产出", doneCriterion: "完成", share: 1, estimate: { p25Minutes: 1800, p50Minutes: 2400, p85Minutes: 3600 },
      dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "" }] }, "o", "planned");
  store.setSetting("w", "schedule.orderStarts", "{}");
  expect([...startingWithin(store, "w", now, WEEK)].sort()).toEqual(["big", "near"]);
  // The same estimate for the assistant's two days: only work that would have to start by then.
  order("tight", "2026-10-15");
  expect([...startingWithin(store, "w", now, ASSISTANT_PREP_HOURS)].sort()).toEqual(["tight"]);
  // A recorded block wins over the estimate.
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ near: "2026-10-25T09:00:00.000Z" }));
  expect([...startingWithin(store, "w", now, WEEK)].sort()).toEqual(["big", "tight"]);
  store.close();
});

type Step = { id: string; title: string; executor: "human" | "agent" | "mixed"; dependsOn?: string[]; minutes?: number };
const plan = (store: CrosslineStore, orderId: string, steps: Step[]) => store.saveStepPlan("w", orderId, { archetypeId: "problem_set", quantity: { basis: "题", amount: 1, unit: "题" },
  rationale: "", steps: steps.map((step) => ({ id: step.id, role: "do", title: step.title, deliverable: "产出", doneCriterion: "完成", share: 1 / steps.length,
    estimate: { p25Minutes: step.minutes ?? 60, p50Minutes: step.minutes ?? 60, p85Minutes: step.minutes ?? 60 }, dependsOn: step.dependsOn ?? [], notBefore: "", dueBy: "",
    schedulable: step.executor !== "agent", executor: step.executor, tickOutcome: "" })) }, "o", "planned");
const saveOrder = (store: CrosslineStore, id: string, payload: Record<string, unknown> = {}) => store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w",
  identityId: "research", projectId: "p", milestoneId: "", intent: id, state: "approved", riskTier: "routine", estimate, payload });

test("the step an assistant step serves: the soonest open person step waiting on it, else the next person step after it", () => {
  const store = new CrosslineStore(":memory:");
  saveOrder(store, "wo");
  // a (agent) → c (agent) → d (person); b is a person step that does not wait on a; nothing follows e.
  const stored = plan(store, "wo", [{ id: "a", title: "汇编规则", executor: "agent" }, { id: "b", title: "读讲义", executor: "human" },
    { id: "c", title: "整理样题", executor: "agent", dependsOn: ["a"] }, { id: "d", title: "限时做样题", executor: "human", dependsOn: ["c"] },
    { id: "e", title: "汇总错题来源", executor: "agent" }]);
  const [a, b, c, , e] = stored.steps;
  expect(servedPersonStep(stored, a!)?.title).toBe("限时做样题");
  expect(servedPersonStep(stored, c!)?.title).toBe("限时做样题");
  expect(b!.title).toBe("读讲义");
  expect(servedPersonStep(stored, e!)).toBeUndefined();
  // With no person step waiting on it, the next person step after it in the plan.
  const loose = plan(store, "wo", [{ id: "a", title: "汇编规则", executor: "agent" }, { id: "b", title: "读讲义", executor: "human" }]);
  expect(servedPersonStep(loose, loose.steps[0]!)?.title).toBe("读讲义");
  store.close();
});

test("a preparation step starts within two days of the person step it serves, not of the whole order's first block", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  saveOrder(store, "wo");
  // The order's first block is in an hour (reading); the practice the rules are for is four days out; the report is tomorrow evening.
  plan(store, "wo", [{ id: "a", title: "汇编规则", executor: "agent" }, { id: "b", title: "读讲义", executor: "human" },
    { id: "c", title: "按规则练习", executor: "human", dependsOn: ["a"] }, { id: "d", title: "整理参考资料", executor: "agent" }, { id: "e", title: "写报告", executor: "human", dependsOn: ["d"] }]);
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ wo: "2026-10-13T13:00:00.000Z" }));
  store.setSetting("w", "schedule.stepStarts", JSON.stringify({ "wo#v1s2": "2026-10-13T13:00:00.000Z", "wo#v1s3": "2026-10-17T09:00:00.000Z", "wo#v1s5": "2026-10-14T20:00:00.000Z" }));
  expect([...prepWindow(store, "w", now).steps]).toEqual(["wo#v1s4"]);
  // The practice moves to tomorrow: its rules are prepared now. The report has no block this week while the order has blocks: it is
  // later than the week the web records, so its material waits.
  store.setSetting("w", "schedule.stepStarts", JSON.stringify({ "wo#v1s2": "2026-10-13T13:00:00.000Z", "wo#v1s3": "2026-10-14T09:00:00.000Z" }));
  expect([...prepWindow(store, "w", now).steps]).toEqual(["wo#v1s1"]);
  store.close();
});

test("with no block for the step, it is worked back from the due day; with neither, the order's own start decides", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  // Due in three days with twelve hours of person work from the served step on: at the default daily hours it has to start by tomorrow.
  saveOrder(store, "dated", { dueDate: "2026-10-16" });
  plan(store, "dated", [{ id: "a", title: "汇编规则", executor: "agent" }, { id: "b", title: "按规则练习", executor: "human", dependsOn: ["a"], minutes: 720 }]);
  // Due in three weeks with an hour of work: not yet.
  saveOrder(store, "later", { dueDate: "2026-11-03" });
  plan(store, "later", [{ id: "a", title: "汇编规则", executor: "agent" }, { id: "b", title: "按规则练习", executor: "human", dependsOn: ["a"] }]);
  // Undated and unscheduled: by the order's own start (in an hour).
  saveOrder(store, "undated");
  plan(store, "undated", [{ id: "a", title: "整理笔记", executor: "agent" }, { id: "b", title: "复述要点", executor: "human", dependsOn: ["a"] }]);
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ undated: "2026-10-13T13:00:00.000Z" }));
  expect([...prepWindow(store, "w", now).steps].sort()).toEqual(["dated#v1s1", "undated#v1s1"]);
  store.close();
});

test("a whole errand that prepares another order goes by that order's first open person step", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  saveOrder(store, "core");
  plan(store, "core", [{ id: "a", title: "读材料", executor: "human" }, { id: "b", title: "设计实验", executor: "human" }]);
  saveOrder(store, "errand", { prepares: "core" });
  saveOrder(store, "plain");
  // The errand's own start is in an hour, and so is the plain order's; the core's first person step is five days away.
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ errand: "2026-10-13T13:00:00.000Z", plain: "2026-10-13T13:00:00.000Z" }));
  store.setSetting("w", "schedule.stepStarts", JSON.stringify({ "core#v1s1": "2026-10-18T09:00:00.000Z" }));
  expect([...prepWindow(store, "w", now).orders]).toEqual(["plain"]);
  store.setSetting("w", "schedule.stepStarts", JSON.stringify({ "core#v1s1": "2026-10-14T09:00:00.000Z" }));
  expect([...prepWindow(store, "w", now).orders].sort()).toEqual(["errand", "plain"]);
  // A core order with no plan goes by its own start, then by the errand's.
  saveOrder(store, "core2");
  saveOrder(store, "errand2", { prepares: "core2" });
  store.setSetting("w", "schedule.orderStarts", JSON.stringify({ core2: "2026-10-14T09:00:00.000Z" }));
  store.setSetting("w", "schedule.stepStarts", "{}");
  expect(prepWindow(store, "w", now).orders.has("errand2")).toBe(true);
  store.close();
});

test("the assistant's own item that nothing dates is done when the assistant is free; a dated one waits for its window", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  saveOrder(store, "loose", { owner: "assistant" });
  saveOrder(store, "core", { dueDate: "2026-11-30" });
  plan(store, "core", [{ id: "a", title: "设计实验", executor: "human" }]);
  saveOrder(store, "for-core", { owner: "assistant", prepares: "core" });
  // An owner-less order with neither date nor block is still not prepared for (nothing says it is wanted).
  saveOrder(store, "old");
  const window = prepWindow(store, "w", now).orders;
  expect(window.has("loose")).toBe(true);
  expect(window.has("for-core")).toBe(false);
  expect(window.has("old")).toBe(false);
  store.close();
});
