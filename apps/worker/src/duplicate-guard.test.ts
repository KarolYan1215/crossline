import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createGoalBackplanner } from "./goal-backplanner";
import { existingTasksFor, foldNewTask } from "./duplicate-guard";
import { materializeDatePairs } from "./date-pairs";
import { fakeRuntime } from "./testing/fake-runtime";

/** Duplicates are prevented where tasks are written; the daily merge is only the backstop (the owner's direction of 2026-10-15). */
let store: CrosslineStore;
afterEach(() => store?.close());
const ws = "w";
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, title: string, extra: { state?: string; intent?: string; milestoneId?: string; payload?: Record<string, unknown> } = {}) =>
  store.saveWorkOrder({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", milestoneId: extra.milestoneId ?? "m",
    intent: extra.intent ?? title, state: extra.state ?? "approved", riskTier: "routine", estimate, payload: { title, ...(extra.payload ?? {}) } });

test("a captured task the board already has is folded into it, an addition goes into the task it adds to, and an unsure one stays", () => {
  store = new CrosslineStore(":memory:");
  order("mat", "汇集 ECE 548 复习材料", { intent: "汇集课程讲义、作业与样题，形成材料目录" });
  order("hw2", "完成 ECE 548 作业 2");
  order("new1", "整理 ECE 548 复习材料", { state: "awaiting_plan_approval", intent: "汇集课程讲义、作业和样题，形成材料清单" });
  order("new2", "补做作业 2 第 5 题", { state: "awaiting_plan_approval" });
  order("new3", "整理 ECE 548 复习提纲", { state: "awaiting_plan_approval", intent: "在周末前整理前几章的复习提纲" });
  expect(existingTasksFor(store, ws).map((task) => task.id)).toEqual(expect.arrayContaining(["mat", "hw2"]));

  expect(foldNewTask(store, ws, "new1")).toMatchObject({ kind: "duplicate", keep: "mat" });
  expect(store.getWorkOrder(ws, "new1")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: "task.duplicate_prevented", entityId: "mat" })[0]?.payload).toMatchObject({ kind: "duplicate", source: "analysis",
    candidate: { id: "new1" } });

  // The model said it adds to 作业 2: folded, and the kept task is asked to take it into its steps.
  expect(foldNewTask(store, ws, "new2", "hw2")).toMatchObject({ kind: "extends", keep: "hw2" });
  expect(store.getWorkOrder(ws, "new2")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: "task.steps_replan_requested", entityId: "hw2" })[0]?.payload)
    .toMatchObject({ feedback: expect.stringContaining("补做作业 2 第 5 题") });

  // Near but not settled by the rules: created as usual, left to the daily merge.
  expect(foldNewTask(store, ws, "new3")).toBeUndefined();
  expect(store.getWorkOrder(ws, "new3")!.state).toBe("awaiting_plan_approval");
});

const backplanStep = (over: Record<string, unknown>) => ({ id: "s1", title: "汇集 ECE 548 复习材料", intent: "汇集课程讲义、作业和样题，形成材料目录", sourceQuote: "ECE 548 期中考试",
  rationale: "r", dependsOn: [], estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90 }, energy: "low", interruptible: true, family: "preparation",
  riskTier: "routine", evidence: "材料目录", acquires: "", produces: "", uses: [],
  completion: { mode: "self_evident", reason: "", why: "交付即完成", question: "", askAfterHours: 0 }, extendsTaskId: "", ...over });

