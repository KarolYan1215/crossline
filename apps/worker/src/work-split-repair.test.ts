import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { onPersonsBoard } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { WORK_SPLIT_REPAIR_MARKER, planWorkSplit, workSplitMessage, workSplitRepair } from "./work-split-repair";

/** The one-time reorganisation of the board into the person's core work, the assistant's preparation and questions (docs/work-split.md §5). */
let store: CrosslineStore;
let ws: string;
let owner: string;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const now = new Date("2026-10-22T15:00:00.000Z");

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "w");
  ws = created.workspace.id; owner = created.principal.id;
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "UTC", mode: "buffered", importance: {} }));
});
afterEach(() => store.close());

const milestone = (id: string, identityId: string, projectId: string, deadline: string, criteria: string[] = ["期中成绩 ≥ 88/100"]) => {
  store.saveMilestone({ id, ownerId: owner, workspaceId: ws, identityId, projectId, title: id, status: "approved", version: 1,
    successCriteria: criteria.map((statement, index) => ({ id: `${id}-c${index}`, statement, measure: { kind: "artifact" } })) as never });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: id, stage: 1, deadline, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
};
const order = (id: string, intent: string, milestoneId: string, extra: { state?: string; identityId?: string; projectId?: string; payload?: Record<string, unknown> } = {}) =>
  store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: extra.identityId ?? "research", projectId: extra.projectId ?? "ece548", milestoneId, intent,
    state: (extra.state ?? "approved") as never, riskTier: "routine", estimate, payload: { title: intent, ...(extra.payload ?? {}) } });

function board() {
  // Research: a course whose open work is all compiling, plus the person's revision plan.
  milestone("mid", "research", "ece548", "2026-11-05");
  order("rules", "汇集 ECE 548 期中考试规则与往年卷", "mid");
  order("scores", "整理 ECE 548 本学期已出成绩", "mid");
  order("plan", "根据已汇集的规则和往年卷规划期中复习", "mid", { payload: { dependsOn: ["rules"] } });
  order("timed", "整理 ECE 548 讲义目录", "mid");
  store.openSession(ws, "timed", owner, "2026-10-20T09:00:00.000Z");
  // Startup: a milestone whose only open work is gathering.
  milestone("pilot", "startup", "shops", "2026-11-20", ["至少 3 家店长表示愿意继续试用"]);
  order("contacts", "收集 5 家门店的联系方式与营业时间", "pilot", { identityId: "startup", projectId: "shops" });
  // Media: a preparation-only milestone with no milestone of the person's after it in its project.
  milestone("pack", "media", "xhs", "2026-11-01", ["素材样本包已取得", "20 条收藏笔记的开头句式已汇总"]);
  order("samples", "汇总 20 条收藏笔记的开头句式", "pack", { identityId: "media", projectId: "xhs" });
  // A preparation-only milestone of a course whose next milestone has a result of the person's.
  milestone("gap", "research", "ece555", "2026-10-30", ["ECE 555 考核缺口已可按 A- 分数线识别"]);
  milestone("final", "research", "ece555", "2026-12-10", ["期末成绩 ≥ 90"]);
  order("gaplist", "形成 ECE 555 各计分组成的当前成绩与待定状态清单", "gap", { projectId: "ece555" });
  // Untouched: under way, with an owner already, accepted.
  order("doing", "汇集期末往年卷", "final", { state: "active", projectId: "ece555" });
  order("owned", "汇集 ECE 555 课程讲义", "final", { projectId: "ece555", payload: { owner: "assistant", prepares: "" } });
  order("done", "整理 ECE 548 作业要求", "mid", { state: "accepted" });
}

