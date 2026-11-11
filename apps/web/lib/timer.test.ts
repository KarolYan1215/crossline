import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { focusStep, startWorkOrderExecution } from "./crossline";
import { activeTimers } from "./timer";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const step = (id: string, title: string) => ({ id, role: "solve", title, deliverable: "结果", doneCriterion: "做完", share: 0.5,
  estimate: { p25Minutes: 30, p50Minutes: id === "s1" ? 40 : 90, p85Minutes: 120 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true,
  executor: "human" as const, tickOutcome: "" });

test("starting from a block times that block's step, not the task's first open one (2026-11-11, W-258)", () => {
  // The owner started 「批准实测参数映射」 (step 7) from its block; the timer and the completion sheet said step 5.
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "完成仿真",
    state: "ready_for_human", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 130, p85Minutes: 200, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  store.saveStepPlan(ws, "wo", { archetypeId: "problem_set", quantity: { basis: "步", amount: 2, unit: "步" }, rationale: "两步",
    steps: [step("s1", "核验曲线映射"), step("s2", "批准参数映射")] }, owner, "initial");
  expect(startWorkOrderExecution(TEST_CTX, "wo")).toMatchObject({ ok: true });
  expect(activeTimers(TEST_CTX)[0]).toMatchObject({ stepId: "v1s1" });
  expect(focusStep(TEST_CTX, "wo", "v1s2")).toBe(true);
  expect(activeTimers(TEST_CTX)[0]).toMatchObject({ stepId: "v1s2", stepTitle: "批准参数映射", targetMinutes: 90 });
  // A step that is not the task's, or is already done, is not taken.
  expect(focusStep(TEST_CTX, "wo", "nope")).toBe(false);
  store.updateStepProgress(ws, "wo", "v1s2", { status: "done" }, owner, "person");
  expect(activeTimers(TEST_CTX)[0]).toMatchObject({ stepId: "v1s1" });
});
