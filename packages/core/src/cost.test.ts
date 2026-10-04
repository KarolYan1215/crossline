import { expect, test } from "vitest";
import { allowDiscretionarySpend, type CostSignal } from "./cost";

const policy = { windowSharePercent: 80, longWindowCeilingPercent: 90 };
const signal = (over: Partial<Extract<CostSignal, { available: true }>> = {}): CostSignal => ({
  available: true, limitReached: false,
  short: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  long: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
  ...over
});

test("no signal means no discretionary spending, never an assumption that quota remains", () => {
  const decision = allowDiscretionarySpend({ available: false, reason: "supervisor unreachable" }, policy);
  expect(decision).toMatchObject({ allowed: false, code: "COST_SIGNAL_UNAVAILABLE" });
  expect(decision.allowed).toBe(false);
});

test("a spent weekly window puts discretionary work on hold and says by how much", () => {
  const decision = allowDiscretionarySpend(signal({ long: { usedPercent: 91, windowDurationMins: 10_080, resetsAt: null } }), policy);
  expect(decision).toMatchObject({ allowed: false, code: "LONG_WINDOW_BUDGET_SPENT" });
  if (!decision.allowed) expect(decision.message).toContain("91%");
});

test("the nightly share is a ceiling on the window, not a fresh allowance each run", () => {
  expect(allowDiscretionarySpend(signal({ short: { usedPercent: 75, windowDurationMins: 300, resetsAt: null } }), policy))
    .toMatchObject({ allowed: true, headroomPercent: 5 });
  expect(allowDiscretionarySpend(signal({ short: { usedPercent: 80, windowDurationMins: 300, resetsAt: null } }), policy))
    .toMatchObject({ allowed: false, code: "WINDOW_BUDGET_SPENT" });
});

test("a reached rate limit is refused outright", () => {
  expect(allowDiscretionarySpend(signal({ limitReached: true }), policy))
    .toMatchObject({ allowed: false, code: "RATE_LIMIT_REACHED" });
});

test("degradation modes read a measured percentage", () => {
  const normal = allowDiscretionarySpend(signal(), policy);
  const economy = allowDiscretionarySpend(signal({ long: { usedPercent: 86, windowDurationMins: 10_080, resetsAt: null } }), policy);
  expect(normal).toMatchObject({ allowed: true, mode: "normal" });
  expect(economy).toMatchObject({ allowed: true, mode: "economy" });
});
