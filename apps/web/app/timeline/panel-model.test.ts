import { describe, expect, test } from "vitest";
import { itemsFromPlan, withAgentMarks, type TimelineItem } from "./model";
import { agentStepFor, dayLoad, followingBlock, nextBlock, stepOfBlock } from "./panel-model";

const item = (id: string, over: Partial<TimelineItem>): TimelineItem =>
  ({ id, title: id, day: "2026-10-12", start: "09:00", end: "10:00", kind: "scheduled", source: "排程", readOnly: false, ...over });

describe("the day panel", () => {
  const items = [
    item("scheduled:wo-1:v1s1", { workOrderId: "wo-1", stepId: "v1s1", start: "09:00", end: "10:30" }),
    item("scheduled:wo-1:v1s2", { workOrderId: "wo-1", stepId: "v1s2", day: "2026-10-14", start: "14:00", end: "15:00" }),
    item("optional:wo-2:v1s1", { kind: "optional", workOrderId: "wo-2", stepId: "v1s1", start: "21:00", end: "22:00" }),
    item("graph_calendar:a", { kind: "calendar", start: "11:00", end: "12:00" }),
    item("import:b:1", { kind: "import", start: "13:00", end: "13:30" })
  ];

  test("the load on top counts scheduled, pencilled and fixed minutes of that day only", () => {
    expect(dayLoad(items, "2026-10-12")).toEqual({ planned: 90, pencilled: 60, fixed: 90, allDay: [] });
    expect(dayLoad(items, "2026-10-14")).toEqual({ planned: 60, pencilled: 0, fixed: 0, allDay: [] });
  });

  test("rest is not fixed schedule: an evening 「休息」 and lunch keep work off but are not counted (W-156)", () => {
    const day = [
      item("event:rest", { kind: "calendar", title: "休息", day: "2026-10-29", start: "21:00", end: "23:59" }),
      item("graph_calendar:lunch", { kind: "calendar", title: "Lunch", day: "2026-10-29", start: "12:00", end: "13:00" }),
      item("graph_calendar:class", { kind: "calendar", title: "ECE 548", day: "2026-10-29", start: "13:00", end: "14:15" }),
      item("graph_calendar:seminar", { kind: "calendar", title: "Lunch seminar", day: "2026-10-29", start: "14:15", end: "15:00" })
    ];
    expect(dayLoad(day, "2026-10-29")).toEqual({ planned: 0, pencilled: 0, fixed: 120, allDay: [] });
  });

  test("an all-day item names the day instead of filling it, and overlapping fixed items count once (W-25)", () => {
    const sunday = [
      item("event:rest", { kind: "calendar", title: "周日休息", day: "2026-10-18", start: "00:00", end: "23:59" }),
      item("graph_calendar:x", { kind: "calendar", day: "2026-10-18", start: "10:00", end: "11:00" }),
      item("import:y:1", { kind: "import", day: "2026-10-18", start: "10:30", end: "11:30" })
    ];
    expect(dayLoad(sunday, "2026-10-18")).toEqual({ planned: 0, pencilled: 0, fixed: 90, allDay: ["周日休息"] });
  });

  test("with nothing picked, the next block of work that has not ended; on another day, its first", () => {
    expect(nextBlock(items, "2026-10-12", "2026-10-12", 9 * 60 + 30)?.id).toBe("scheduled:wo-1:v1s1");
    expect(nextBlock(items, "2026-10-12", "2026-10-12", 11 * 60)?.id).toBe("optional:wo-2:v1s1");
    expect(nextBlock(items, "2026-10-12", "2026-10-12", 23 * 60)).toBeUndefined();
    expect(nextBlock(items, "2026-10-14", "2026-10-12", 23 * 60)?.id).toBe("scheduled:wo-1:v1s2");
  });

  test("a picked block shows its task's next block, on a later day if need be; a calendar event has none", () => {
    expect(followingBlock(items, items[0]!)?.id).toBe("scheduled:wo-1:v1s2");
    expect(followingBlock(items, items[1]!)).toBeUndefined();
    expect(followingBlock(items, items[3]!)).toBeUndefined();
  });

  const steps = [
    { id: "v1s1", status: "done", schedulable: true, executor: "human" },
    { id: "v1s2", status: "planned", schedulable: true, executor: "mixed" },
    { id: "v1s3", status: "planned", schedulable: true, executor: "human" },
    { id: "v1s4", status: "planned", schedulable: false, executor: "agent" }
  ];
  test("交给 Agent appears for a block whose own step the system can do, or a whole-task block with such a step", () => {
    expect(agentStepFor(item("x", { stepId: "v1s2" }), steps)).toBe("v1s2");
    expect(agentStepFor(item("x", { stepId: "v1s3" }), steps)).toBeUndefined();
    expect(agentStepFor(item("x", {}), steps)).toBe("v1s2");
  });

  test("the step shown is the block's own, else the task's current one", () => {
    expect(stepOfBlock(item("x", { stepId: "v1s3" }), steps)?.id).toBe("v1s3");
    expect(stepOfBlock(item("x", {}), steps)?.id).toBe("v1s2");
  });
});

describe("blocks and the assistant", () => {
  test("a block for one step carries the step's id; a whole-task block and a calendar event do not", () => {
    const [step, whole, event] = itemsFromPlan([
      { id: "scheduled:wo-1:v2s3:1", lane: "human", title: "t", day: "2026-10-12", start: "09:00", end: "10:00", source: "排程", readOnly: false },
      { id: "scheduled:wo-2:0", lane: "human", title: "t", day: "2026-10-12", start: "10:00", end: "11:00", source: "排程", readOnly: false },
      { id: "graph_calendar:x", lane: "human", title: "组会", day: "2026-10-12", start: "12:00", end: "13:00", source: "日历", readOnly: true }
    ], "2026-10-12", { "wo-1": { identityId: "research" }, "wo-2": { identityId: "media" } });
    expect(step).toMatchObject({ workOrderId: "wo-1", stepId: "v2s3" });
    expect(whole!.stepId).toBeUndefined();
    expect(event!.workOrderId).toBeUndefined();
  });

  test("「Agent 执行中」 for a step it is at work on (or a whole task), 「Agent 将执行」 for one it will start; events are never marked", () => {
    const marked = withAgentMarks([
      item("a", { workOrderId: "wo-1", stepId: "v1s1" }), item("b", { workOrderId: "wo-1", stepId: "v1s2" }), item("c", { workOrderId: "wo-2" }),
      item("d", { workOrderId: "wo-3", stepId: "v1s1", kind: "optional" }), item("e", { kind: "calendar" })
    ], { running: new Set(["wo-1#v1s1", "wo-2"]), planned: new Set(["wo-1#v1s2", "wo-3#v1s1"]) });
    expect(marked.map((entry) => entry.agent)).toEqual(["running", "planned", "running", "planned", undefined]);
  });
});
