import { expect, test } from "vitest";
import { BASELINE_DAYS, deriveCapacity, type CapacityInput } from "./capacity";

const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}`;
const base = (over: Partial<CapacityInput> = {}): CapacityInput => ({
  now: "2026-09-20T12:00:00.000Z",
  selfReports: [],
  dailyActivity: [],
  interruptionDensity: [],
  localActivityConsent: "granted",
  ...over
});

test("a fresh self-report outranks anything inferred about the person", () => {
  const reading = deriveCapacity(base({
    selfReports: [{ level: "low", confidence: "high", observedAt: "2026-09-20T11:00:00.000Z" }],
    dailyActivity: Array.from({ length: 30 }, (_, i) => ({ day: day(i + 1), activeMinutes: 400, windowSwitches: 100 }))
  }));
  expect(reading).toMatchObject({ level: "low", confidence: "high", basis: ["self_report"] });
});

test("a stale self-report is not presented as how you are now", () => {
  const reading = deriveCapacity(base({
    selfReports: [{ level: "high", confidence: "high", observedAt: "2026-09-20T02:00:00.000Z" }]
  }));
  expect(reading.level).toBe("uncalibrated");
});

test("without a personal baseline the answer is uncalibrated, and it says what is missing", () => {
  const reading = deriveCapacity(base({
    dailyActivity: Array.from({ length: 5 }, (_, i) => ({ day: day(i + 1), activeMinutes: 300, windowSwitches: 80 }))
  }));
  expect(reading.level).toBe("uncalibrated");
  expect(reading.basis).toEqual([]);
  expect(reading.blockers[0]).toMatchObject({ code: "BASELINE_INSUFFICIENT" });
  expect(reading.blockers[0]!.message).toContain(String(BASELINE_DAYS));
});

test("activity classifies only against the person's own baseline, in three coarse levels", () => {
  const baseline = Array.from({ length: 20 }, (_, i) => ({ day: day(i + 1), activeMinutes: 300 + i * 10, windowSwitches: 90 }));
  const quiet = deriveCapacity(base({ dailyActivity: [...baseline, { day: day(25), activeMinutes: 120, windowSwitches: 40 }] }));
  const busy = deriveCapacity(base({ dailyActivity: [...baseline, { day: day(25), activeMinutes: 900, windowSwitches: 200 }] }));
  expect(quiet).toMatchObject({ level: "low", confidence: "low", basis: ["local_activity"] });
  expect(busy.level).toBe("high");
  // The only number allowed out of here is a count of observations: no score, no percentage.
  expect(Object.keys(quiet).filter((key) => typeof (quiet as Record<string, unknown>)[key] === "number"))
    .toEqual(["observationCount"]);
});

test("real interruption data corroborates a level but never produces one on its own", () => {
  const baseline = Array.from({ length: 20 }, (_, i) => ({ day: day(i + 1), activeMinutes: 300 + i * 10, windowSwitches: 90 }));
  const density = Array.from({ length: 20 }, (_, i) => ({ day: day(i + 1), perActiveHour: 1 + i * 0.1 }));
  const agreeing = deriveCapacity(base({
    dailyActivity: [...baseline, { day: day(25), activeMinutes: 120, windowSwitches: 40 }],
    interruptionDensity: [...density, { day: day(25), perActiveHour: 9 }]
  }));
  expect(agreeing).toMatchObject({ level: "low", confidence: "medium", basis: ["local_activity", "execution_history"] });

  // Interruption data alone, with no activity baseline, cannot classify anything.
  const alone = deriveCapacity(base({ interruptionDensity: [...density, { day: day(25), perActiveHour: 9 }] }));
  expect(alone.level).toBe("uncalibrated");
});

test("without consent the reading stays uncalibrated and says why, instead of falling back to a guess", () => {
  const reading = deriveCapacity(base({
    localActivityConsent: "unasked",
    dailyActivity: Array.from({ length: 30 }, (_, i) => ({ day: day(i + 1), activeMinutes: 400, windowSwitches: 100 }))
  }));
  expect(reading).toMatchObject({ level: "uncalibrated", basis: [] });
  expect(reading.blockers[0]?.code).toBe("LOCAL_ACTIVITY_NOT_AUTHORISED");
});

test("a capacity reading carries no scheduling decision: it has no task, slot or ordering field", () => {
  const reading = deriveCapacity(base({
    selfReports: [{ level: "low", confidence: "high", observedAt: "2026-09-20T11:30:00.000Z" }]
  }));
  // Advisory by construction: there is nowhere in this shape to put a decision about what to do next.
  expect(Object.keys(reading).sort()).toEqual(["basis", "blockers", "confidence", "level", "observationCount"]);
});
