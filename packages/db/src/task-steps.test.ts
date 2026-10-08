import { expect, test } from "vitest";
import { CrosslineStore, type StepPlanInput } from "./index";

const step = (id: string, role: string, dependsOn: string[] = []) => ({ id, role, title: `${role}-${id}`, deliverable: "d", doneCriterion: "c",
  share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn, notBefore: "", dueBy: "",
  schedulable: true, executor: "human" as const, tickOutcome: "" });
const plan = (steps: StepPlanInput["steps"]): StepPlanInput => ({ archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "r", steps });

test("a replan keeps the steps already done and replaces the rest; progress is recorded per step", () => {
  const store = new CrosslineStore(":memory:");
  const first = store.saveStepPlan("w", "wo-1", plan([step("s1", "read"), step("s2", "solve", ["s1"])]), "o", "initial");
  expect(first.version).toBe(1);
  expect(first.steps.map((s) => s.id)).toEqual(["v1s1", "v1s2"]);
  expect(first.steps[1]!.dependsOn).toEqual(["v1s1"]);

  expect(store.updateStepProgress("w", "wo-1", "v1s1", { progressQuarter: 2 }, "o", "user").changed).toBe(true);
  expect(store.updateStepProgress("w", "wo-1", "v1s1", { status: "done" }, "o", "user").changed).toBe(true);
  expect(store.getStepPlan("w", "wo-1")!.steps[0]).toMatchObject({ status: "done", progressQuarter: 4 });

  const second = store.saveStepPlan("w", "wo-1", plan([step("s1", "solve"), step("s2", "check", ["s1"])]), "o", "replan");
  expect(second.version).toBe(2);
  expect(second.steps.map((s) => [s.id, s.status])).toEqual([["v1s1", "done"], ["v2s1", "planned"], ["v2s2", "planned"]]);
  expect(store.listEvents("w", { entityId: "wo-1" }).map((event) => event.type))
    .toEqual(["task.steps_planned", "task.step_progress", "task.step_progress", "task.steps_planned"]);
  expect(() => store.updateStepProgress("w", "wo-1", "nope", { status: "done" }, "o", "user")).toThrow("STEP_NOT_FOUND");
  store.close();
});

test("step plans travel with a snapshot and restore", () => {
  const store = new CrosslineStore(":memory:");
  store.saveStepPlan("w", "wo-1", plan([step("s1", "read")]), "o", "initial");
  const target = new CrosslineStore(":memory:");
  target.importSnapshot(store.exportSnapshot("w"));
  expect(target.getStepPlan("w", "wo-1")?.steps.map((s) => s.title)).toEqual(["read-s1"]);
  store.close(); target.close();
});
