import { expect, test } from "vitest";
import { nightlyTrigger, rankCandidates, stalledIdentities, type NightlyInput } from "./flywheel";

// UTC-5, so a UTC timestamp of 07:00 is 02:00 locally — inside a 01:00–04:00 night window.
const OFFSET = -300;
const at = (utc: string) => Math.floor(Date.parse(utc) / 1000);
const input = (over: Partial<NightlyInput> = {}): NightlyInput => ({
  now: "2026-09-20T07:10:00.000Z",
  resetsAt: [at("2026-09-20T07:00:00.000Z")],
  night: { startHour: 1, endHour: 4 },
  cost: { available: true, limitReached: false, short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null } },
  spend: { windowSharePercent: 80, longWindowCeilingPercent: 90 },
  idleRequiredMs: 20 * 60_000,
  timeZoneOffsetMinutes: OFFSET,
  ...over
});

test("the run is anchored to the earliest real reset inside the night window, not a fixed hour", () => {
  const decision = nightlyTrigger(input({
    resetsAt: [at("2026-09-20T08:30:00.000Z"), at("2026-09-20T07:00:00.000Z")],
    now: "2026-09-20T08:40:00.000Z"
  }));
  // Earliest reset (02:00 local) + 5 minutes grace, not the later one.
  expect(decision).toMatchObject({ run: true });
  if (decision.run) expect(decision.plannedAt).toBe("2026-09-20T07:05:00.000Z");
});

test("a night with no quota reset simply does not run, rather than forcing a time", () => {
  expect(nightlyTrigger(input({ resetsAt: [at("2026-09-20T18:00:00.000Z")] })))
    .toMatchObject({ run: false, code: "NO_RESET_IN_NIGHT_WINDOW" });
});

test("it waits for the planned moment instead of starting as soon as the night begins", () => {
  expect(nightlyTrigger(input({ now: "2026-09-20T07:01:00.000Z" })))
    .toMatchObject({ run: false, code: "BEFORE_PLANNED_TIME" });
});

test("a person still at the keyboard defers the run, so it cannot take the quota they are using", () => {
  expect(nightlyTrigger(input({ idleMs: 60_000 }))).toMatchObject({ run: false, code: "USER_ACTIVE" });
  expect(nightlyTrigger(input({ idleMs: 30 * 60_000 }))).toMatchObject({ run: true });
  // Collection being off means the check cannot be made — it is not a reason to refuse.
  expect(nightlyTrigger(input())).toMatchObject({ run: true });
});

test("cost gates still apply, and an unreadable signal refuses the run", () => {
  expect(nightlyTrigger(input({ cost: { available: false, reason: "supervisor down" } })))
    .toMatchObject({ run: false, code: "COST_SIGNAL_UNAVAILABLE" });
  expect(nightlyTrigger(input({
    cost: { available: true, limitReached: false, long: { usedPercent: 95, windowDurationMins: 10_080, resetsAt: null } }
  }))).toMatchObject({ run: false, code: "LONG_WINDOW_BUDGET_SPENT" });
});

test("one run per local night", () => {
  expect(nightlyTrigger(input({ lastRunDay: "2026-09-20" })))
    .toMatchObject({ run: false, code: "ALREADY_RAN_TODAY" });
});

const candidate = (over: Partial<Parameters<typeof rankCandidates>[0][number]>) => ({
  id: "c", targetMilestoneId: "m", reusesExistingArtifact: false, counterexampleCount: 0,
  costMinutes: null, targetStalledDays: 0, createdAt: "2026-09-01T00:00:00.000Z", hasEvidence: true, ...over
});

test("highlights are ordered by counted facts, never by a model's opinion of value", () => {
  const ranked = rankCandidates([
    candidate({ id: "plain" }),
    candidate({ id: "refuted-looking", counterexampleCount: 2, targetStalledDays: 30, reusesExistingArtifact: true }),
    candidate({ id: "stalled-and-reuses", targetStalledDays: 12, reusesExistingArtifact: true }),
    candidate({ id: "stalled-only", targetStalledDays: 5 })
  ]);
  // Stalled target + zero new cost + no counterexample comes first; a counterexample sinks to last.
  expect(ranked.highlighted.map((item) => item.id)).toEqual(["stalled-and-reuses", "stalled-only", "plain"]);
  expect(ranked.kept.at(-1)?.id).toBe("refuted-looking");
});

test("the pool is capped so it cannot become a second inbox, and overflow is archived not deleted", () => {
  const many = Array.from({ length: 14 }, (_, i) => candidate({
    id: `c${String(i).padStart(2, "0")}`, hasEvidence: i % 2 === 0, createdAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`
  }));
  const ranked = rankCandidates(many);
  expect(ranked.kept).toHaveLength(10);
  expect(ranked.highlighted).toHaveLength(3);
  expect(ranked.archived).toHaveLength(4);
  // Evidence-less and oldest are the first to go.
  expect(ranked.archived[0]?.hasEvidence).toBe(false);
});

test("a stall is reported as a fact with its day count, and reporting it spends nothing", () => {
  expect(stalledIdentities([
    { identityId: "research", daysSinceLastPass: 12 },
    { identityId: "media", daysSinceLastPass: 3 },
    { identityId: "startup", daysSinceLastPass: null },
    { identityId: "investment", daysSinceLastPass: 40 }
  ], 7)).toEqual([
    { identityId: "investment", daysSinceLastPass: 40 },
    { identityId: "research", daysSinceLastPass: 12 }
  ]);
});

test("an unreadable cost signal is reported as itself, not as an absent reset window", () => {
  // Without a reading there are no reset times either, so a window-first check would blame the wrong
  // thing and send anyone debugging it to the wrong place.
  const decision = nightlyTrigger(input({ cost: { available: false, reason: "supervisor down" }, resetsAt: [] }));
  expect(decision).toMatchObject({ run: false, code: "COST_SIGNAL_UNAVAILABLE" });
  if (!decision.run) expect(decision.message).toContain("supervisor down");
});
