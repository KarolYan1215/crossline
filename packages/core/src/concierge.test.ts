import { expect, test } from "vitest";
import { ACTIONS, ACTION_IDS, CONCIERGE_SCHEMA, cardActionIndexes, keepUsable, structuredOutputProblems, validateConciergeTurn, type ConciergeRefs } from "./index";

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
