import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ASSISTANT_PREP_HOURS, startingWithin } from "./schedule-window";

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
