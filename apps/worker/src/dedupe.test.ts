import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { planMerges, type MergeTask } from "@crossline/core";
import { DEDUPE_DAY_SETTING, dedupePass, mergeTasks } from "./dedupe";

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

test("rules: the same title merges, a numbered sibling or a milestone weeks apart never does, and a near title with a different deliverable is left to the reviewer", () => {
  const task = (id: string, title: string, intent = title, extra: Partial<MergeTask> = {}): MergeTask => ({ id, identityId: "research", projectId: "ece548",
    milestoneId: "mid1", title, intent, state: "approved", dueDate: "", milestoneDeadline: "2026-10-27", progress: 0, hasStepPlan: false, started: false, dependsOn: [], ...extra });
  const { groups, unsure } = planMerges([
    task("a", "整理 ECE 548 复习材料", "汇集课程讲义、作业、样题，形成材料清单"), task("b", "汇集 ECE 548 复习材料", "汇集课程讲义、作业与样题，形成材料目录", { progress: 0.5, hasStepPlan: true }),
    task("hw2", "完成 ECE 548 作业 2"), task("hw3", "完成 ECE 548 作业 3"),
    task("outline", "整理 ECE 548 复习提纲", "在周末前整理前几章的复习提纲"),
    task("final", "汇集 ECE 548 复习材料", "汇集讲义与往年题", { milestoneId: "final", milestoneDeadline: "2026-12-17" })
  ]);
  expect(groups).toEqual([expect.objectContaining({ kind: "duplicate", keep: "b", absorb: ["a"] })]);
  expect(unsure.map((pair) => [pair.a, pair.b].sort().join("~"))).toEqual(expect.arrayContaining(["b~outline"]));
  // Serving milestones whose deadlines are over three weeks apart: apart, and not even put to the reviewer.
  expect(unsure.some((pair) => [pair.a, pair.b].includes("final") || [pair.a, pair.b].includes("hw2"))).toBe(false);
  expect(planMerges([task("b", "汇集 ECE 548 复习材料", "x"), task("final", "汇集 ECE 548 复习材料", "x", { milestoneId: "final", milestoneDeadline: "2026-12-17" })], new Set(["b|final"])).groups).toEqual([]);
  // The reviewer's yes merges a pair the rules left open.
  expect(planMerges([task("b", "汇集 ECE 548 复习材料", "汇集讲义"), task("outline", "整理 ECE 548 复习提纲", "在周末前整理前几章的复习提纲")], new Set(["outline|b"])).groups)
    .toEqual([expect.objectContaining({ kind: "duplicate", keep: "b", absorb: ["outline"] })]);
});

test("a standalone request becomes the first steps of the task it serves; the merge is said once a day and undoable", async () => {
  store = new CrosslineStore(":memory:");
  order("ask", "确认 ECE 548 期中考查范围");
  order("mat", "汇集 ECE 548 复习材料");
  order("mat2", "整理 ECE 548 复习材料", { payload: { dueDate: "2026-10-25" } });
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
  expect(store.listEvents(ws, { type: "work_order.archived", entityId: "ask" })[0]?.payload).toMatchObject({ reason: "与「汇集 ECE 548 复习材料」合并", bySystem: true });
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

test("requests in one milestone with nothing else to serve become one email; a task under way is never absorbed", async () => {
  store = new CrosslineStore(":memory:");
  order("req1", "确认课程项目要求", { projectId: "ece555", milestoneId: "proj" });
  order("req2", "确认课程项目评分标准", { projectId: "ece555", milestoneId: "proj" });
  order("busy", "汇集 ECE 548 复习材料", { state: "active" });
  order("busy2", "汇集 ECE 548 复习材料", { state: "active" });
  const done = await dedupePass(deps());
  expect(done).toHaveLength(1);
  expect(done[0]!.absorbed).toHaveLength(1);
  expect(["busy", "busy2"].map((id) => store.getWorkOrder(ws, id)!.state)).toEqual(["active", "active"]);
  const kept = store.getWorkOrder(ws, done[0]!.keep)!.payload as { infoRequests?: Array<{ what: string }> };
  expect(kept.infoRequests?.map((item) => item.what)).toEqual([done[0]!.keep === "req1" ? "ECE 555 课程项目评分标准" : "ECE 555 课程项目要求"]);
});
