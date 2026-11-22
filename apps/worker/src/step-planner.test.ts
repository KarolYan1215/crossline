import { expect, test, vi } from "vitest";
import { CrosslineStore, addAiTool } from "@crossline/db";
import { OUTDATED_PLAN_FEEDBACK, createStepPlanner, createWarningReviewer, requestFinerSplits, requestOutdatedReplans, taskWindow, tasksAwaitingStepPlan, warningsAwaitingReview } from "./step-planner";
import { materializeDatePairs } from "./date-pairs";
import { taskFromWorkOrder } from "./agent-dispatch";
import { recordedAnswer, scriptedRuntime } from "./testing/fake-runtime";

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
  // A step the archetype does not usually have (the archetype's order and required parts are guidance since 2026-11-20, not warnings).
  const first = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "",
    steps: [step("c", "compare"), step("s", "solve", { dependsOn: ["c"] })] };
  const second = { ...first, steps: [step("s", "solve"), step("c", "check", { dependsOn: ["s"] }), step("u", "submit", { dependsOn: ["c"] })] };
  const answers = [JSON.stringify(first), JSON.stringify({ verdict: "redo", notes: "把检查放在解题之后，并加提交" }), JSON.stringify(second)];
  const runtime = scriptedRuntime(["crossline:crossline-step-planner", "crossline:crossline-validation-reviewer"], (prompt) => prompt.includes("validation-review") ? answers[1]! : prompt.includes("把检查放在") ? answers[2]! : answers[0]!);
  const planner = createStepPlanner(store, workspaceId, "C:\\repo", () => runtime.rpc);
  const outcome = await planner("wo");
  expect(outcome.state).toBe("planned");
  expect(store.getStepPlan(workspaceId, "wo")?.steps).toHaveLength(2);
  expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual([]);
  const pending = warningsAwaitingReview(store, workspaceId);
  expect(pending[0]!.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["STEP_ROLE_OUTSIDE_ARCHETYPE"]));

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

