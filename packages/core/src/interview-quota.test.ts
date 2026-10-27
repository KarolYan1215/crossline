import { expect, test } from "vitest";
import { addQuotaReading, interviewQuotaOutlook, perRoundCost, quotaReading, type QuotaReading } from "./interview-quota";
import type { CostSignal } from "./cost";

const signal = (long: number, short = 10, reached = false): CostSignal => ({ available: true, limitReached: reached,
  short: { usedPercent: short, windowDurationMins: 300, resetsAt: 1 }, long: { usedPercent: long, windowDurationMins: 10_080, resetsAt: 2 } });
const at = "2026-10-18T00:00:00Z";

test("a round's cost is the median rise in one window; a reset window is not counted", () => {
  let trace: QuotaReading[] = [];
  for (const [round, long] of [[1, 10], [2, 22], [3, 31], [4, 44]] as const) trace = addQuotaReading(trace, quotaReading(signal(long), round, at)!);
  expect(addQuotaReading(trace, quotaReading(signal(99), 4, at)!)).toBe(trace);
  expect(perRoundCost(trace)).toEqual({ window: "long", cost: 12 });
  const reset = [...trace, { round: 5, at, long: 3, longResetsAt: 9 }];
  expect(perRoundCost(reset)).toEqual({ window: "long", cost: 12 });
});

test("a Free account is warned before it is measured, told how many rounds are left once it is, and told what to do when it is spent", () => {
  const unmeasured = interviewQuotaOutlook({ plan: "free", signal: signal(5), trace: [], roundsDone: 0, complete: false });
  expect(unmeasured.verdict).toBe("tight");
  expect(unmeasured.message).toContain("开发者提供的模型");
  const trace = [1, 2, 3].map((round) => quotaReading(signal(10 * round + 20), round, at)!);
  const short = interviewQuotaOutlook({ plan: "free", signal: signal(50), trace, roundsDone: 3, complete: false });
  expect(short).toMatchObject({ verdict: "insufficient", perRound: 10, roundsLeft: 5, remainingRounds: 9 });
  expect(interviewQuotaOutlook({ plan: "plus", signal: signal(12), trace: [1, 2].map((round) => quotaReading(signal(round), round, at)!), roundsDone: 2, complete: false }).verdict).toBe("ok");
  expect(interviewQuotaOutlook({ plan: "free", signal: signal(100), trace, roundsDone: 3, complete: false }).verdict).toBe("spent");
  expect(interviewQuotaOutlook({ plan: "free", signal: signal(30), trace: [], roundsDone: 3, complete: false, usageLimitHit: true }).verdict).toBe("spent");
  expect(interviewQuotaOutlook({ plan: "free", signal: signal(100), trace, roundsDone: 14, complete: true }).verdict).toBe("ok");
});