test("the reading: compiling goes to the assistant pointed at the core task it prepares, what needs the person's data becomes a question", () => {
  board();
  const plan = planWorkSplit(store, ws, now);
  const moves = Object.fromEntries(plan.moves.map((move) => [move.order.id, [move.owner, move.prepares]]));
  expect(moves).toMatchObject({ rules: ["assistant", "plan"], scores: ["ask", "plan"], contacts: ["assistant", ""], samples: ["assistant", ""],
    // The real ledger's chore (2026-10-22): the current grades are the person's to hand over.
    gaplist: ["ask", ""] });
  expect(plan.person.map((item) => item.order.id)).toContain("plan");
  expect(plan.untouched.map((item) => item.order.id)).toContain("doing");
  expect(plan.moves.some((move) => ["owned", "done", "doing"].includes(move.order.id))).toBe(false);
  expect(Object.fromEntries(plan.prepOnly.map((item) => [item.id, item.next?.id ?? ""]))).toEqual({ pack: "", gap: "final" });
  // The startup milestone lost its only (gathering) work; the course's next milestone carries the gap milestone; the plan keeps the midterm.
  expect(plan.backplan.map((item) => item.id).sort()).toEqual(["final", "pilot"]);
});

test("the reorganisation: payloads rewritten once, merges run, backplans requested, one message with an undo of the previous payloads", async () => {
  board();
  const merge = vi.fn(async () => 1);
  const outcome = (await workSplitRepair(store, ws, { now, mergeNow: merge }))!;
  expect(outcome).toMatchObject({ assistant: 3, ask: 2, merged: 1 });
  expect(merge).toHaveBeenCalledOnce();
  const get = (id: string) => store.listWorkOrders(ws).find((item) => item.id === id)!;
  expect(onPersonsBoard(get("rules"))).toBe(false);
  expect(get("rules").payload).toMatchObject({ owner: "assistant", prepares: "plan", reorganized: WORK_SPLIT_REPAIR_MARKER });
  expect(get("scores").payload).toMatchObject({ owner: "ask", prepares: "plan", question: expect.stringContaining("成绩") });
  expect(onPersonsBoard(get("plan"))).toBe(true);
  expect(get("rules").state).toBe("approved");
  const reruns = store.listEvents(ws, { type: "goal.backplan_rerun_requested" }).map((event) => event.entityId).sort();
  expect(reruns).toEqual(["final", "pilot"]);
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!.payload as { bySystem: boolean; inverse: { kind: string; entries: Array<{ id: string; payload: unknown; state: string }> } };
  expect(op).toMatchObject({ bySystem: true, inverse: { kind: "work_order.payload" } });
  expect(op.inverse.entries.find((entry) => entry.id === "rules")).toMatchObject({ payload: { title: "汇集 ECE 548 期中考试规则与往年卷" }, state: "approved" });
  const message = store.listConversationMessages(ws, store.conversationFor(ws, "2026-10-22").id).at(-1)!;
  const card = message.payload.card as { clarify: { question: string; options: Array<{ label: string; href?: string }> }; actions: Array<{ action: string; args: { opId?: string } }> };
  expect(card.clarify.question).toContain("3 项收集、整理类的准备转给助手做");
  expect(card.clarify.question).toContain("「pack」只是准备");
  expect(card.actions[0]).toMatchObject({ action: "undo", args: { opId: outcome.opId } });
  expect(card.clarify.options.some((option) => option.href === "/milestones?open=pack")).toBe(true);
  // Once.
  expect(await workSplitRepair(store, ws, { now, mergeNow: merge })).toBeUndefined();
});

const steps = (orderId: string, list: Array<[string, "human" | "agent", ("done" | "planned")?]>) => {
  store.saveStepPlan(ws, orderId, { archetypeId: "problem_set", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", units: [], questions: [],
    steps: list.map(([title, executor], index) => ({ id: `s${index + 1}`, role: "do", title, deliverable: "", doneCriterion: "完成", share: 1 / list.length,
      estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 }, dependsOn: index ? [`s${index}`] : [], notBefore: "", dueBy: "", schedulable: executor === "human",
      executor, tickOutcome: "", firstAction: executor === "human" ? "打开讲义" : "" })) }, owner, "t");
  const plan = store.getStepPlan(ws, orderId)!;
  list.forEach(([, executor, status], index) => {
    if (status === "done") store.updateStepProgress(ws, orderId, plan.steps[index]!.id, { status: "done" }, owner, executor === "agent" ? "agent" : "user");
  });
};

