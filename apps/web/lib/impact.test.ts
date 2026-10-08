import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { effectiveParams, effectiveWeight, loadCurrentPlan, readAvailability, readSchedulePreferences, saveSchedulePreferences } from "./crossline";
import { applyChange, previewChange } from "./impact";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const step = (id: string, minutes: number, dependsOn: string[] = []) => ({ id, role: "solve", title: `步骤${id}`, deliverable: "d", doneCriterion: "c",
  share: 0.5, estimate: { p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes }, dependsOn, notBefore: "", dueBy: "",
  schedulable: true, executor: "human" as const, tickOutcome: "" });

test("a previewed change writes nothing; applying it changes the step and records a preference sample", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T13:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered",
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }], importance: {} });
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human" });
  const plan = store.saveStepPlan(TEST_CTX.workspaceId, order.id, { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 2, unit: "题" },
    rationale: "", steps: [step("a", 60), step("b", 60, ["a"])] }, "o", "t");
  const second = plan.steps[1]!;

  const before = store.listEvents(TEST_CTX.workspaceId).length;
  const impact = await previewChange(TEST_CTX, { kind: "estimate_delta", workOrderId: order.id, stepId: second.id, deltaMinutes: 120 });
  expect(impact.task?.title).toBe(order.intent);
  expect(store.listEvents(TEST_CTX.workspaceId).length).toBe(before);
  expect(store.getStepPlan(TEST_CTX.workspaceId, order.id)!.steps[1]!.estimate.p50Minutes).toBe(60);

  expect(applyChange(TEST_CTX, { kind: "estimate_delta", workOrderId: order.id, stepId: second.id, deltaMinutes: 120 })).toEqual({ ok: true });
  expect(store.getStepPlan(TEST_CTX.workspaceId, order.id)!.steps[1]!.estimate.p50Minutes).toBe(180);
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "estimate.adjusted", entityId: order.id })).toHaveLength(1);

  expect(applyChange(TEST_CTX, { kind: "due", workOrderId: order.id, date: "2026-09-25" })).toEqual({ ok: true });
  expect((store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === order.id)!.payload as { dueDate?: string }).dueDate).toBe("2026-09-25");
  expect(applyChange(TEST_CTX, { kind: "due", workOrderId: order.id, date: "next week" })).toEqual({ ok: false, code: "DUE_DATE_INVALID" });
});

test("the plan page's controls preview without writing, then apply: a repainted week, packing numbers, an importance slider", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T13:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered",
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }], importance: {} });
  await loadCurrentPlan(TEST_CTX);
  const before = store.listEvents(TEST_CTX.workspaceId).length;

  const narrower = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "11:00", energy: "medium" as const }];
  const week = await previewChange(TEST_CTX, { kind: "availability", windows: narrower });
  expect(week.task).toBeUndefined();
  expect(week.week.availableAfter).toBeLessThan(week.week.availableBefore);
  expect(store.listEvents(TEST_CTX.workspaceId).length).toBe(before);
  expect(applyChange(TEST_CTX, { kind: "availability", windows: narrower })).toEqual({ ok: true });
  expect(readAvailability(TEST_CTX)).toEqual(narrower);

  const params = { gapMinutes: 20, maxDailyShare: 0.6, focusCapMinutes: 45, deadlineBufferDays: 2 };
  await previewChange(TEST_CTX, { kind: "params", params });
  expect(effectiveParams(TEST_CTX)).not.toEqual(params);
  expect(applyChange(TEST_CTX, { kind: "params", params })).toEqual({ ok: true });
  expect(effectiveParams(TEST_CTX)).toEqual(params);
  expect(readSchedulePreferences(TEST_CTX)?.mode).toBe("buffered");

  const milestone = store.listMilestones(TEST_CTX.workspaceId).find((item) => item.status === "approved")!;
  expect(applyChange(TEST_CTX, { kind: "weight", milestoneId: milestone.id, weight: 90 })).toEqual({ ok: true });
  expect(effectiveWeight(TEST_CTX, milestone.id)).toBe(90);
  const saved = store.listEvents(TEST_CTX.workspaceId, { type: "goal.settings_confirmed", entityId: milestone.id }).at(-1)!;
  expect(saved.payload).toMatchObject({ next: { weight: 90, importance: "important" } });
  expect(typeof (saved.payload as { presetWeight?: unknown }).presetWeight).toBe("number");
});
