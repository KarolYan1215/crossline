import { expect, test } from "vitest";
import { stepsNeedingFinerSplit, type StepTrouble } from "./index";

const trouble = (kind: StepTrouble["kind"], stepId: string, day: string, orderId = "hw3"): StepTrouble => ({ kind, orderId, stepId, day });
const plans = [{ orderId: "hw3", version: 2, openStepIds: ["v2s1", "v2s2", "v2s3"] }];
const now = "2026-10-14T15:00:00.000Z";

test("a step that failed on two days is split again; two kinds of failure on one day count once", () => {
  expect(stepsNeedingFinerSplit([trouble("not_started", "v2s2", "2026-10-12"), trouble("not_done", "v2s2", "2026-10-12")], { plans, asked: [], now })).toEqual([]);
  expect(stepsNeedingFinerSplit([trouble("not_started", "v2s2", "2026-10-12"), trouble("overrun", "v2s2", "2026-10-13")], { plans, asked: [], now }))
    .toEqual([{ orderId: "hw3", stepId: "v2s2", version: 2, days: ["2026-10-12", "2026-10-13"] }]);
});

test("one split per task, the step with the most days first, and not for a step no longer open", () => {
  const events = [trouble("missed", "v2s3", "2026-10-10"), trouble("missed", "v2s3", "2026-10-11"), trouble("not_done", "v2s3", "2026-10-12"),
    trouble("not_done", "v2s1", "2026-10-11"), trouble("not_done", "v2s1", "2026-10-12"),
    trouble("not_done", "v1s4", "2026-10-08"), trouble("not_done", "v1s4", "2026-10-09")];
  expect(stepsNeedingFinerSplit(events, { plans, asked: [], now }).map((item) => item.stepId)).toEqual(["v2s3"]);
});

test("once per step per plan version, and once per task per week", () => {
  const events = [trouble("not_done", "v2s1", "2026-10-12"), trouble("not_done", "v2s1", "2026-10-13"), trouble("not_done", "v2s2", "2026-10-12"),
    trouble("not_done", "v2s2", "2026-10-13")];
  // Asked a week and a day ago for v2s1 of this version: v2s1 is not asked again, v2s2 is.
  expect(stepsNeedingFinerSplit(events, { plans, asked: [{ orderId: "hw3", stepId: "v2s1", version: 2, at: "2026-10-06T12:00:00.000Z" }], now })
    .map((item) => item.stepId)).toEqual(["v2s2"]);
  // Asked three days ago for another step: nothing this week.
  expect(stepsNeedingFinerSplit(events, { plans, asked: [{ orderId: "hw3", stepId: "v1s4", version: 1, at: "2026-10-11T12:00:00.000Z" }], now })).toEqual([]);
});