test("progress the assistant made is no reason to leave a chore with the person; progress the person made is, and its open steps are judged again", () => {
  milestone("mid", "research", "ece548", "2026-11-05");
  // Only the assistant's step is done: still a chore, moved, and what was done goes with it.
  order("hw-list", "整理 ECE 548 作业清单", "mid");
  steps("hw-list", [["汇总讲义里的作业要求", "agent", "done"], ["核对作业截止日", "human"]]);
  // The person ticked a step themselves: theirs as a whole; its compiling step moves to the assistant.
  order("papers", "汇集当前论文材料", "mid");
  steps("papers", [["读第一篇论文的方法部分", "human", "done"], ["下载其余三篇论文", "human"]]);
  const plan = planWorkSplit(store, ws, now);
  expect(plan.moves.find((move) => move.order.id === "hw-list")).toMatchObject({ owner: "assistant", priorWork: { done: ["汇总讲义里的作业要求"] } });
  expect(plan.untouched.find((item) => item.order.id === "papers")?.why).toBe("本人做过其中的步骤");
  expect(plan.steps.find((split) => split.order.id === "papers")?.changes).toEqual([expect.objectContaining({ title: "下载其余三篇论文", from: "human", to: "agent" })]);
});

test("the open steps of the person's task are judged again: chores to the assistant, the person's data a question, a review folded; all chores moves the task", async () => {
  milestone("mid", "research", "ece548", "2026-11-05");
  order("plan", "根据已汇集的规则和往年卷规划期中复习", "mid");
  steps("plan", [["形成 ECE 548 各计分组成的当前成绩与待定状态清单", "human"], ["核对助手整理的规则清单", "human"], ["按规则规划每天的复习题量", "human"]]);
  order("prep", "准备 ECE 548 期中复习", "mid");
  steps("prep", [["下载往年卷", "human"], ["汇总往年卷题型", "human"]]);
  const reading = planWorkSplit(store, ws, now);
  const split = reading.steps.find((item) => item.order.id === "plan")!;
  expect(split.changes.map((change) => [change.title, change.from, change.to])).toEqual([
    ["核对助手整理的规则清单", "human", "folded"], ["形成 ECE 548 各计分组成的当前成绩与待定状态清单", "human", "agent"]]);
  expect(split.questions.map((question) => question.text)).toEqual([expect.stringContaining("当前成绩")]);
  expect(reading.moves.find((move) => move.order.id === "prep")).toMatchObject({ owner: "assistant", code: "steps" });
  const outcome = (await workSplitRepair(store, ws, { now }))!;
  expect(outcome).toMatchObject({ steps: 2, tasksWithSteps: 1 });
  const stored = store.getStepPlan(ws, "plan")!;
  expect(stored.steps.map((step) => [step.title, step.executor, step.schedulable])).toEqual([
    ["形成 ECE 548 各计分组成的当前成绩与待定状态清单", "agent", false], ["按规则规划每天的复习题量", "human", true]]);
  expect(stored.steps[1]!.firstAction).toMatch(/^先用 10 分钟扫一眼/);
  expect(stored.questions).toHaveLength(1);
  const op = store.listEvents(ws, { type: "op.applied" }).at(-1)!.payload as { inverse: { kind: string; items: Array<{ kind: string; plans?: Array<{ workOrderId: string; plan: { steps: unknown[] } }> }> } };
  expect(op.inverse.kind).toBe("batch");
  expect(op.inverse.items.find((item) => item.kind === "step_plan.restore")!.plans![0]).toMatchObject({ workOrderId: "plan", plan: { steps: [{}, {}, {}] } });
});

test("nothing to reorganise: marked, no message", async () => {
  milestone("mid", "research", "ece548", "2026-11-05");
  order("plan", "规划期中复习", "mid");
  const outcome = (await workSplitRepair(store, ws, { now }))!;
  expect(outcome).toMatchObject({ assistant: 0, ask: 0, merged: 0, backplan: [] });
  expect(store.getSetting(ws, WORK_SPLIT_REPAIR_MARKER)).toBeTruthy();
  expect(workSplitMessage({ assistant: 0, ask: 0, merged: 0, backplan: [], lonely: [] })).toBe("");
});
