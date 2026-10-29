import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, type StepPlanInput } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { AUTO_CLOSED_EVENT, autoCloseFinished, finishedByPerson } from "./auto-close";
import { undoOp } from "./undo";
import { TEST_CTX } from "./test-support";

/** A task hands itself in once the person's steps are done and only the assistant's or a wait are left (docs/plans/closed-loop-1030.md §3). */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId, owner = TEST_CTX.principalId;
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const step = (id: string, extra: Partial<StepPlanInput["steps"][number]> = {}) => ({ id, role: "solve", title: id, deliverable: "x", doneCriterion: "y", share: 0.5,
  estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "", ...extra });
const plan = (steps: StepPlanInput["steps"]): StepPlanInput => ({ archetypeId: "problem_set", quantity: { basis: "题", amount: 2, unit: "题" }, rationale: "r", steps });

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-11-10T16:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent: `任务 ${id}`, state: "approved", riskTier: "routine", estimate, payload: { materialContract: [], family: "deep_work" } });
  order("waiting"); order("assistant"); order("mine"); order("nothing");
  store.saveStepPlan(ws, "waiting", plan([step("s1"), step("s2", { role: "wait", schedulable: false })]), owner, "initial");
  store.saveStepPlan(ws, "assistant", plan([step("s1"), step("s2", { executor: "agent", schedulable: false })]), owner, "initial");
  store.saveStepPlan(ws, "mine", plan([step("s1"), step("s2")]), owner, "initial");
  store.saveStepPlan(ws, "nothing", plan([step("s1")]), owner, "initial");
  for (const id of ["waiting", "assistant", "mine"]) store.updateStepProgress(ws, id, store.getStepPlan(ws, id)!.steps[0]!.id, { status: "done" }, owner, "person");
  return store;
}

test("only work whose every person's step is done is closed: a wait or the assistant's step left does not hold it, the person's own step does", () => {
  const store = setup();
  expect(finishedByPerson(TEST_CTX).sort()).toEqual(["assistant", "waiting"]);
  expect(autoCloseFinished(TEST_CTX).sort()).toEqual(["assistant", "waiting"]);
  expect(store.getWorkOrder(ws, "waiting")!.state).toBe("accepted");
  expect(store.getWorkOrder(ws, "mine")!.state).toBe("approved");
  expect(store.getWorkOrder(ws, "nothing")!.state).toBe("approved");
  // Said once, with 撤销.
  const said = store.listRecentNudges(ws, "2026-11-01T00:00:00.000Z").filter((message) => (message.payload.nudge as { kind?: string }).kind === "auto_closed");
  expect(said).toHaveLength(1);
  expect(JSON.stringify(said[0]!.payload)).toContain("撤销");
  expect(autoCloseFinished(TEST_CTX)).toEqual([]);
});

test("撤销 opens the task again, and it is not closed by itself a second time", () => {
  const store = setup();
  autoCloseFinished(TEST_CTX);
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!;
  expect(undoOp(TEST_CTX, op.entityId)).toMatchObject({ ok: true });
  expect(store.getWorkOrder(ws, "waiting")!.state).toBe("approved");
  expect(store.listEvents(ws, { type: AUTO_CLOSED_EVENT })).toHaveLength(2);
  expect(autoCloseFinished(TEST_CTX)).toEqual([]);
});
