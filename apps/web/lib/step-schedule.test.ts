import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, plannerIdOfBlock, saveAvailability, saveSchedulePreferences, scheduledBlockId } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];
const step = (id: string, role: string, minutes: number, dependsOn: string[] = [], schedulable = true) => ({ id, role, title: `步骤${id}`,
  deliverable: "d", doneCriterion: "c", share: 0.25, estimate: { p25Minutes: minutes, p50Minutes: minutes, p85Minutes: minutes },
  dependsOn, notBefore: "", dueBy: "", schedulable, executor: "human" as const, tickOutcome: "" });

test("block ids carry the step and still name the task in segment 1", () => {
  expect(scheduledBlockId("wo-1", 1)).toBe("scheduled:wo-1");
  expect(scheduledBlockId("wo-1", 2)).toBe("scheduled:wo-1:2");
  expect(scheduledBlockId("wo-1#v1s2", 1)).toBe("scheduled:wo-1:v1s2");
  expect(scheduledBlockId("wo-1#v1s2", 3)).toBe("scheduled:wo-1:v1s2:3");
  for (const id of ["wo-1", "wo-1#v1s2"]) expect(plannerIdOfBlock(scheduledBlockId(id, 2))).toBe(id);
});

test("a task with a step plan is placed step by step, in dependency order, skipping done and waiting steps", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T13:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human" });
  const saved = store.saveStepPlan(TEST_CTX.workspaceId, order.id, { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 3, unit: "题" },
    rationale: "", steps: [step("a", "read", 30), step("w", "wait", 0, ["a"], false), step("b", "solve", 60, ["a"]), step("c", "check", 30, ["b"])] }, "o", "t");
  store.updateStepProgress(TEST_CTX.workspaceId, order.id, saved.steps[0]!.id, { status: "done" }, "o", "test");
  const blocks = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith(`scheduled:${order.id}`));
  const stepOf = (id: string) => plannerIdOfBlock(id).split("#")[1];
  expect(new Set(blocks.map((block) => stepOf(block.id)))).toEqual(new Set(["v1s3", "v1s4"]));
  const first = (stepId: string) => blocks.filter((block) => stepOf(block.id) === stepId).map((block) => `${block.day} ${block.start}`).sort()[0]!;
  expect(first("v1s3") < first("v1s4")).toBe(true);
  expect(blocks.every((block) => block.title.includes(" · 步骤"))).toBe(true);
});

test("a step whose own day has come is still placed before the task's deadline", async () => {
  // Thursday 9/17, 21:00 in Chicago: today's hours are over.
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T02:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human", payload: { ...(order.payload as object), dueDate: "2026-09-18" } });
  // Planned days earlier: the first step was paced for 9/15 (gone), the second for tonight (no hours left); the homework is due tomorrow.
  store.saveStepPlan(TEST_CTX.workspaceId, order.id, { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 2, unit: "题" },
    rationale: "", steps: [{ ...step("a", "read", 30), dueBy: "2026-09-15" }, { ...step("b", "solve", 60, ["a"]), dueBy: "2026-09-17" }] }, "o", "t");
  const blocks = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith(`scheduled:${order.id}`));
  expect(new Set(blocks.map((block) => plannerIdOfBlock(block.id).split("#")[1]))).toEqual(new Set(["v1s1", "v1s2"]));
  expect(blocks.every((block) => block.day === "2026-09-18")).toBe(true);
});

test("handing in takes a low-energy hour and reading through a medium one, even in a high-energy task", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T12:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  // One high hour in the morning, a low evening: the task's own 「high」 used to leave the hand-in nowhere to go.
  const windows = [{ days: [5], start: "08:00", end: "09:00", energy: "high" as const }, { days: [5], start: "18:00", end: "20:00", energy: "low" as const }];
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "asap", importance: {}, windows });
  saveAvailability(TEST_CTX, windows);
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human", payload: { ...(order.payload as object), dueDate: "2026-09-18", humanCore: [{ energy: "high" }] } });
  store.saveStepPlan(TEST_CTX.workspaceId, order.id, { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" },
    rationale: "", steps: [step("a", "read", 25), step("b", "solve", 30, ["a"]), step("c", "submit", 15, ["b"])] }, "o", "t");
  const blocks = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith(`scheduled:${order.id}`));
  const at = (stepId: string) => blocks.find((block) => plannerIdOfBlock(block.id).endsWith(`#${stepId}`));
  expect(at("v1s1")?.start).toBe("08:00");
  expect(at("v1s2")!.start < "09:00").toBe(true);
  expect(at("v1s3")!.start >= "18:00").toBe(true);
});
