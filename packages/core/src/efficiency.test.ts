import { expect, test } from "vitest";
import { ASSUMED_EFFICIENCY, backtestEfficiency, fitEfficiency, learnedEfficiency, type EfficiencySample } from "./efficiency";

// A person who works at the planned pace in matching slots and at half pace one level short (slower than the assumed 0.8).
const history = (count: number): EfficiencySample[] => Array.from({ length: count }, (_, index) => {
  const at = new Date(Date.parse("2026-09-01T15:00:00Z") + index * 86_400_000).toISOString();
  return index % 2
    ? { at, slot: "medium", need: "high", planned: 0.8, blockMinutes: 60, minutes: 96 }   // 48 minutes of work took 96
    : { at, slot: "high", need: "high", planned: 1, blockMinutes: 60, minutes: 60 };
});

test("a person slower in short slots learns a lower factor, pulled towards the assumed one while there are few blocks", () => {
  const [one] = fitEfficiency(history(4));
  expect(one).toBeLessThan(ASSUMED_EFFICIENCY[0]);
  expect(one).toBeGreaterThan(0.5);
  expect(fitEfficiency(history(40))[0]).toBeLessThan(one);
  // Two short is never above one short.
  const [first, second] = fitEfficiency(history(40));
  expect(second).toBeLessThanOrEqual(first);
});

test("the assumed factors stay until the backtest shows the learned ones better", () => {
  expect(learnedEfficiency(history(6))).toBeUndefined();
  expect(backtestEfficiency(history(30)).evaluated).toBeGreaterThanOrEqual(5);
  expect(learnedEfficiency(history(30))![0]).toBeLessThan(0.8);
  // A person whose short blocks go exactly as assumed never gets factors of their own.
  const asAssumed = history(30).map((sample) => sample.slot === "medium" ? { ...sample, minutes: 60 } : sample);
  expect(learnedEfficiency(asAssumed)).toBeUndefined();
});
