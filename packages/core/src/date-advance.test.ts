import { expect, test } from "vitest";
import { advanceResults, conservativeFinish, overdueTarget, sameWork, shiftWithChain, supersededResults, type AdvanceResultRow } from "./date-advance";

const row = (taskId: string, over: Partial<AdvanceResultRow> = {}): AdvanceResultRow => ({ taskId, workOrderId: "o1", stepId: "", title: `任务 · ${taskId}`,
  requestedAt: "2026-10-01T10:00:00Z", status: "needs_review", completedAt: "2026-10-01T11:00:00Z", checksPassed: true, inputsModified: [], external: false,
  partial: false, orderGone: false, ...over });

test("the same work is the same order and step, or the same deliverable after a replan; an empty step part never matches", () => {
  expect(sameWork(row("a", { stepId: "v1s4" }), row("b", { stepId: "v1s4", title: "别的说法" }))).toBe(true);
  expect(sameWork(row("a", { stepId: "v1s2", title: "任务 · 盘点文件" }), row("b", { stepId: "v2s2", title: "任务 · 盘点文件。" }))).toBe(true);
  // 「任务 · 」 with no step part: six different steps of one task were all read as one.
  expect(sameWork(row("a", { stepId: "v1s4", title: "任务 · " }), row("b", { stepId: "v1s5", title: "任务 · " }))).toBe(false);
  expect(sameWork(row("a", { stepId: "v1s4" }), row("b", { stepId: "v1s4", workOrderId: "o2" }))).toBe(false);
});

test("an older result is replaced by the newest finished run of the same work, accepted or waiting", () => {
  const replaced = supersededResults([
    row("old", { stepId: "v1s1", requestedAt: "2026-10-01T00:00:00Z" }),
    row("mid", { stepId: "v1s1", requestedAt: "2026-10-05T00:00:00Z" }),
    row("new", { stepId: "v1s1", requestedAt: "2026-10-09T00:00:00Z", status: "accepted" }),
    row("blocked", { stepId: "v1s1", requestedAt: "2026-10-10T00:00:00Z", status: "blocked" }),
    row("other", { stepId: "v1s2", title: "任务 · 另一步", requestedAt: "2026-10-02T00:00:00Z" })
  ]);
  expect(Object.fromEntries(replaced)).toEqual({ old: "new", mid: "new" });
});

test("a day unreviewed: a clean result is adopted; two weeks: any other is put away; finished work and settled ones are left alone", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const moves = advanceResults([
    row("clean-old", { stepId: "s1", completedAt: "2026-10-13T11:00:00Z" }),
    row("clean-young", { stepId: "s2", completedAt: "2026-10-21T02:00:00Z" }),
    row("failed-old", { stepId: "s3", checksPassed: false, completedAt: "2026-10-06T11:00:00Z" }),
    row("failed-mid", { stepId: "s4", checksPassed: false, completedAt: "2026-10-10T11:00:00Z" }),
    row("external", { stepId: "s5", external: true, completedAt: "2026-10-01T11:00:00Z" }),
    row("changed", { stepId: "s6", inputsModified: ["a.pdf"], completedAt: "2026-10-12T11:00:00Z" }),
    row("grow-x", { workOrderId: "", stepId: "", title: "长出工作流", completedAt: "2026-10-01T11:00:00Z" }),
    row("gone", { stepId: "s7", orderGone: true, completedAt: "2026-10-01T11:00:00Z" }),
    row("settled", { stepId: "s8", settled: "expired", completedAt: "2026-10-01T11:00:00Z" }),
    row("replaced", { stepId: "s1", requestedAt: "2026-09-30T00:00:00Z", completedAt: "2026-09-30T01:00:00Z" })
  ], now);
  expect(moves).toEqual([
    { taskId: "clean-old", action: "adopt" },
    { taskId: "failed-old", action: "expire" },
    { taskId: "external", action: "expire" },
    { taskId: "grow-x", action: "expire" },
    { taskId: "replaced", action: "supersede", by: "clean-old" }
  ]);
});

test("milestones move with their chain: a later one of the same line and project that would come first goes by the same days", () => {
  const approved = [
    { id: "pack", line: "media", project: "xhs", deadline: "2026-10-17" },
    { id: "feedback", line: "media", project: "xhs", deadline: "2026-10-24" },
    { id: "launch", line: "media", project: "xhs", deadline: "2026-11-20" },
    { id: "other", line: "media", project: "blog", deadline: "2026-10-22" }
  ];
  expect(Object.fromEntries(shiftWithChain(approved, [{ id: "pack", to: "2026-10-30", days: 13 }]))).toEqual({ pack: "2026-10-30", feedback: "2026-11-06" });
});

test("an overdue milestone goes to its cautious finish plus the margin, never sooner than three days out", () => {
  expect(conservativeFinish("2026-10-21", 600, 240)).toBe("2026-10-24");
  expect(overdueTarget({ today: "2026-10-21", finish: "2026-10-28", marginDays: 2 })).toBe("2026-10-30");
  expect(overdueTarget({ today: "2026-10-21", finish: "2026-10-21", marginDays: 2 })).toBe("2026-10-24");
});
