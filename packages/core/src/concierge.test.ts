import { expect, test } from "vitest";
import { ACTIONS, ACTION_IDS, actionProblem, CONCIERGE_SCHEMA, cardActionIndexes, keepUsable, structuredOutputProblems, validateConciergeTurn, type ConciergeRefs, answerFromPack, type ConciergePack } from "./index";

const refs = (): ConciergeRefs => ({
  tasks: new Map([["wo-1", new Set(["v1s1", "v1s2"])]]), asks: new Map([["wait:w1", new Set(["arrived", "cancelled"])]]),
  ops: new Set(["op-1"]), lines: new Set(["research"]), milestones: new Set(["m1", "m2"]), draftMilestones: new Set(["m2"]),
  proposals: new Set(["wo-2"]), agentResults: new Set(["agent-1"])
});
const op = (args: Record<string, unknown>) => ({ action: "task.op", summary: "改截止", args: { workOrderId: "wo-1", type: "due", date: "2026-10-16", minutes: 0, stepId: "", text: "", who: "", energy: "", ...args } });
const turn = (actions: unknown[], clarify = { question: "", options: [] as Array<{ label: string; actions: number[] }> }) => ({ reply: "", confidence: "high", actions, clarify });

test("the output schema is built from every registered action and passes the strict-mode rules", () => {
  expect(structuredOutputProblems(CONCIERGE_SCHEMA)).toEqual([]);
  const branches = (CONCIERGE_SCHEMA.properties.actions as { items: { anyOf: Array<{ properties: { action: { enum: string[] } } }> } }).items.anyOf;
  expect(branches.map((branch) => branch.properties.action.enum[0])).toEqual(ACTION_IDS);
  for (const id of ACTION_IDS) expect(ACTIONS[id].label.length).toBeGreaterThan(0);
});

test("an action naming something that does not exist is sent back with what to look up; a valid one passes", () => {
  expect(validateConciergeTurn(turn([op({})]), refs()).actions).toHaveLength(1);
  expect(() => validateConciergeTurn(turn([op({ workOrderId: "nope" })]), refs())).toThrow("CONCIERGE_ACTION_INVALID");
  try { validateConciergeTurn(turn([op({ type: "step_done", stepId: "v9s9" })]), refs()); } catch (error) {
    expect((error as { detail?: string }).detail).toContain("stepId 须是该任务的步骤");
  }
  const answer = { action: "ask.answer", summary: "到了", args: { askId: "wait:w1", optionId: "later", fields: [] } };
  expect(() => validateConciergeTurn(turn([answer]), refs())).toThrow("CONCIERGE_ACTION_INVALID");
  expect(() => validateConciergeTurn(turn([]), refs())).toThrow("CONCIERGE_EMPTY");
});

test("「撤销刚刚的不等了」 is an undo of a recent operation, never a new task", () => {
  const undo = { action: "undo", summary: "撤销「不等了」", args: { opId: "op-1" } };
  expect(validateConciergeTurn({ ...turn([undo]), reply: "撤销刚才的「不等了」" }, refs()).actions[0]).toMatchObject({ action: "undo" });
  expect(() => validateConciergeTurn(turn([{ ...undo, args: { opId: "op-9" } }]), refs())).toThrow("CONCIERGE_ACTION_INVALID");
});

test("clarify options name candidate actions; they are not cards of their own, and keepUsable renumbers them after dropping one", () => {
  const raw = turn([op({ workOrderId: "missing" }), op({}), { action: "note.add", summary: "记一笔", args: { text: "x" } }],
    { question: "是改截止还是只记一笔？", options: [{ label: "改截止", actions: [1] }, { label: "记一笔", actions: [2] }, { label: "都不是", actions: [] }] });
  const kept = keepUsable(raw, refs())!;
  expect(kept.actions.map((item) => item.action)).toEqual(["task.op", "note.add"]);
  expect(kept.clarify.options).toEqual([{ label: "改截止", actions: [0] }, { label: "记一笔", actions: [1] }, { label: "都不是", actions: [] }]);
  expect(cardActionIndexes(kept)).toEqual([]);
  expect(kept.reply).toContain("1 项");
});

test("an event on a day already past is sent back: 「周四」 on a Friday means the coming Thursday", () => {
  const event = { action: "event.create", summary: "与导师开会", args: { title: "与导师开会", date: "2026-10-08", weekdays: [], startTime: "15:00", endTime: "16:00",
    until: "", minutes: 60, lineId: "", location: "" } };
  expect(() => validateConciergeTurn(turn([event]), { ...refs(), today: "2026-10-09" })).toThrow("CONCIERGE_ACTION_INVALID");
  expect(validateConciergeTurn(turn([{ ...event, args: { ...event.args, date: "2026-10-15" } }]), { ...refs(), today: "2026-10-09" }).actions).toHaveLength(1);
});