test("the model decides which questions reach the person (ask); the rest are assumptions at once, with no cap; graded work is researched first", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const store = new CrosslineStore(":memory:");
  seed(store);
  const cost = { waste: 60, harm: "quality", fixable: "before_step" };
  const question = (text: string, ask: boolean, options = ["A3", "A2"], assume = options[0]) =>
    ({ id: `q-${text.length}`, text, why: "影响排版", options, assume, neededBy: "a", ask, ifWrong: ask ? cost : { waste: 0, harm: "none", fixable: "before_step" } });
  const plan = (questions: unknown[]) => JSON.stringify({ archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "",
    importance: { longTerm: false, why: "日常杂事" }, units: [], questions, steps: [step("a", "solve")] });
  const fact = (db: CrosslineStore, text: string) => db.listProfileFacts(workspaceId).find((item) => item.slot === stepAnswerSlot(text));

  // ask false: settled as its assumption (`assume`, not merely the first option) the next plan reads; ask true: left for the person.
  let answer = plan([question("海报用哪种尺寸？", false, ["A3", "A2"], "A2"), question("评分看重哪一项？", true, ["创意", "规范"])]);
  const prompts: string[] = [];
  const runtime = scriptedRuntime(["crossline:crossline-step-planner"], (prompt) => { prompts.push(prompt); return answer; });
  expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(fact(store, "海报用哪种尺寸？")).toMatchObject({ status: "inferred", value: "假设：【海报用哪种尺寸？】A2" });
  expect(fact(store, "评分看重哪一项？")).toBeUndefined();
  expect(prompts[0]).toContain('"research":false');

  // No cap: five asked questions all stay open; a replan after answers asks a new critical one too, and never one already settled.
  const five = ["范围到第几讲？", "用哪本教材？", "交 PDF 还是纸质？", "允许用计算器吗？", "要不要写推导？"].map((text) => question(text, true, ["是", "否"]));
  answer = plan(five);
  expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(five.filter((item) => fact(store, item.text))).toEqual([]);
  answer = plan([question("海报用哪种尺寸？", true), question("海报印刷数量？", true, ["10 张", "50 张"])]);
  expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo", "按回答重新安排")).state).toBe("planned");
  expect(fact(store, "海报印刷数量？")).toBeUndefined();
  expect(fact(store, "海报用哪种尺寸？")).toMatchObject({ value: "假设：【海报用哪种尺寸？】A2" });

  // An asked question whose cost is nothing is sent back to the model with the reason, and the fixed answer is kept.
  const fresh = new CrosslineStore(":memory:");
  seed(fresh);
  const free = { ...question("字体用哪种？", true), ifWrong: { waste: 0, harm: "none", fixable: "before_step" } };
  const answers = [plan([free]), plan([{ ...free, ask: false }])];
  const repair = scriptedRuntime(["crossline:crossline-step-planner"], (prompt) => { prompts.push(prompt); return answers.shift() ?? answers[0]!; });
  expect((await createStepPlanner(fresh, workspaceId, "C:\repo", () => repair.rpc)("wo")).state).toBe("planned");
  expect(prompts.some((prompt) => prompt.includes("没有代价的就按 assume 做"))).toBe(true);
  expect(fact(fresh, "字体用哪种？")).toMatchObject({ status: "inferred" });

  // Work for a milestone the reviewer weighed at 60 or more is still researched on the web first (no rule makes every date pair important).
  const graded = new CrosslineStore(":memory:");
  seed(graded);
  const order = graded.getWorkOrder(workspaceId, "wo")!;
  graded.saveWorkOrder({ ...order, payload: { ...(order.payload as object), humanCore: [{ id: "h", intent: "解题" }] } });
  graded.setSetting(workspaceId, "milestones.risks", JSON.stringify({ m: { fingerprint: "f", at: "2026-10-01T00:00:00.000Z", source: "model", risks: [],
    reading: { weight: 75, weightWhy: "计入课程成绩", sitting: false, startsAt: "" } } }));
  answer = plan([]);
  expect((await createStepPlanner(graded, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
  expect(prompts.at(-1)).toContain('"research":true');
  store.close(); fresh.close(); graded.close();
});

test("stored questions are settled by the model's own call: unasked and older ones become assumptions, asked ones stay, whatever the task", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const { settleOldQuestions } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  seed(store);
  const question = { id: "q1", text: "期中考到第几讲？", why: "", options: ["L1–L5", "L1–L7"] };
  const asked = { id: "q2", text: "目标分数多少？", why: "", options: ["85", "90"], assume: "90", neededBy: "a", ask: true,
    ifWrong: { waste: 120, harm: "quality" as const, fixable: "before_step" as const } };
  const old = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "", questions: [question, asked], steps: [step("a", "solve")] };
  store.saveStepPlan(workspaceId, "wo", old, ownerId, "t");
  store.saveWorkOrder({ id: "hw", ownerId, workspaceId, identityId: "research", projectId: "ece548", milestoneId: "", intent: "作业 4", state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { datePair: { due: "2026-10-20" } } });
  store.saveStepPlan(workspaceId, "hw", old, ownerId, "t");
  // Graded work is no longer special: its plan written before `ask` is settled like any other.
  expect(settleOldQuestions(store, workspaceId).sort()).toEqual(["hw", "wo"]);
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.slot === stepAnswerSlot(question.text));
  expect(facts.map((fact) => [fact.projectId, fact.value]).sort()).toEqual([["ece548", "假设：【期中考到第几讲？】L1–L5"], ["ece555", "假设：【期中考到第几讲？】L1–L5"]]);
  expect(store.listProfileFacts(workspaceId).some((fact) => fact.slot === stepAnswerSlot(asked.text))).toBe(false);
  // Once settled, nothing more to do.
  expect(settleOldQuestions(store, workspaceId)).toEqual([]);
  store.close();
});

