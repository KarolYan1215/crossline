import { expect, test } from "vitest";
import { durationPriorFor } from "./estimate-calibration";

// The per-kind average that replaced a task's own estimate is gone (see `workspaceCalibration` in crossline.ts and
// packages/core/src/calibration.ts); what remains here is the static prior frozen beside each observation.
test("durationPriorFor resolves the identity pack's static prior from the WorkOrder's own family tag", () => {
  expect(durationPriorFor("research", { family: "deep_work" })).toEqual({ p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 });
  expect(durationPriorFor("research", { family: "review" })).toEqual({ p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 });
});

test("durationPriorFor is undefined for a pre-family WorkOrder or an identity with no pack", () => {
  expect(durationPriorFor("research", {})).toBeUndefined();
  expect(durationPriorFor("research", undefined)).toBeUndefined();
  expect(durationPriorFor("no-such-identity", { family: "deep_work" })).toBeUndefined();
});
