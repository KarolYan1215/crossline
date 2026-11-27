import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { planMerges, type MergeTask } from "@crossline/core";
import { DEDUPE_DAY_SETTING, DEDUPE_JUDGED_SETTING, DEDUPE_REVIEW_DAY_SETTING, REVIEW_PAIRS_PER_RUN, dedupePass, mergeTasks, renameByScope, reviewPairs } from "./dedupe";
import { fakeRuntime } from "./testing/fake-runtime";

/** The daily self-check that merges repeated tasks and folds requests for a fact into the task they serve (2026-10-15). */
let store: CrosslineStore;
afterEach(() => store?.close());
const ws = "w";
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, title: string, extra: { milestoneId?: string; state?: string; projectId?: string; payload?: Record<string, unknown> } = {}) =>
  store.saveWorkOrder({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: extra.projectId ?? "ece548", milestoneId: extra.milestoneId ?? "mid1",
    intent: title, state: extra.state ?? "approved", riskTier: "routine", estimate, payload: { title, ...(extra.payload ?? {}) } });
const step = (id: string, title: string, executor: "human" | "agent" = "human") => ({ id, role: "practice", title, deliverable: "", doneCriterion: "x", share: 0.5,
  estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: executor === "human", executor, tickOutcome: "" });
const deps = (now = new Date("2026-10-15T15:00:00.000Z")) => ({ store, workspaceId: ws, cwd: ".", client: () => undefined,
  spend: async () => ({ mode: "normal" as const }) as never, paused: () => false, enterUsage: () => {}, now });

test("rules: the same title merges, a milestone weeks apart goes to the reviewer, and every other near title is left to it (2026-11-25)", () => {
  const task = (id: string, title: string, intent = title, extra: Partial<MergeTask> = {}): MergeTask => ({ id, identityId: "research", projectId: "ece548",
    milestoneId: "mid1", title, intent, state: "approved", dueDate: "", milestoneDeadline: "2026-10-27", progress: 0, hasStepPlan: false, started: false, dependsOn: [], ...extra });
  const { groups, unsure } = planMerges([
    task("a", "整理 ECE 548 复习材料", "汇集课程讲义、作业、样题，形成材料清单"), task("b", "汇集 ECE 548 复习材料", "汇集课程讲义、作业与样题，形成材料目录", { progress: 0.5, hasStepPlan: true }),
    task("hw2", "完成 ECE 548 作业 2"), task("hw3", "完成 ECE 548 作业 3"),
    task("outline", "整理 ECE 548 复习提纲", "在周末前整理前几章的复习提纲"),
    task("final", "汇集 ECE 548 复习材料", "汇集讲义与往年题", { milestoneId: "final", milestoneDeadline: "2026-12-17" })
  ]);
  // Synonyms (汇集 / 整理) and numbers (作业 2 / 作业 3) are the reviewer's call now; code merges nothing here by itself.
  expect(groups).toEqual([]);
  expect(unsure.map((pair) => [pair.a, pair.b].sort().join("~"))).toEqual(expect.arrayContaining(["a~b", "b~outline", "hw2~hw3"]));
  // Serving milestones whose deadlines are over three weeks apart: no longer ruled out by code, put to the reviewer (2026-11-25).
  expect(unsure.map((pair) => [pair.a, pair.b].sort().join("~"))).toEqual(expect.arrayContaining(["b~final"]));
  // Identical titles are settled by code.
  expect(planMerges([task("a", "汇集 ECE 548 复习材料"), task("b", "汇集 ECE 548 复习材料", "x", { progress: 0.5 })]).groups)
    .toEqual([expect.objectContaining({ kind: "duplicate", keep: "b", absorb: ["a"] })]);
  const twoExams = [task("b", "汇集 ECE 548 复习材料", "x"), task("final", "汇集 ECE 548 复习材料", "x", { milestoneId: "final", milestoneDeadline: "2026-12-17" })];
  expect(planMerges(twoExams).groups).toEqual([]);
  expect(planMerges(twoExams, new Set(["b|final"])).groups).toEqual([expect.objectContaining({ kind: "duplicate" })]);
  // The reviewer's yes merges a pair the rules left open.
  expect(planMerges([task("b", "汇集 ECE 548 复习材料", "汇集讲义"), task("outline", "整理 ECE 548 复习提纲", "在周末前整理前几章的复习提纲")], new Set(["outline|b"])).groups)
    .toEqual([expect.objectContaining({ kind: "duplicate", keep: "b", absorb: ["outline"] })]);
});