test("the backplanner is shown the open tasks; what one already covers or adds to is not created, and the rest carry the model's completion", async () => {
  store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m2", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", title: "ECE 548 期中考试", status: "approved", version: 1 });
  order("mat", "汇集 ECE 548 复习材料", { intent: "汇集课程讲义、作业与样题，形成材料目录" });
  order("outline", "整理 ECE 548 第 1–3 章提纲", { intent: "整理第 1–3 章的复习提纲" });
  const answer = { steps: [
    backplanStep({}),
    backplanStep({ id: "s2", title: "补第 4 章提纲", intent: "在已有提纲里补上第 4 章", extendsTaskId: "outline" }),
    backplanStep({ id: "s3", title: "ECE 548 期中考试", intent: "参加期中考试", dependsOn: ["s1"],
      completion: { mode: "needs_assessment", reason: "result_pending", why: "成绩由老师评定", question: "", askAfterHours: 48 } })
  ], dateCandidates: [], blockers: [] };
  const runtime = fakeRuntime([JSON.stringify(answer)], "crossline:crossline-goal-backplanner");
  const result = await createGoalBackplanner(store, ws, "C:\\repo", () => runtime.rpc)("m2");
  expect(result.state).toBe("proposed");
  const created = store.listWorkOrders(ws).filter((item) => item.milestoneId === "m2");
  expect(created.map((item) => (item.payload as { title: string }).title)).toEqual(["ECE 548 期中考试"]);
  // The exam waits on the material task already there, and carries the backplanner's judgement.
  expect(created[0]!.payload).toMatchObject({ dependsOn: ["mat"], completion: { mode: "needs_assessment", reason: "result_pending", askAfterHours: 48 } });
  expect(store.listEvents(ws, { type: "task.duplicate_prevented" }).map((event) => [event.entityId, (event.payload as { kind: string }).kind]))
    .toEqual([["mat", "duplicate"], ["outline", "extends"]]);
  // The kept tasks serve this milestone too, so it is not split again for want of open work.
  expect((store.getWorkOrder(ws, "mat")!.payload as { alsoServes?: string[] }).alsoServes).toEqual(["m2"]);
});

test("a homework from the course's dates the person already has is not written twice; it gives that task its due day", () => {
  store = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece548", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 548", status: "active", summary: "", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  store.saveMilestone({ id: "m", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", title: "ECE 548 期末", status: "approved", version: 1 });
  order("typed", "完成 ECE 548 作业 2", { intent: "做完 ECE 548 作业 2" });
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "ece548", slot: "date_20261020_homework_due", value: "2026-10-20 作业 2 截止",
    status: "confirmed", sourceRef: "", sourceQuote: "", updatedAt: "2026-10-15T00:00:00.000Z" });
  const now = new Date("2026-10-15T12:00:00.000Z");
  expect(materializeDatePairs(store, ws, now)).toEqual([]);
  expect(store.listWorkOrders(ws).map((item) => item.id)).toEqual(["typed"]);
  expect(store.getWorkOrder(ws, "typed")!.payload).toMatchObject({ dueDate: "2026-10-20", datePair: { number: "2" } });
  expect(materializeDatePairs(store, ws, now)).toEqual([]);
  expect(store.listEvents(ws, { type: "task.duplicate_prevented" })).toHaveLength(1);
});

test("the backplanner does not write again what the person just finished (W-30)", async () => {
  store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m3", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "ece548", title: "试用门店上线", status: "approved", version: 1 });
  order("done", "核对5家试用门店的名单与联系人", { state: "accepted", milestoneId: "", intent: "核对5家试用门店的名单与联系人，补齐缺的电话" });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "accepted:done", type: "work_order.transitioned", entityId: "done",
    payload: { from: "active", to: "accepted" } });
  const answer = { steps: [
    backplanStep({ title: "整理5家试用门店清单", intent: "整理5家试用门店的名单与联系人", sourceQuote: "试用门店上线" }),
    backplanStep({ id: "s2", title: "给试用门店发上线通知", intent: "给每家试用门店写上线通知", sourceQuote: "试用门店上线", dependsOn: ["s1"] })
  ], dateCandidates: [], blockers: [] };
  const runtime = fakeRuntime([JSON.stringify(answer)], "crossline:crossline-goal-backplanner");
  expect((await createGoalBackplanner(store, ws, "C:\\repo", () => runtime.rpc)("m3")).state).toBe("proposed");
  const created = store.listWorkOrders(ws).filter((item) => item.milestoneId === "m3");
  expect(created.map((item) => (item.payload as { title: string }).title)).toEqual(["ECE 548 给试用门店发上线通知"]);
  expect(created[0]!.payload).toMatchObject({ dependsOn: ["done"] });
  expect(store.listEvents(ws, { type: "task.duplicate_prevented" })[0]?.payload).toMatchObject({ kind: "done", keep: "done" });
});