test("an asked question still open on the day its step starts is settled as its assumption, and the person is told once", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const { assumeAtNeededDay } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  seed(store);
  const asked = (text: string, neededBy: string) => ({ id: text, text, why: "", options: ["A", "B"], assume: "B", neededBy, ask: true,
    ifWrong: { waste: 60, harm: "quality" as const, fixable: "before_step" as const } });
  store.saveStepPlan(workspaceId, "wo", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "",
    questions: [asked("今天要用的？", "a"), asked("下周才用的？", "b")],
    steps: [step("a", "solve", { notBefore: "2026-10-10" }), step("b", "check", { notBefore: "2026-10-17" })] }, ownerId, "t");
  expect(assumeAtNeededDay(store, workspaceId, "2026-10-09")).toEqual([]);
  expect(assumeAtNeededDay(store, workspaceId, "2026-10-10")).toEqual(["wo"]);
  // The stored plan's step ids are its own (`v1s1`); the questions' `neededBy` follows them.
  expect(store.getStepPlan(workspaceId, "wo")!.questions.map((question) => question.neededBy)).toEqual(["v1s1", "v1s2"]);
  const value = (text: string) => store.listProfileFacts(workspaceId).find((fact) => fact.slot === stepAnswerSlot(text))?.value;
  expect(value("今天要用的？")).toBe("假设：【今天要用的？】B");
  expect(value("下周才用的？")).toBeUndefined();
  const told = store.listConversations(workspaceId).flatMap((conversation) => store.listConversationMessages(workspaceId, conversation.id));
  expect(JSON.stringify(told)).toContain("今天要用的？");
  expect(assumeAtNeededDay(store, workspaceId, "2026-10-10")).toEqual([]);
  store.close();
});