test("a standalone request becomes the first steps of the task it serves; the merge is said once a day and undoable", async () => {
  store = new CrosslineStore(":memory:");
  // Recorded as the person's (as orders the person kept doing themselves are): what is merged and folded is decided within one owner.
  // The request is what the Skill that wrote it said (`payload.request`, 2026-11-22).
  order("ask", "确认 ECE 548 期中考查范围", { payload: { owner: "person", request: { kind: "ask_person", who: "助教或任课老师", fact: "ECE 548 期中考查范围" } } });
  order("mat", "汇集 ECE 548 复习材料", { payload: { owner: "person" } });
  order("mat2", "汇集 ECE 548 复习材料", { payload: { dueDate: "2026-10-25", owner: "person" } });
  order("hw2", "完成 ECE 555 作业 2", { projectId: "ece555", milestoneId: "hw" });
  order("hw3", "完成 ECE 555 作业 3", { projectId: "ece555", milestoneId: "hw" });
  store.saveStepPlan(ws, "mat", { archetypeId: "research_decision", quantity: { basis: "", amount: 0, unit: "" }, rationale: "",
    steps: [step("s1", "核对讲义目录"), step("s2", "补齐往年题", "agent")] }, "o", "t");
  const done = await dedupePass(deps());
  expect(done.map((item) => item.keep)).toEqual(["mat", "mat"]);
  const plan = store.getStepPlan(ws, "mat")!.steps;
  expect(plan.slice(0, 2).map((item) => [item.executor, item.title])).toEqual([
    ["agent", "起草给助教或任课老师的邮件：确认 ECE 548 期中考查范围"], ["human", "向助教或任课老师确认 ECE 548 期中考查范围"]]);
  expect(plan[1]!.estimate.p85Minutes).toBeLessThanOrEqual(15);
  expect(store.getWorkOrder(ws, "ask")!.state).toBe("archived");
  expect(store.getWorkOrder(ws, "mat2")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: "work_order.changed", change: "archived", entityId: "ask" })[0]?.payload).toMatchObject({ reason: "与「汇集 ECE 548 复习材料」合并", bySystem: true });
  // The kept task takes the earlier due day of what it absorbed.
  expect((store.getWorkOrder(ws, "mat")!.payload as { dueDate?: string; mergedFrom?: unknown[] })).toMatchObject({ dueDate: "2026-10-25", mergedFrom: [{ id: "ask" }, { id: "mat2" }] });
  expect(store.getWorkOrder(ws, "hw3")!.state).toBe("approved");
  const ops = store.listEvents(ws, { type: "op.applied" }).map((event) => (event.payload as { inverse: { kind: string; restore: string[] } }).inverse);
  expect(ops).toEqual([expect.objectContaining({ kind: "task.unmerge", restore: ["ask"] }), expect.objectContaining({ kind: "task.unmerge", restore: ["mat2"] })]);
  expect(store.getSetting(ws, DEDUPE_DAY_SETTING)).toBe("2026-10-15");
  // Once a day: a second pass the same day does nothing.
  order("dup", "汇集 ECE 548 复习材料");
  expect(await dedupePass(deps())).toEqual([]);
  expect(mergeTasks(store, ws).find((item) => item.id === "dup")?.state).toBe("approved");
});

