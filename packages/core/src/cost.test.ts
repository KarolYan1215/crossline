import { expect, test } from "vitest";
import { allowDiscretionarySpend, backgroundSpend, chatgptExhausted, chatgptQuotaSpent, CORE_STOP_PERCENT, engagementTier, spendAllows, type CostSignal } from "./cost";
import { evalHoldActive } from "./background";

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

test("spending follows the person: active runs everything the quota allows, cooling only intake, dormant nothing", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");
  expect(engagementTier("2026-10-12T00:00:00.000Z", now)).toBe("active");
  expect(engagementTier("2026-10-10T12:00:00.000Z", now)).toBe("cooling");
  expect(engagementTier("2026-09-27T04:44:00.000Z", now)).toBe("dormant");
  // A new account with nothing done yet counts from when it began; with neither, it is active.
  expect(engagementTier(undefined, now, "2026-10-13T08:00:00.000Z")).toBe("active");
  expect(engagementTier(undefined, now)).toBe("active");
  const normal = backgroundSpend({ available: true, short: { usedPercent: 10 }, long: { usedPercent: 10 }, limitReached: false } as CostSignal);
  const kinds = ["intake", "core", "discretionary"] as const;
  expect(kinds.map((kind) => spendAllows({ ...normal, engagement: "active" }, kind))).toEqual([true, true, true]);
  expect(kinds.map((kind) => spendAllows({ ...normal, engagement: "cooling" }, kind))).toEqual([true, false, false]);
  expect(kinds.map((kind) => spendAllows({ ...normal, engagement: "dormant" }, kind))).toEqual([false, false, false]);
});

test("a spent quota names when the fullest window comes back, and says the person's own turns stop too", async () => {
  const { degradedService } = await import("./cost");
  const spend = backgroundSpend({ available: true, limitReached: false,
    short: { usedPercent: 40, windowDurationMins: 300, resetsAt: Date.UTC(2026, 9, 18, 9) / 1000 },
    long: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: Date.UTC(2026, 9, 20, 3) / 1000 } });
  expect(spend.blocker).toMatchObject({ code: "BUDGET_EXHAUSTED", resetsAt: "2026-10-20T03:00:00.000Z" });
  expect(degradedService("BUDGET_EXHAUSTED").personTurns).toBe(false);
  expect(degradedService("COST_SIGNAL_UNAVAILABLE").works).toContain("排程与日历：按现有任务和步骤照常重排，写入 Crossline 日历");
});

test("near the end of the quota core work stops first and intake runs on to the last of it", () => {
  const at = (short: number): CostSignal => ({ available: true, limitReached: false,
    short: { usedPercent: short, windowDurationMins: 300, resetsAt: null } });
  const allowed = (used: number) => (["intake", "core", "discretionary"] as const).map((kind) => spendAllows(backgroundSpend(at(used)), kind));
  expect(allowed(90)).toEqual([true, true, false]);
  expect(allowed(CORE_STOP_PERCENT)).toEqual([true, false, false]);
  expect(allowed(100)).toEqual([false, false, false]);
});

test("a spent ChatGPT reading is marked until the spent window resets; a refused run alone holds half an hour", () => {
  const reset = Date.UTC(2026, 9, 21, 7, 57) / 1000;
  expect(chatgptQuotaSpent(signal())).toBeUndefined();
  expect(chatgptQuotaSpent({ available: false, reason: "x" })).toBeUndefined();
  expect(chatgptQuotaSpent(signal({ limitReached: true, short: { usedPercent: 100, windowDurationMins: 300, resetsAt: reset } })))
    .toEqual({ until: new Date(reset * 1000).toISOString() });
  // An API-key login's month is the person's own cap, not ChatGPT's quota.
  expect(chatgptQuotaSpent(signal({ limitReached: true, money: { spent: 11, cap: 10 } }))).toBeUndefined();
  const now = new Date("2026-10-21T07:00:00.000Z");
  expect(chatgptExhausted(JSON.stringify({ at: now.toISOString(), source: "quota", until: "2026-10-21T07:57:00.000Z" }), now)).toBeDefined();
  expect(chatgptExhausted(JSON.stringify({ at: now.toISOString(), source: "quota", until: "2026-10-21T06:59:00.000Z" }), now)).toBeUndefined();
  expect(chatgptExhausted(JSON.stringify({ at: "2026-10-21T06:45:00.000Z", source: "usage_limit" }), now)).toBeDefined();
  expect(chatgptExhausted(JSON.stringify({ at: "2026-10-21T06:20:00.000Z", source: "usage_limit" }), now)).toBeUndefined();
  expect(chatgptExhausted("", now)).toBeUndefined();
  expect(chatgptExhausted("not json", now)).toBeUndefined();
});

test("a local evaluation on the same sign-in holds discretionary work only, and only while its process lives and the hold is fresh", () => {
  const spend = { ...backgroundSpend(signal()), held: true };
  expect([spendAllows(spend, "intake"), spendAllows(spend, "core"), spendAllows(spend, "discretionary")]).toEqual([true, true, false]);
  const now = new Date("2026-10-21T04:00:00Z");
  const hold = (startedAt: string, pid = 42) => JSON.stringify({ pid, startedAt });
  const alive = (pid: number) => pid === 42;
  expect(evalHoldActive(hold("2026-10-21T03:30:00Z"), now, alive)).toBe(true);
  expect(evalHoldActive(hold("2026-10-21T03:30:00Z", 7), now, alive)).toBe(false);   // the script is gone
  expect(evalHoldActive(hold("2026-10-20T21:30:00Z"), now, alive)).toBe(false);      // older than the cap: its pid may be reused
  expect(evalHoldActive(undefined, now, alive)).toBe(false);
  expect(evalHoldActive("{not json", now, alive)).toBe(false);
});
