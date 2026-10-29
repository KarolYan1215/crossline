import { expect, test } from "vitest";
import { lineHealth } from "./line-health";

const item = (over: Record<string, unknown>) => ({ identityId: "research", status: "approved" as const, risks: [], ...over }) as Parameters<typeof lineHealth>[0][number];

test("a line's health: at risk when the schedule cannot finish one in time or the reviewer rates it high; attention for medium or nothing ready", () => {
  expect(lineHealth([item({}), item({ planStates: [] })], "research")).toMatchObject({ level: "ok", open: 2, reached: 0, total: 2 });
  expect(lineHealth([item({ planStates: ["risk"] }), item({ risks: [{ level: "medium", kind: "time", note: "" }] })], "research"))
    .toMatchObject({ level: "risk", risky: 1, watch: 1 });
  expect(lineHealth([item({ risks: [{ level: "high", kind: "capacity", note: "" }] })], "research")?.level).toBe("risk");
  expect(lineHealth([item({ planStates: ["unprepared"] })], "research")?.level).toBe("watch");
  // A reached milestone counts towards progress, never towards risk.
  expect(lineHealth([item({ planStates: ["risk"], retrospective: {} }), item({})], "research")).toMatchObject({ level: "ok", reached: 1, total: 2 });
  // Drafts alone, or another line's milestones: nothing to judge.
  expect(lineHealth([item({ status: "draft", planStates: ["risk"] }), item({ identityId: "media" })], "research")).toBeNull();
});