test("the person's work is never merged with the assistant's or with a question, nor a question folded into the assistant's task (docs/work-split.md)", async () => {
  store = new CrosslineStore(":memory:");
  order("prep", "汇集 ECE 548 复习材料", { payload: { owner: "assistant" } });
  order("mine", "汇集 ECE 548 复习材料", { payload: { owner: "person" } });
  order("q", "确认 ECE 548 期中考查范围", { payload: { owner: "ask", question: "期中考到第几讲？" } });
  expect(await dedupePass(deps())).toEqual([]);
  expect(["prep", "mine", "q"].map((id) => store.getWorkOrder(ws, id)!.state)).toEqual(["approved", "approved", "approved"]);
  // Orders written before owners are the person's (2026-11-22: their wording is no longer read to guess one).
  order("old-prep", "汇集 ECE 548 往年卷");
  order("old-q", "确认 ECE 548 期中考查范围");
  expect(Object.fromEntries(mergeTasks(store, ws).map((task) => [task.id, task.owner])))
    .toEqual({ prep: "assistant", mine: "person", q: "ask", "old-prep": "person", "old-q": "person" });
});

test("requests in one milestone with nothing else to serve become one email; a task under way is never absorbed", async () => {
  store = new CrosslineStore(":memory:");
  order("req1", "确认课程项目要求", { projectId: "ece555", milestoneId: "proj", payload: { request: { kind: "ask_person", who: "", fact: "ECE 555 课程项目要求" } } });
  order("req2", "确认课程项目评分标准", { projectId: "ece555", milestoneId: "proj", payload: { request: { kind: "ask_person", who: "", fact: "ECE 555 课程项目评分标准" } } });
  order("busy", "汇集 ECE 548 复习材料", { state: "active" });
  order("busy2", "汇集 ECE 548 复习材料", { state: "active" });
  const done = await dedupePass(deps());
  expect(done).toHaveLength(1);
  expect(done[0]!.absorbed).toHaveLength(1);
  expect(["busy", "busy2"].map((id) => store.getWorkOrder(ws, id)!.state)).toEqual(["active", "active"]);
  const kept = store.getWorkOrder(ws, done[0]!.keep)!.payload as { infoRequests?: Array<{ what: string }> };
  expect(kept.infoRequests?.map((item) => item.what)).toEqual([done[0]!.keep === "req1" ? "ECE 555 课程项目评分标准" : "ECE 555 课程项目要求"]);
});

test("pairs left open while the quota was not normal are reviewed on a later tick the same day, once", async () => {
  store = new CrosslineStore(":memory:");
  order("outline", "整理 ECE 548 复习提纲", { payload: {} });
  store.saveWorkOrder({ ...store.getWorkOrder(ws, "outline")!, intent: "在周末前整理前几章的复习提纲" });
  order("mat", "汇集 ECE 548 复习材料");
  store.saveWorkOrder({ ...store.getWorkOrder(ws, "mat")!, intent: "汇集讲义" });
  const { rpc, turns } = fakeRuntime([JSON.stringify({ pairs: [{ id: "p1", same: true, why: "同一份复习材料" }] })], "crossline:crossline-validation-reviewer");
  const economy = { ...deps(), client: () => rpc, spend: async () => ({ mode: "economy" as const }) as never };
  // The day's run in economy: the rules settle nothing, the reviewer is not asked.
  expect(await dedupePass(economy)).toEqual([]);
  expect(turns()).toBe(0);
  expect(store.getSetting(ws, DEDUPE_REVIEW_DAY_SETTING)).toBeUndefined();
  // Later the same day, the quota normal again: the open pair is reviewed and merged, and said under its own key.
  const later = { ...deps(new Date("2026-10-15T19:00:00.000Z")), client: () => rpc };
  const done = await dedupePass(later);
  expect(turns()).toBe(1);
  expect(done.map((item) => item.absorbed.length)).toEqual([1]);
  expect(JSON.parse(store.getSetting(ws, DEDUPE_JUDGED_SETTING)!)).toEqual({ [`${done[0]!.keep === "mat" ? "mat|outline" : "outline|mat"}`]: true });
  expect(store.getSetting(ws, DEDUPE_REVIEW_DAY_SETTING)).toBe("2026-10-15");
  // Once: nothing more that day.
  order("dup", "汇集 ECE 548 复习材料");
  expect(await dedupePass(later)).toEqual([]);
  expect(turns()).toBe(1);
});

