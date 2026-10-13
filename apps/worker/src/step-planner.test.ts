import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createStepPlanner, createWarningReviewer, tasksAwaitingStepPlan, warningsAwaitingReview } from "./step-planner";
import { materializeDatePairs } from "./date-pairs";
import { taskFromWorkOrder } from "./agent-dispatch";
import { scriptedRuntime } from "./testing/fake-runtime";

const workspaceId = "w";
const ownerId = "o";
const step = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role, title: `${role} ${id}`, deliverable: "产出",
  doneCriterion: "完成", share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 }, dependsOn: [], notBefore: "", dueBy: "",
  schedulable: true, executor: "human" as "human" | "agent" | "mixed", tickOutcome: "", ...extra });

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

test("one step the system can do is handed to the assistant on its own; a person's step is not", () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  const plan = store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 2, unit: "题" }, rationale: "",
    steps: [step("r", "read", { executor: "agent" }), step("s", "solve")] }, ownerId, "t");
  const handed = taskFromWorkOrder(store, workspaceId, "wo", undefined, plan.steps[0]!.id);
  expect(handed.ok && handed.input).toMatchObject({ stepId: plan.steps[0]!.id, title: "完成作业 2 · read r", category: "read_research_organize" });
  expect(taskFromWorkOrder(store, workspaceId, "wo", undefined, plan.steps[1]!.id)).toMatchObject({ ok: false, code: "ORDER_NOT_DISPATCHABLE" });
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

test("a flagged cross-line relation is reviewed: dismissed it stays, redone it is asked again with the reviewer's notes", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "r1", ownerId, workspaceId, identityId: "research", projectId: "p", title: "图表脚本", status: "draft", version: 1 });
  store.saveMilestone({ id: "m1", ownerId, workspaceId, identityId: "media", projectId: "", title: "首期发布", status: "draft", version: 1 });
  const relationId = "proposed:r1->m1:reuses";
  store.saveMilestoneRelation({ id: relationId, ownerId, workspaceId, fromMilestoneId: "r1", toMilestoneId: "m1", kind: "reuses", status: "candidate",
    explanation: "互相促进", refutedWhen: "" });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "w1", type: "validation.warned", entityId: relationId,
    payload: { subject: "milestone_relation", version: 1, warnings: [{ code: "RELATION_EXPLANATION_THIN", detail: "说明过短" }], revised: false } });
  const runtime = scriptedRuntime(["crossline:crossline-validation-reviewer"], () => JSON.stringify({ verdict: "redo", notes: "写明迁移的产出物，否则删除" }));
  const revised: Array<[string, string]> = [];
  const review = createWarningReviewer(store, workspaceId, "C:\repo", () => runtime.rpc, async () => undefined,
    async (id, notes) => { revised.push([id, notes]); });
  const [pending] = warningsAwaitingReview(store, workspaceId);
  expect(pending).toMatchObject({ entityId: relationId, subject: "milestone_relation" });
  expect(await review(pending!)).toMatchObject({ verdict: "redo" });
  expect(runtime.prompts().at(-1)).toContain("milestone_relation");
  expect(revised).toEqual([[relationId, "写明迁移的产出物，否则删除"]]);
  expect(warningsAwaitingReview(store, workspaceId)).toEqual([]);
  store.close();
});

test("a plan rests on the person's own material and facts: units quote the file, an unquoted unit is sent back, and the plan's questions are kept", async () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  store.saveSourceDocument({ id: "d1", ownerId, workspaceId, projectId: "ece555", kind: "text", fileName: "Lecture Plan.docx", mediaType: "text/plain", sha256: "x",
    uri: "file:///x", extractedText: "Week 1 L1 Quantum basics\nWeek 3 L5 PN junction electrostatics\nWeek 4 L7 MOS capacitor", extractionStatus: "done", createdAt: "2026-10-01T00:00:00Z" });
  store.upsertProfileFact({ workspaceId, identityId: "research", projectId: "ece555", slot: "target_grade", value: "A−（≥90）", status: "confirmed", sourceRef: "reply-1", sourceQuote: "A−", updatedAt: "2026-10-01T00:00:00Z" });
  const plan = (quote: string) => JSON.stringify({ archetypeId: "problem_set", quantity: { basis: "讲", amount: 2, unit: "讲" }, rationale: "",
    units: [{ id: "u1", title: "PN 结静电", docId: "doc-1", quote }, { id: "u2", title: "MOS 电容", docId: "doc-1", quote: "L7 MOS capacitor" }],
    questions: [{ id: "q1", text: "期中 1 考到第几讲？", why: "讲授计划没写考试范围", options: ["L1–L5", "L1–L7"] }],
    steps: [step("a", "solve", { covers: ["u1"], why: "目标 A−，余量小" }), step("b", "check", { dependsOn: ["a"], covers: ["u2"] })] });
  const prompts: string[] = [];
  let calls = 0;
  const runtime = scriptedRuntime(["crossline:crossline-step-planner"], (prompt) => { prompts.push(prompt); calls += 1; return calls === 1 ? plan("L5 PN junction made up") : plan("L5 PN junction electrostatics"); });
  const outcome = await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo");
  expect(outcome.state).toBe("planned");
  // The planner was given the whole file and the person's target, not a 300-character opening.
  expect(prompts[0]).toContain("L7 MOS capacitor");
  expect(prompts[0]).toContain("A−（≥90）");
  // The first answer quoted a line that is not in the file and was sent back.
  expect(calls).toBe(2);
  const saved = store.getStepPlan(workspaceId, "wo")!;
  expect(saved.units.map((unit) => unit.id)).toEqual(["u1", "u2"]);
  expect(saved.questions.map((question) => question.text)).toEqual(["期中 1 考到第几讲？"]);
  expect(saved.steps[0]).toMatchObject({ covers: ["u1"], why: "目标 A−，余量小" });
  store.close();
});

