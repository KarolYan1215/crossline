import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { cardView, type TaskDetail } from "./task-detail";
import { currentStep, groupOf, stepSegments, waitReason } from "../app/task/card-model";

const step = (id: string, status: "planned" | "done", extra: Record<string, unknown> = {}) => ({
  id, title: `step ${id}`, status, progressQuarter: 0, executor: "human", schedulable: true, share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 },
  firstAction: "open the file", why: "x".repeat(400), covers: ["unit-1", "unit-2"], ...extra
});

const whole = {
  id: "wo-1", title: "HW 3", intent: "Finish homework 3", state: "approved", identityId: "research", identityLabel: "研究", workspaceId: "ws", viewerId: "p",
  paused: false, window: { dueBy: "2026-11-02" }, estimate: { p50Minutes: 60 }, seeded: false, agentSteps: [],
  humanCore: [{ id: "h1", intent: "Solve problem 2", quote: "q".repeat(300), rationale: "r".repeat(300) }],
  automationParts: [{ id: "a1", intent: "collect lectures" }], sources: [{ id: "s1", fileName: "syllabus.pdf" }], background: [], notes: [],
  criteria: [{ id: "c1", statement: "all problems", quarters: 0, by: "none" }], relatedFlywheel: [], supports: [], estimateBreakdown: [], byproducts: [],
  materialContract: [], evidenceContract: [{ kind: "file", description: "PDF", why: "graded", required: true }], evidenceChecklist: [], executions: [],
  preparedMaterials: [{ id: "m1", uri: "materials/wo-1/manual.md", fileName: "manual.md", mediaType: "text/markdown" }, { id: "m2", uri: "materials/wo-1/nodes/a/task.md", fileName: "task.md", mediaType: "text/markdown" }],
  agentOutputs: [{ taskId: "t1", title: "outline", status: "accepted", stepId: "v1s1", files: [{ path: "out.md", name: "out.md" }] },
    { taskId: "t2", title: "failed", status: "failed", stepId: "v1s2", files: [] }],
  stepPlan: { archetypeLabel: "作业", quantity: { basis: "problems", amount: 4, unit: "题" }, rationale: "long", progress: 0.25, units: [{ id: "u1" }], questions: [{ id: "q1" }],
    steps: [step("v1s1", "done"), step("v1s2", "planned")] }
} as unknown as TaskDetail;

describe("a card's copy of a task", () => {
  test("keeps what the card reads and drops what only the dialog reads", () => {
    const card = cardView(whole);
    expect(card.partial).toBe(true);
    expect(currentStep(card)?.id).toBe(currentStep(whole)?.id);
    expect(stepSegments(card)).toEqual(stepSegments(whole));
    expect(waitReason(card, "2026-10-28")).toEqual(waitReason(whole, "2026-10-28"));
    expect(groupOf(card, { today: "2026-10-28" })).toBe(groupOf(whole, { today: "2026-10-28" }));
    expect(card.stepPlan?.steps[1]?.firstAction).toBe("open the file");
    expect(card.preparedMaterials.map((item) => item.id)).toEqual(["m1"]);
    expect(card.agentOutputs.map((item) => item.taskId)).toEqual(["t1"]);
    expect(card.humanCore).toEqual([]);
    expect(card.sources).toEqual([]);
    expect(card.evidenceContract).toEqual([]);
    expect(JSON.stringify(card).length).toBeLessThan(JSON.stringify(whole).length / 2);
  });

  test("Today's day panel keeps what falls to the person, by name only", () => {
    expect(cardView(whole, { panel: true }).humanCore).toEqual([{ id: "h1", intent: "Solve problem 2" }]);
  });

  test("the whole detail is the one the card was made from", () => {
    expect(whole.partial).toBeUndefined();
  });
});
