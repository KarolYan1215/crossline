import { expect, test, vi } from "vitest";
import { CrosslineStore, addAiTool } from "@crossline/db";
import { OUTDATED_PLAN_FEEDBACK, createStepPlanner, createWarningReviewer, requestFinerSplits, requestOutdatedReplans, taskWindow, tasksAwaitingStepPlan, warningsAwaitingReview } from "./step-planner";
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

  // The planner judging it important for the long run is not enough (2026-10-18: it said so of nearly everything): still an assumption.
  const fresh = new CrosslineStore(":memory:");
  seed(fresh);
  answer = plan(true);
  expect((await createStepPlanner(fresh, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(fresh.listProfileFacts(workspaceId).find((item) => item.slot === slot)).toMatchObject({ status: "inferred", value: "假设：【海报用哪种尺寸？】A3" });

  // Graded coursework read from the course's files is important by rule: researched on the web first, its questions asked.
  const graded = new CrosslineStore(":memory:");
  seed(graded);
  const order = graded.getWorkOrder(workspaceId, "wo")!;
  graded.saveWorkOrder({ ...order, payload: { ...(order.payload as object), datePair: { release: "2026-10-06", due: "2026-10-14" }, humanCore: [{ id: "h", intent: "解题" }] } });
  answer = plan(false);
  expect((await createStepPlanner(graded, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(prompts.at(-1)).toContain('"research":true');
  expect(graded.listProfileFacts(workspaceId).find((item) => item.slot === slot)).toBeUndefined();
  // The replan after the person answered asks nothing more: what it still wonders about is settled as an assumption (no re-ask loop).
  const followUp = { id: "q2", text: "海报印刷数量？", why: "影响预算", options: ["10 张", "50 张"] };
  answer = JSON.stringify({ ...JSON.parse(plan(true)), questions: [followUp] });
  expect((await createStepPlanner(graded, workspaceId, "C:\repo", () => runtime.rpc)("wo", "按回答重新安排")).state).toBe("planned");
  expect(graded.listProfileFacts(workspaceId).find((item) => item.slot === stepAnswerSlot(followUp.text)))
    .toMatchObject({ status: "inferred", value: "假设：【海报印刷数量？】10 张" });
  // Even an important task puts only its first two questions to the person; the third is an assumption.
  const three = ["范围到第几讲？", "用哪本教材？", "交 PDF 还是纸质？"].map((text, index) => ({ id: `t${index}`, text, why: "", options: [`选项${index}`] }));
  answer = JSON.stringify({ ...JSON.parse(plan(false)), questions: three });
  expect((await createStepPlanner(graded, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  const assumed = graded.listProfileFacts(workspaceId).filter((item) => three.some((question) => item.slot === stepAnswerSlot(question.text)));
  expect(assumed.map((item) => item.value)).toEqual(["假设：【交 PDF 还是纸质？】选项2"]);
  store.close(); fresh.close(); graded.close();
});

test("stored questions are filtered by rule: graded work keeps them, the rest become assumptions, whatever the planner judged", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const { settleOldQuestions } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  seed(store);
  const question = { id: "q1", text: "期中考到第几讲？", why: "", options: ["L1–L5", "L1–L7"] };
  const old = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "", questions: [question], steps: [step("a", "solve")] };
  store.saveStepPlan(workspaceId, "wo", old, ownerId, "t");
  store.saveWorkOrder({ id: "hw", ownerId, workspaceId, identityId: "research", projectId: "ece548", milestoneId: "", intent: "作业 4", state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { datePair: { due: "2026-10-20" } } });
  store.saveStepPlan(workspaceId, "hw", old, ownerId, "t");
  store.saveWorkOrder({ id: "new", ownerId, workspaceId, identityId: "research", projectId: "ece999", milestoneId: "", intent: "新计划", state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  store.saveStepPlan(workspaceId, "new", { ...old, importance: { longTerm: true, why: "毕业要求" } }, ownerId, "t");
  expect(settleOldQuestions(store, workspaceId).sort()).toEqual(["new", "wo"]);
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.slot === stepAnswerSlot(question.text));
  expect(facts.map((fact) => [fact.projectId, fact.value]).sort()).toEqual([["ece555", "假设：【期中考到第几讲？】L1–L5"], ["ece999", "假设：【期中考到第几讲？】L1–L5"]]);
  // The planner's own judgement is kept with the plan.
  expect(store.getStepPlan(workspaceId, "new")!.importance).toEqual({ longTerm: true, why: "毕业要求" });
  store.close();
});

test("the planner is given the person's AI tools, and each step keeps the tool that speeds it — one the person does not have is dropped", async () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  addAiTool(store, workspaceId, { name: "剪映", kind: "media", goodFor: "自动字幕、粗剪" });
  const answer = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "", units: [], questions: [],
    importance: { longTerm: false, why: "" },
    steps: [step("s", "solve", { aiAssist: { tool: "剪映", how: "自动字幕后只校对专有名词", minutesSaved: 25 } }),
      step("u", "submit", { dependsOn: ["s"], aiAssist: { tool: "Midjourney", how: "画封面", minutesSaved: 10 } })] };
  const runtime = scriptedRuntime(["crossline:crossline-step-planner"], () => JSON.stringify(answer));
  expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  const sent = JSON.parse(runtime.prompts()[0]!.split("\n\n").slice(1).join("\n\n")) as { aiTools: Array<{ name: string; by: string }> };
  expect(sent.aiTools.map((tool) => [tool.name, tool.by])).toEqual([["Crossline 助手", "system"], ["联网调研（Codex）", "system"], ["剪映", "person"]]);
  expect(store.getStepPlan(workspaceId, "wo")!.steps.map((item) => item.aiAssist?.tool ?? "")).toEqual(["剪映", ""]);
  store.close();
});

test("the task changed last is planned first, ahead of an older backlog", () => {
  const store = new CrosslineStore(":memory:");
  const order = (id: string) => ({ id, ownerId, workspaceId, identityId: "research", projectId: "ece555", milestoneId: "m", intent: `作业 ${id}`,
    state: "approved", riskTier: "routine" as const, estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const },
    payload: { family: "deep_work" } });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    seed(store);
    for (const id of ["zold1", "zold2", "zold3"]) store.saveWorkOrder(order(id));
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    store.saveWorkOrder(order("fresh"));
    expect(tasksAwaitingStepPlan(store, workspaceId)[0]).toBe("fresh");
    // A proposal still waiting for the person is planned before any committed task, so it is complete when it is shown.
    vi.setSystemTime(new Date("2026-10-01T06:00:00Z"));
    store.saveWorkOrder({ ...order("proposal"), state: "awaiting_plan_approval" });
    expect(tasksAwaitingStepPlan(store, workspaceId)[0]).toBe("proposal");
  } finally { vi.useRealTimers(); }
});

test("a plan from before first actions and AI assists is planned again once, and only when its work starts within a week", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    seed(store);
    store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
      steps: [step("a", "solve"), step("b", "submit", { dependsOn: ["a"] })] }, ownerId, "planned");
    const now = new Date("2026-10-21T12:00:00Z");
    vi.setSystemTime(now);
    // Its work has no time this week: left alone.
    expect(requestOutdatedReplans(store, workspaceId, now)).toEqual([]);
    store.setSetting(workspaceId, "schedule.orderStarts", JSON.stringify({ wo: "2026-10-23T14:00:00Z" }));
    expect(requestOutdatedReplans(store, workspaceId, now)).toEqual(["wo"]);
    expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual(["wo"]);
    expect((store.listEvents(workspaceId, { type: "task.steps_replan_requested" }).at(-1)!.payload as { feedback: string }).feedback).toBe(OUTDATED_PLAN_FEEDBACK);
    // Asked once, even while the replan has not run yet.
    expect(requestOutdatedReplans(store, workspaceId, now)).toEqual([]);
  } finally { vi.useRealTimers(); store.close(); }
});