test("the planner is told what the assistant already made for the same course, including what still waits for review", async () => {
  const { CrosslineStore } = await import("@crossline/db");
  const { existingOutputs } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  const estimate = { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
  for (const [id, project] of [["hw1", "ece548"], ["hw2", "ece548"], ["other", "ece555"]] as const)
    store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: project, milestoneId: "", intent: id, state: "approved", riskTier: "routine", estimate, payload: {} });
  const run = (task: string, order: string, reviewRequired: boolean) => {
    store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: `r-${task}`, type: "agent.task.requested", entityId: task,
      payload: { taskId: task, workOrderId: order, title: `${order} · 材料目录`, category: "read_research_organize" } });
    store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: `c-${task}`, type: "agent.task.completed", entityId: task,
      payload: { taskId: task, reviewRequired, artifacts: [{ path: "out/目录.md", sha256: "x", bytes: 1 }] } });
  };
  run("t1", "hw1", true); run("t2", "other", false);
  const order = store.listWorkOrders("w").find((item) => item.id === "hw2")!;
  expect(existingOutputs(store, "w", order)).toEqual([{ title: "hw1 · 材料目录", status: "awaiting_review", forThisTask: false, files: ["目录.md"], note: "" }]);
  store.close();
});

test("only an important task's questions are asked: a minor task's become assumptions; graded work is researched first", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const store = new CrosslineStore(":memory:");
  seed(store);
  const question = { id: "q1", text: "海报用哪种尺寸？", why: "影响排版", options: ["A3", "A2"] };
  const plan = (longTerm: boolean) => JSON.stringify({ archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "",
    importance: { longTerm, why: longTerm ? "期中 85 分要靠它" : "日常杂事" }, units: [], questions: [question], steps: [step("a", "solve")] });
  const slot = stepAnswerSlot(question.text);
  const fact = () => store.listProfileFacts(workspaceId).find((item) => item.slot === slot);

  // Minor by rule and by the planner's own judgement: settled as an assumption the next plan reads, never asked.
  let answer = plan(false);
  const prompts: string[] = [];
  const runtime = scriptedRuntime(["crossline:crossline-step-planner"], (prompt) => { prompts.push(prompt); return answer; });
  expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(fact()).toMatchObject({ status: "inferred", value: "假设：【海报用哪种尺寸？】A3" });
  expect(prompts[0]).toContain('"research":false');

  // The planner judging it important for the long run: the question stays for the person.
  const fresh = new CrosslineStore(":memory:");
  seed(fresh);
  answer = plan(true);
  expect((await createStepPlanner(fresh, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(fresh.listProfileFacts(workspaceId).find((item) => item.slot === slot)).toBeUndefined();

  // Graded coursework read from the course's files is important by rule: researched on the web first, its questions asked.
  const graded = new CrosslineStore(":memory:");
  seed(graded);
  const order = graded.getWorkOrder(workspaceId, "wo")!;
  graded.saveWorkOrder({ ...order, payload: { ...(order.payload as object), datePair: { release: "2026-10-06", due: "2026-10-14" }, humanCore: [{ id: "h", intent: "解题" }] } });
  answer = plan(false);
  expect((await createStepPlanner(graded, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(prompts.at(-1)).toContain('"research":true');
  expect(graded.listProfileFacts(workspaceId).find((item) => item.slot === slot)).toBeUndefined();
  store.close(); fresh.close(); graded.close();
});
