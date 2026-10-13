import { expect, test } from "vitest";
import type { PlanningInput } from "./index";
import { scheduleInputHash } from "./input-hash";

const input = (over: Partial<PlanningInput> = {}): PlanningInput => ({
  now: new Date("2026-10-13T14:00:00.000Z"), horizonDays: 7,
  tasks: [{ id: "hw", title: "作业", estimate: { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, confidence: "high" }, inputsReady: true, deadlineTier: 2 }],
  availability: [{ day: "2026-10-13", start: "2026-10-13T14:00:00.000Z", end: "2026-10-13T18:00:00.000Z", energy: "high" }],
  frozenBlocks: [], ...over
});

test("only now changing keeps the hash; an estimate, a frozen block or the epoch changes it", () => {
  const base = scheduleInputHash(input(), "2026-10-13T14:00:00.000Z|high");
  expect(scheduleInputHash(input({ now: new Date("2026-10-13T14:20:00.000Z") }), "2026-10-13T14:00:00.000Z|high")).toBe(base);
  const longer = input();
  longer.tasks[0]!.estimate.p50Minutes = 75;
  expect(scheduleInputHash(longer, "2026-10-13T14:00:00.000Z|high")).not.toBe(base);
  expect(scheduleInputHash(input({ frozenBlocks: [{ taskId: "hw", start: "2026-10-13T15:00:00.000Z", end: "2026-10-13T15:30:00.000Z" }] }),
    "2026-10-13T14:00:00.000Z|high")).not.toBe(base);
  expect(scheduleInputHash(input(), "2026-10-13T18:00:00.000Z|high")).not.toBe(base);
});

test("key order does not matter", () => {
  const reordered = { frozenBlocks: [], availability: input().availability, tasks: input().tasks, horizonDays: 7, now: input().now } as PlanningInput;
  expect(scheduleInputHash(reordered, "e")).toBe(scheduleInputHash(input(), "e"));
});