test("a plan that already gives first actions is not replanned for being old", () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
    steps: [step("a", "solve", { firstAction: "打开题目 1，写下已知量", product: "ability" }), step("b", "submit", { dependsOn: ["a"], product: "action" })] }, ownerId, "planned");
  const now = new Date();
  store.setSetting(workspaceId, "schedule.orderStarts", JSON.stringify({ wo: new Date(now.getTime() + 86_400_000).toISOString() }));
  expect(requestOutdatedReplans(store, workspaceId, now)).toEqual([]);
  // One planned before steps named their product (2026-10-22) is planned again once under the step type table.
  store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
    steps: [step("a", "solve", { firstAction: "打开题目 1，写下已知量" })] }, ownerId, "planned");
  expect(requestOutdatedReplans(store, workspaceId, now)).toEqual(["wo"]);
  expect(requestOutdatedReplans(store, workspaceId, now)).toEqual([]);
  store.close();
});

test("a step not got through on two days is planned again smaller, once: 未执行 one day, a block nobody started the next", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    seed(store);
    store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
      steps: [step("a", "solve", { title: "推导第 1–2 题" }), step("b", "submit", { dependsOn: ["a"] })] }, ownerId, "planned");
    expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual([]);
    vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: "c1", type: "block.confirmed", entityId: "m1",
      payload: { blockId: "scheduled:wo:v1s1", workOrderId: "wo", stepId: "v1s1", day: "2026-10-12", outcome: "not_done" } });
    // One day alone is not enough.
    expect(requestFinerSplits(store, workspaceId)).toEqual([]);
    store.setSetting(workspaceId, "nudge.blocks:2026-10-13", JSON.stringify({ "scheduled:wo:v1s1": { id: "scheduled:wo:v1s1", orderId: "wo", stepId: "v1s1", began: true } }));
    expect(requestFinerSplits(store, workspaceId)).toEqual([{ orderId: "wo", stepId: "v1s1", version: 1, days: ["2026-10-12", "2026-10-13"] }]);
    const request = store.listEvents(workspaceId, { type: "task.steps_replan_requested" }).at(-1)!;
    expect((request.payload as { feedback: string }).feedback).toBe("「推导第 1–2 题」2 天没做成：拆细，首步 ≤15 分钟");
    expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual(["wo"]);
    // Asked once: not again this week.
    expect(requestFinerSplits(store, workspaceId)).toEqual([]);
  } finally { vi.useRealTimers(); store.close(); }
});