test("the reviewer sees at most three calls of pairs a run, likeliest first; the rest wait for a later day (2026-11-25)", async () => {
  store = new CrosslineStore(":memory:");
  const pairs = Array.from({ length: REVIEW_PAIRS_PER_RUN + 10 }, (_, index) => {
    order(`a${index}`, `整理第 ${index} 章笔记`); order(`b${index}`, `汇集第 ${index} 章笔记`);
    return { a: `a${index}`, b: `b${index}`, why: "", score: index / 100 };
  });
  const answer = (count: number) => JSON.stringify({ pairs: Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, same: false, why: "不同" })) });
  const { rpc, turns } = fakeRuntime([answer(12), answer(12), answer(12), answer(12)], "crossline:crossline-validation-reviewer");
  await reviewPairs(store, ws, rpc, ".", pairs);
  expect(turns()).toBe(3);
  const judged = Object.keys(JSON.parse(store.getSetting(ws, DEDUPE_JUDGED_SETTING)!) as Record<string, boolean>);
  expect(judged).toHaveLength(REVIEW_PAIRS_PER_RUN);
  // The ten least alike were left for another day.
  expect(judged).not.toContain("a0|b0");
  expect(judged).toContain(`a${REVIEW_PAIRS_PER_RUN + 9}|b${REVIEW_PAIRS_PER_RUN + 9}`);
});

test("same-named tasks for different exams stay apart and get the exam in their names", () => {
  store = new CrosslineStore(":memory:");
  for (const [id, title, deadline] of [["mid1", "ECE 548 期中考试 1 达到 A− 支撑线", "2026-10-27"], ["final", "ECE 548 期末考试达到 A− 支撑线", "2026-12-17"]] as const) {
    store.saveMilestone({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", title, version: 1, status: "approved" });
    store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: id, stage: 1, deadline, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "" });
  }
  order("a", "汇集 ECE 548 复习材料", { payload: { owner: "assistant" } });
  order("b", "汇集 ECE 548 复习材料", { milestoneId: "final", payload: { owner: "assistant" } });
  expect(renameByScope(store, ws).map((item) => item.title).sort()).toEqual(["汇集 ECE 548 复习材料（期中考试 1）", "汇集 ECE 548 复习材料（期末考试）"]);
  expect(store.getWorkOrder(ws, "a")!.state).toBe("approved");
  expect(renameByScope(store, ws)).toEqual([]);
});

test("the daily merge takes a part already on the board into its whole; the part's steps keep its day (W-194)", async () => {
  store = new CrosslineStore(":memory:");
  order("whole", "完成 ECE 555 作业 3", { projectId: "ece555", milestoneId: "hw", payload: { dueDate: "2026-10-20" } });
  order("part", "作业 3 第 1、2 题", { projectId: "ece555", milestoneId: "hw", state: "ready_for_human", payload: { dueDate: "2026-10-17" } });
  order("hw4", "作业 4 的前两题", { projectId: "ece555", milestoneId: "hw", payload: { dueDate: "2026-10-17" } });
  store.saveStepPlan(ws, "part", { archetypeId: "problem_set", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", steps: [step("p1", "解第 1、2 题")] }, "o", "t");
  const done = await dedupePass(deps());
  expect(done.map((item) => [item.keep, item.absorbed])).toEqual([["whole", ["part"]]]);
  expect(store.getWorkOrder(ws, "whole")!.payload).toMatchObject({ dueDate: "2026-10-20", partDeadlines: [{ title: "作业 3 第 1、2 题", dueDate: "2026-10-17" }] });
  expect(store.getStepPlan(ws, "whole")!.steps).toEqual([expect.objectContaining({ title: "解第 1、2 题", dueBy: "2026-10-17" })]);
  expect(store.getWorkOrder(ws, "hw4")!.state).toBe("approved");
});
