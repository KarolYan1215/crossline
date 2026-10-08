import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createStepPlanner, createWarningReviewer, tasksAwaitingStepPlan, warningsAwaitingReview } from "./step-planner";
import { materializeDatePairs } from "./date-pairs";
import { scriptedRuntime } from "./testing/fake-runtime";

const workspaceId = "w";
const ownerId = "o";
const step = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role, title: `${role} ${id}`, deliverable: "产出",
  doneCriterion: "完成", share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 }, dependsOn: [], notBefore: "", dueBy: "",
  schedulable: true, executor: "human", tickOutcome: "", ...extra });

function seed(store: CrosslineStore) {
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "ece555", title: "ECE 555 期中", status: "approved", version: 1 });
  store.saveWorkOrder({ id: "wo", ownerId, workspaceId, identityId: "research", projectId: "ece555", milestoneId: "m", intent: "完成作业 2",
    state: "approved", riskTier: "milestone", estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { family: "deep_work" } });
}

test("a committed task gets a step plan; warnings are recorded, not refused, and a reviewer can have it redone once", async () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual(["wo"]);
  // Breaks the archetype's order (solve before read is fine; check before solve is not) and leaves out the hand-in.
  const first = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
    steps: [step("c", "check"), step("s", "solve", { dependsOn: ["c"] })] };
  const second = { ...first, steps: [step("s", "solve"), step("c", "check", { dependsOn: ["s"] }), step("u", "submit", { dependsOn: ["c"] })] };
  const answers = [JSON.stringify(first), JSON.stringify({ verdict: "redo", notes: "把检查放在解题之后，并加提交" }), JSON.stringify(second)];
  const runtime = scriptedRuntime(["crossline:crossline-step-planner", "crossline:crossline-validation-reviewer"], (prompt) => prompt.includes("validation-review") ? answers[1]! : prompt.includes("把检查放在") ? answers[2]! : answers[0]!);
  const planner = createStepPlanner(store, workspaceId, "C:\\repo", () => runtime.rpc);
  const outcome = await planner("wo");
  expect(outcome.state).toBe("planned");
  expect(store.getStepPlan(workspaceId, "wo")?.steps).toHaveLength(2);
  expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual([]);
  const pending = warningsAwaitingReview(store, workspaceId);
  expect(pending[0]!.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["STEP_ORDER_RULE", "STEP_END_RULE", "STEP_REQUIRED_ROLE_MISSING"]));

  const review = createWarningReviewer(store, workspaceId, "C:\\repo", () => runtime.rpc, (id, feedback) => planner(id, feedback));
  expect((await review(pending[0]!))?.verdict).toBe("redo");
  const plan = store.getStepPlan(workspaceId, "wo")!;
  expect(plan.version).toBe(2);
  expect(plan.steps.map((s) => s.role)).toEqual(["solve", "check", "submit"]);
  expect(warningsAwaitingReview(store, workspaceId)).toEqual([]);
  store.close();
});

test("confirmed homework dates become one default-effective task between release and due, matched by project name", () => {
  const store = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece555", ownerId, workspaceId, identityId: "research", name: "ECE 555", status: "active", summary: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" });
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "ece555", title: "ECE 555 期中", status: "approved", version: 1 });
  const fact = (slot: string, value: string) => store.upsertProfileFact({ workspaceId, identityId: "research", projectId: "ECE 555", slot, value,
    status: "confirmed", sourceRef: "src-1", sourceQuote: value, updatedAt: "2026-09-01T00:00:00Z" });
  fact("date_20261012_homework_out", "2026-10-12 作业 3 发布");
  fact("date_20261102_homework_due", "2026-11-02 作业 3 截止");
  fact("date_20260928_homework_due", "2026-09-28 作业 1 截止");
  const now = new Date("2026-10-07T15:00:00Z");
  expect(materializeDatePairs(store, workspaceId, now)).toEqual(["datepair-ece555-hw3"]);
  expect(materializeDatePairs(store, workspaceId, now)).toEqual([]);
  const order = store.listWorkOrders(workspaceId)[0]!;
  expect(order).toMatchObject({ projectId: "ece555", milestoneId: "m", state: "approved", intent: "完成 ECE 555 作业 3",
    payload: { dueDate: "2026-11-02", notBefore: "2026-10-12" } });
  store.close();
});
