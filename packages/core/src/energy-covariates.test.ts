import { expect, test } from "vitest";
import { DEFAULT_CALIBRATION } from "./energy-model";
import { covariateShift, fitCovariate, judgeCovariate, type CovariateSample } from "./energy-covariates";

const at = (index: number) => new Date(Date.parse("2026-10-01T15:00:00Z") + index * 3_600_000).toISOString();
// The model always reads 11 (medium); the person is low whenever the covariate is high, high when it is low.
const telling = (count: number): CovariateSample[] => Array.from({ length: count }, (_, index) => {
  const value = index % 3 === 0 ? 10 : index % 3 === 1 ? 0 : 5;
  return { at: at(index), alertness: 11, value, level: value === 10 ? "low" : value === 0 ? "high" : "medium" };
});

test("a covariate that tells the person's level apart is fitted with the right sign and switched on after the backtest", () => {
  const fit = fitCovariate(telling(30), DEFAULT_CALIBRATION)!;
  expect(fit.beta).toBeLessThan(0);
  expect(covariateShift(fit, 10)).toBeLessThan(covariateShift(fit, 0));
  const verdict = judgeCovariate("input", telling(30), DEFAULT_CALIBRATION);
  expect(verdict.enabled).toBe(true);
  expect(verdict.hitsWith).toBeGreaterThan(verdict.hitsWithout);
});

test("noise is never switched on, few reports are never enough, and an unmeasured moment shifts nothing", () => {
  const noise: CovariateSample[] = Array.from({ length: 30 }, (_, index) => ({ at: at(index), alertness: 11, value: (index * 7919) % 13,
    level: (["low", "medium", "high"] as const)[(index * 31) % 3]! }));
  expect(judgeCovariate("camera", noise, DEFAULT_CALIBRATION).enabled).toBe(false);
  expect(judgeCovariate("input", telling(6), DEFAULT_CALIBRATION).enabled).toBe(false);
  expect(covariateShift(fitCovariate(telling(30), DEFAULT_CALIBRATION)!, undefined)).toBe(0);
});
