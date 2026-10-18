import { expect, test } from "vitest";
import { addChurn, churnPerDay, planChanges, type PlanSnapshot } from "./plan-churn";

const snapshot = (at: string, starts: Record<string, string>): PlanSnapshot => ({ at, until: "2026-10-25T00:00:00.000Z", starts });

test("a block that moved, and work still to do that lost its time, count; new work, finished work and the past do not", () => {
  const before = snapshot("2026-10-18T10:00:00.000Z", {
    "a#v1s1": "2026-10-18T14:00:00.000Z", // moves two hours
    "b#v1s1": "2026-10-18T15:00:00.000Z", // moves five minutes: the same block
    "c": "2026-10-19T09:00:00.000Z", // gone, still to do
    "d": "2026-10-19T10:00:00.000Z", // gone, finished
    "e": "2026-10-18T10:05:00.000Z" // started before the next reading
  });
  const after = snapshot("2026-10-18T10:10:00.000Z", {
    "a#v1s1": "2026-10-18T16:00:00.000Z", "b#v1s1": "2026-10-18T15:05:00.000Z", "new": "2026-10-18T17:00:00.000Z"
  });
  expect(planChanges(before, after, (key) => key !== "d")).toEqual({ moved: ["a#v1s1"], dropped: ["c"] });
  expect(planChanges(undefined, after, () => true)).toEqual({ moved: [], dropped: [] });
});

test("a day counts each piece of work once, however often it moved, and the average is per recorded day", () => {
  const day = addChurn(addChurn(undefined, { moved: ["a"], dropped: [] }), { moved: ["a", "b"], dropped: ["c"] });
  expect(day).toEqual({ moved: ["a", "b"], dropped: ["c"], readings: 2 });
  expect(churnPerDay([day, { moved: [], dropped: [], readings: 5 }])).toBe(1.5);
  expect(churnPerDay([])).toBeNull();
});
