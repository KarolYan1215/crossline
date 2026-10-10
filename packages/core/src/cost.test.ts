import { expect, test } from "vitest";
import { allowDiscretionarySpend, backgroundSpend, spendAllows, type CostSignal } from "./cost";

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

test("background work reads one signal one way: core work runs until the quota is gone, discretionary work only while it is roomy", () => {
  const at = (short: number, long = 0): CostSignal => ({ available: true, limitReached: false,
    short: { usedPercent: short, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: long, windowDurationMins: 10080, resetsAt: null } });
  const rows: Array<[CostSignal, boolean, boolean]> = [
    [at(10), true, true],
    [at(70), true, true],
    [at(20, 90), true, false],   // economy: the capture analysis still runs, the curator waits
    [at(100), false, false]
  ];
  for (const [signal, core, discretionary] of rows) {
    const spend = backgroundSpend(signal);
    expect([spendAllows(spend, "core"), spendAllows(spend, "discretionary")]).toEqual([core, discretionary]);
  }
  expect(backgroundSpend(at(100)).blocker?.code).toBe("BUDGET_EXHAUSTED");
  expect(backgroundSpend(at(20, 90)).blocker).toBeUndefined();
});

test("a quota that cannot be read pauses background work and says so, instead of stopping silently or spending blind", () => {
  const spend = backgroundSpend({ available: false, reason: "chatgpt authentication required" });
  expect(spendAllows(spend, "core")).toBe(false);
  expect(spend.blocker).toMatchObject({ code: "COST_SIGNAL_UNAVAILABLE" });
  expect(spend.blocker?.reason).toBe("chatgpt authentication required");
  expect(spend.blocker?.message).toContain("还没有登录模型账号");
});

test("a reached limit names when it comes back", () => {
  const spend = backgroundSpend({ available: true, limitReached: true, short: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.UTC(2026, 9, 11, 3) / 1000 } });
  expect(spend.blocker?.code).toBe("RATE_LIMIT_REACHED");
  expect(spend.blocker?.resetsAt).toBe("2026-10-11T03:00:00.000Z");
});
