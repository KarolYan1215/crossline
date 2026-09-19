import { expect, test } from "vitest";
import { energyCalibration, predictEnergyTransition, type TransitionOutcome } from "./energy-learning";

test("an explainable transition stays on the simple rule until enough personal outcomes exist", () => {
  expect(predictEnergyTransition("medium", "high", [])).toMatchObject({ predicted: "low", basis: "rule" });
  const outcomes: TransitionOutcome[] = Array.from({ length: 5 }, () => ({ before: "medium",
    taskEnergy: "high", predicted: "low", baseline: "medium", actual: "medium" }));
  expect(predictEnergyTransition("medium", "high", outcomes)).toMatchObject({
    predicted: "medium", basis: "personal_unvalidated" });
});

test("personal calibration requires at least 20 prospective outcomes and beats the stay-same baseline", () => {
  const good: TransitionOutcome[] = Array.from({ length: 20 }, () => ({ before: "high",
    taskEnergy: "high", predicted: "medium", baseline: "high", actual: "medium" }));
  expect(energyCalibration(good.slice(0, 19)).status).toBe("personal_unvalidated");
  expect(energyCalibration(good).status).toBe("personal_calibrated");
  const tied = good.map((item) => ({ ...item, baseline: "medium" as const }));
  expect(energyCalibration(tied).status).toBe("personal_unvalidated");
});