test("a reminder every few hours is an automation, not a reminder once at a time of day", () => {
  const ask = (text: string, reminder: string, time: string) =>
    ({ action: "workflow.request", summary: "提醒", args: { text, lineId: "research", reminder, time, weekdays: [] } }) as never;
  expect(actionProblem(ask("每隔 1 小时提醒我喝一杯水", "喝水", "16:00"), refs())).toContain("每隔几小时");
  expect(actionProblem(ask("每两个小时提醒我起来走走", "走走", "09:00"), refs())).toContain("每隔几小时");
  expect(actionProblem(ask("每隔 1 小时提醒我喝一杯水", "", ""), refs())).toBe("");
  expect(actionProblem(ask("每天早上九点提醒我发笔记", "发笔记", "09:00"), refs())).toBe("");
});

test("修工作流 names one of the person's grown workflows and says what is wrong", () => {
  const fix = (workflowId: string, text: string) => ({ action: "workflow.fix", summary: "修", args: { workflowId, text } }) as never;
  const known = { ...refs(), workflows: new Set(["flow-media-xhs"]) };
  expect(actionProblem(fix("flow-media-xhs", "整理收藏又失败了"), known)).toBe("");
  expect(actionProblem(fix("flow-nope", "整理收藏又失败了"), known)).toContain("不存在");
  expect(actionProblem(fix("flow-media-xhs", " "), known)).toBe("内容为空");
});

test("find_system_part routes a wish to the part that owns it, with the person's note and its versions", () => {
  const pack = { designSkills: ["crossline-task-planner:steps", "crossline-onboarding"],
    designLabels: { "crossline-task-planner:steps": "步骤拆分", "crossline-onboarding": "访谈" },
    designNotes: [{ id: "crossline-task-planner:steps", text: "不要订正", paused: false, history: [{ at: "2026-11-18T00:00:00Z", text: "" }] }] } as unknown as ConciergePack;
  const hit = JSON.parse(answerFromPack(pack, "find_system_part", { query: "访谈" })) as Array<{ id: string; does: string }>;
  expect(hit.map((part) => part.id)).toEqual(["crossline-onboarding"]);
  expect(hit[0]!.does.length).toBeGreaterThan(10);
  const steps = JSON.parse(answerFromPack(pack, "find_system_part", { query: "订正" })) as Array<{ id: string; note?: string; history?: unknown[] }>;
  expect(steps).toMatchObject([{ id: "crossline-task-planner:steps", note: "不要订正", history: [{ text: "" }] }]);
  // Nothing matches: every part is listed, so the model can still route by reading.
  expect((JSON.parse(answerFromPack(pack, "find_system_part", { query: "zzz-nothing" })) as unknown[]).length).toBe(2);
});

test("「周四前」 is due Thursday, never Wednesday: a due day one day early is sent back (W-192)", () => {
  // 2026-11-03 is a Tuesday.
  const heard = { ...refs(), today: "2026-11-03", heard: "周四前写完作业 3 的前两题" };
  const create = (dueDate: string) => ({ action: "task.create", summary: "作业 3 前两题", args: { title: "写完作业 3 的前两题", context: "", lineId: "", dueDate, milestoneId: "" } });
  expect(actionProblem(create("2026-11-04") as never, heard)).toContain("2026-11-05");
  expect(() => validateConciergeTurn(turn([create("2026-11-04")]), heard)).toThrow("CONCIERGE_ACTION_INVALID");
  expect(validateConciergeTurn(turn([create("2026-11-05")]), heard).actions).toHaveLength(1);
  // A task's due day moved: the same.
  expect(actionProblem(op({ date: "2026-11-04" }) as never, heard)).toContain("2026-11-05");
  expect(actionProblem(op({ date: "2026-11-05" }) as never, heard)).toBe("");
  // 「下周四之前」 and "by Thursday" too; with no such words, any day stands.
  expect(actionProblem(create("2026-11-11") as never, { ...heard, heard: "下周四之前交" })).toContain("2026-11-12");
  expect(actionProblem(create("2026-11-04") as never, { ...heard, heard: "finish it by Thursday" })).toContain("2026-11-05");
  expect(actionProblem(create("2026-11-04") as never, { ...heard, heard: "周三交" })).toBe("");
});