// The real account, 2026-10-15: 「作业 3 题面及题目数」「作业提交方式」「协作与 AI 使用规则」 were put to the person for graded homework whose
// course files were on record. Since 2026-11-22 what the files settle is the planner's call (`ask` false), not a word list in code: a
// question it does not mark worth asking is settled as its assumption; one it does mark goes to the person, files or not.
test("old questions: the planner's `ask` decides, whatever the question's wording and whatever files are on record", async () => {
  const { stepAnswerSlot } = await import("@crossline/core");
  const { settleOldQuestions } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  seed(store);
  store.saveWorkOrder({ id: "hw", ownerId, workspaceId, identityId: "research", projectId: "ece555", milestoneId: "", intent: "作业 3", state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { datePair: { due: "2026-10-20" } } });
  const questions = [{ id: "q1", text: "作业 3 题面及题目数？", why: "", options: ["5 题", "6 题"], ask: false },
    { id: "q2", text: "协作与 AI 使用规则？", why: "", options: ["可以用 AI"], ask: true },
    { id: "q3", text: "当前完成状态？", why: "", options: ["未开始", "做了一半"], ask: true }];
  store.saveStepPlan(workspaceId, "hw", { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "", questions, steps: [step("a", "solve")] }, ownerId, "t");
  store.saveSourceDocument({ id: "syl", ownerId, workspaceId, kind: "text", fileName: "ECE555 syllabus.pdf", mediaType: "text/plain", sha256: "s", uri: "file://s",
    extractedText: "Homework policy", extractionStatus: "done", projectId: "ece555", createdAt: "2026-10-01T00:00:00Z" } as never);
  expect(settleOldQuestions(store, workspaceId)).toContain("hw");
  const facts = new Map(store.listProfileFacts(workspaceId).map((fact) => [fact.slot, fact.value]));
  expect(facts.get(stepAnswerSlot("作业 3 题面及题目数？"))).toBe("假设：【作业 3 题面及题目数？】5 题");
  expect(facts.has(stepAnswerSlot("协作与 AI 使用规则？"))).toBe(false);
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

test("a drill form taken from an identity template is cut on the way to the ledger, and the person is asked how they work; their own words keep it", async () => {
  // A recorded-style answer (testing/fixtures/step-plan-drill-form-from-identity.txt): 「做 2 套往年卷并订正」「整理错题本」 written because the
  // person is a student, with nothing they said behind it (the owner's rule of 2026-11-10).
  const answer = recordedAnswer("step-plan-drill-form-from-identity");
  const run = async (facts: Array<{ slot: string; value: string }>) => {
    const store = new CrosslineStore(":memory:");
    seed(store);
    for (const fact of facts) store.upsertProfileFact({ workspaceId, identityId: "person", projectId: "", slot: fact.slot, value: fact.value, status: "confirmed",
      sourceRef: "reply-1", sourceQuote: fact.value, updatedAt: "2026-11-10T00:00:00Z" });
    const runtime = scriptedRuntime(["crossline:crossline-step-planner", "crossline:crossline-validation-reviewer"],
      (prompt) => prompt.includes("validation-review") ? JSON.stringify({ verdict: "dismiss", notes: "" }) : answer);
    expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo")).state).toBe("planned");
    const saved = store.getStepPlan(workspaceId, "wo")!;
    const assumed = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "inferred").map((fact) => fact.value);
    store.close();
    return { saved, assumed };
  };
  const { saved, assumed } = await run([]);
  const written = saved.steps.flatMap((item) => [item.title, item.deliverable, item.doneCriterion, item.firstAction ?? ""]).join(" ") + saved.rationale;
  expect(written).not.toMatch(/订正|错题/);
  expect(saved.steps.map((item) => item.title)).toEqual(["汇集 ECE 555 往年期中卷", "推导 L5–L6 P-N 结静电与 I-V", "做 2 套往年卷", "限时模拟一套期中卷"]);
  // The mock waited on the dropped step; it now waits on what that step waited on.
  expect(saved.steps[3]!.dependsOn).toEqual([saved.steps[2]!.id]);
  // The method is asked, first, and the question about the 错题本 is gone; an assumed answer invents no method. This recorded answer
  // predates the planner's own `methodQuestion`, so the general wording is asked (no word list picks one from the title any more).
  expect(saved.questions.map((question) => question.text)).toEqual(["平时怎么做这类事？", "期中考到第几讲？"]);
  expect(assumed.join(" ")).not.toMatch(/订正|错题/);

  const own = await run([{ slot: "method_exam_prep", value: "做完往年卷我习惯对着答案订正，错题记进错题本" }]);
  expect(own.saved.steps.map((item) => item.title)).toEqual(["汇集 ECE 555 往年期中卷", "推导 L5–L6 P-N 结静电与 I-V", "做 2 套往年卷并订正", "整理错题本", "限时模拟一套期中卷"]);
  expect(own.saved.questions.map((question) => question.text)).toEqual(["期中考到第几讲？", "错题本用纸质还是电子？"]);
});

test("the one granularity replan asks once for every open plan with several person's steps; the replan keeps a locked block and reported progress", async () => {
  const { FROZEN_SETTING } = await import("@crossline/core");
  const { GRANULARITY_FEEDBACK, requestGranularityReplans } = await import("./step-planner");
  const store = new CrosslineStore(":memory:");
  seed(store);
  const base = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "" };
  store.saveStepPlan(workspaceId, "wo", { ...base, steps: [step("a", "read", { title: "读题" }), step("b", "solve", { title: "解第 1–4 题" }), step("c", "submit", { title: "提交" })] }, ownerId, "t");
  store.updateStepProgress(workspaceId, "wo", "v1s2", { progressQuarter: 2 }, ownerId, "test");
  store.setSetting(workspaceId, FROZEN_SETTING, JSON.stringify([{ blockId: "scheduled:wo:v1s2", start: "2026-11-22T15:00:00Z", end: "2026-11-22T16:00:00Z", reason: "locked" }]));
  expect(requestGranularityReplans(store, workspaceId)).toEqual(["wo"]);
  expect(requestGranularityReplans(store, workspaceId)).toEqual([]);
  expect(tasksAwaitingStepPlan(store, workspaceId)).toEqual(["wo"]);
  const whole = { ...base, steps: [step("s", "solve", { title: "完成作业 2（解第 1–4 题并提交）", doneCriterion: "4 题写完并已提交" })] };
  const runtime = scriptedRuntime(["crossline:crossline-step-planner"], () => JSON.stringify(whole));
  expect((await createStepPlanner(store, workspaceId, "C:\repo", () => runtime.rpc)("wo", GRANULARITY_FEEDBACK)).state).toBe("planned");
  const plan = store.getStepPlan(workspaceId, "wo")!;
  expect(plan.steps.map((item) => [item.id, item.progressQuarter])).toEqual([["v2s1", 2]]);
  expect(JSON.parse(store.getSetting(workspaceId, FROZEN_SETTING)!).map((item: { blockId: string }) => item.blockId)).toEqual(["scheduled:wo:v2s1"]);
  store.close();
});