test("a block the person started that day is not a trouble, and nor is a block not yet over", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    seed(store);
    store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
      steps: [step("a", "solve"), step("b", "submit", { dependsOn: ["a"] })] }, ownerId, "planned");
    vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
    const seen = JSON.stringify({ "scheduled:wo:v1s1": { id: "scheduled:wo:v1s1", orderId: "wo", stepId: "v1s1", began: true } });
    store.setSetting(workspaceId, "nudge.blocks:2026-10-12", seen);
    store.setSetting(workspaceId, "nudge.blocks:2026-10-13", seen);
    store.setSetting(workspaceId, "nudge.blocks:2026-10-14", seen);
    store.recordConfirmedSession(workspaceId, "wo", ownerId, { startedAt: "2026-10-13T16:00:00.000Z", endedAt: "2026-10-13T17:00:00.000Z", minutes: 60, source: "one_tap", key: "s1" });
    expect(requestFinerSplits(store, workspaceId)).toEqual([]);
  } finally { vi.useRealTimers(); store.close(); }
});

// The real account, 2026-10-15: 「作业 3 题面及题目数」「作业提交方式」「协作与 AI 使用规则」 were put to the person for graded homework whose
// course files were on record. What the files settle is read from them; only what changes the plan stays a question.
test("an important task's questions the files answer become assumptions; the rest still go to the person", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const { settleOldQuestions } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  seed(store);
  store.saveWorkOrder({ id: "hw", ownerId, workspaceId, identityId: "research", projectId: "ece555", milestoneId: "", intent: "作业 3", state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { datePair: { due: "2026-10-20" } } });
  const questions = [{ id: "q1", text: "作业 3 题面及题目数？", why: "", options: ["5 题", "6 题"] },
    { id: "q2", text: "协作与 AI 使用规则？", why: "", options: [] },
    { id: "q3", text: "当前完成状态？", why: "", options: ["未开始", "做了一半"] }];
  store.saveStepPlan(workspaceId, "hw", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "", questions, steps: [step("a", "solve")] }, ownerId, "t");
  // No file for the course yet: nothing can be read, nothing is assumed.
  settleOldQuestions(store, workspaceId);
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot === stepAnswerSlot("作业 3 题面及题目数？"))).toBe(false);
  store.saveSourceDocument({ id: "syl", ownerId, workspaceId, kind: "text", fileName: "ECE555 syllabus.pdf", mediaType: "text/plain", sha256: "s", uri: "file://s",
    extractedText: "Homework policy", extractionStatus: "done", projectId: "ece555", createdAt: "2026-10-01T00:00:00Z" } as never);
  expect(settleOldQuestions(store, workspaceId)).toContain("hw");
  const facts = new Map(store.listProfileFacts(workspaceId).map((fact) => [fact.slot, fact.value]));
  expect(facts.get(stepAnswerSlot("作业 3 题面及题目数？"))).toBe("假设：【作业 3 题面及题目数？】以任务材料为准；材料未写明时按「5 题」");
  expect(facts.get(stepAnswerSlot("协作与 AI 使用规则？"))).toBe("假设：【协作与 AI 使用规则？】以任务材料为准");
  expect(facts.has(stepAnswerSlot("当前完成状态？"))).toBe(false);
  store.close();
});

test("a task's window starts on the person's own day, not the UTC one (W-18)", () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  store.setSetting(workspaceId, "schedule.preferences", JSON.stringify({ timeZone: "Asia/Shanghai" }));
  // 07:30 on Sunday 2026-10-18 in Beijing is still Saturday in UTC.
  const window = taskWindow(store, workspaceId, store.getWorkOrder(workspaceId, "wo")!, new Date("2026-10-17T23:30:00Z"));
  expect(window.notBefore).toBe("2026-10-18");
  store.close();
});
