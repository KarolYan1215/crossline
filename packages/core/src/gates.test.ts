import { expect, test } from "vitest";
import { estimateRatio, gateNeedsPerson, pendingGateSubjects, gateRunsDisagree, latestGateJudgements, maskPrivate, parkedMilestones, pdkHit, readPdkTerms,
  todaysFront, type GateJudgedPayload, type GateOutput } from "./gates";

/** The parts of the execution gates code decides by itself (docs/plans/execution-gates-1124.md §四.0): comparisons, never judgements. */
const output = (verdict: string, harm: GateOutput["ifWrong"]["harm"] = "quality", fixable: GateOutput["ifWrong"]["fixable"] = "before_step"): GateOutput =>
  ({ verdict, confidence: "medium", evidence: [], reason: "", ifWrong: { harm, fixable }, detail: {} });
const event = (eventId: string, type: string, entityId: string, payload: unknown, createdAt = "2026-11-24T10:00:00.000Z") => ({ eventId, type, entityId, payload, createdAt });
const judged = (gate: GateJudgedPayload["gate"], subject: GateJudgedPayload["subject"], out: GateOutput): GateJudgedPayload =>
  ({ gate, subject, run: 1, model: "m", effort: "", promptVersion: "v1", inputDigest: { sha256: "", summary: "" }, output: out, asked: false });

test("the person is asked when the runs disagree, or when being wrong goes outside or costs a deadline and cannot be fixed before the step", () => {
  expect(gateRunsDisagree(output("done"), output("planned"))).toBe(true);
  expect(gateNeedsPerson("completion", output("done"), true)).toBe(true);
  expect(gateNeedsPerson("completion", output("done", "external", "after_submit"), false)).toBe(true);
  expect(gateNeedsPerson("completion", output("done", "deadline", "before_step"), false)).toBe(false);
  expect(gateNeedsPerson("completion", output("done", "quality", "never"), false)).toBe(false);
  // A gate's `askOn` verdicts are always asked; a gate read elsewhere (J3 in the weekly review) never is.
  expect(gateNeedsPerson("setback", output("goal_wrong"), false)).toBe(true);
  expect(gateNeedsPerson("setback", output("noise"), false)).toBe(false);
  expect(gateNeedsPerson("attention", output("crowded_out", "external", "never"), true)).toBe(false);
});

test("what is left to judge: not judged in the period, and not failed three times today", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");
  const attempt = (payload: unknown, at = "2026-11-24T10:00:00.000Z") => ({ at, payload });
  const events = [event("j", "gate.judged", "a", judged("priority", { kind: "task", id: "a" }, output("p1")), "2026-11-20T00:00:00.000Z")];
  const attempts = [
    ...[1, 2, 3].map(() => attempt({ gate: "priority", round: "r", subjects: ["b", "c"], ok: false, missing: [] })),
    attempt({ gate: "priority", round: "r", subjects: ["d"], ok: true, missing: ["d"] }),
    attempt({ gate: "priority", round: "r", subjects: ["e"], ok: false, missing: [] }, "2026-11-22T00:00:00.000Z")
  ];
  expect(pendingGateSubjects(events, "priority", ["a", "b", "d", "e"], now, "", attempts)).toEqual(["d", "e"]);
  // Judged before this period's start: due again.
  expect(pendingGateSubjects(events, "priority", ["a"], now, "2026-11-23T00:00:00.000Z")).toEqual(["a"]);
});

test("the latest judgement per subject carries the person's override; today's front pick is gone once turned over", () => {
  const events = [event("j1", "gate.judged", "2026-11-24", judged("front", { kind: "day", id: "2026-11-24" }, { ...output("front"), detail: { task: "t1", costOfDelay: "晚一天", minutes: 20 } }))];
  expect(todaysFront(events, "2026-11-24")).toEqual({ eventId: "j1", task: "t1", costOfDelay: "晚一天", minutes: 20 });
  const overridden = [...events, event("o1", "gate.changed", "j1", { judgedId: "j1", gate: "front", subject: { kind: "day", id: "2026-11-24" }, from: "front", to: "none", change: "overridden" })];
  expect(latestGateJudgements(overridden, "front").get("day:2026-11-24")!.overridden?.to).toBe("none");
  expect(todaysFront(overridden, "2026-11-24")).toBeNull();
});

test("the estimate ratio is the median of actual over estimate, censored and old ones left out", () => {
  const now = new Date("2026-11-24T00:00:00.000Z");
  const row = (observed: number, estimate: number | null, censored = false, at = "2026-11-20T00:00:00.000Z") => ({ observedMinutes: observed, llmP50Minutes: estimate, censored, observedAt: at });
  expect(estimateRatio([], now)).toBeNull();
  expect(estimateRatio([row(60, 30), row(90, 30), row(30, 30), row(500, 10, true), row(100, 10, false, "2026-09-01T00:00:00.000Z"), row(40, null)], now))
    .toMatchObject({ median: 2, n: 3, p25: 1.5, p75: 2.5 });
});

test("PDK terms match as whole words or extensions, and private text is masked", () => {
  const terms = readPdkTerms(JSON.stringify(["gf180"]));
  expect(pdkHit("cells.lib", terms)).toBe(true);
  expect(pdkHit("GF180 corner sweep", terms)).toBe(true);
  expect(pdkHit("library.libx and updkx", terms)).toBe(false);
  expect(maskPrivate("gf180 sweep — VS Code", terms, [])).toBe("[仅本地]");
  expect(maskPrivate("Thoughts — Obsidian", terms, ["C:\\Users\\k\\Desktop\\Thoughts"])).toBe("[仅本地]");
  expect(maskPrivate("README.md — Multi-ID", terms, ["C:\\Users\\k\\Desktop\\Thoughts"])).toBe("README.md — Multi-ID");
});

test("a milestone is parked until an unpark event follows", () => {
  const parked = { milestoneId: "m2", judgedId: "j", unparkWhen: "m1", reason: "", archivedTasks: [] };
  expect([...parkedMilestones([event("p", "milestone.changed", "m2", { ...parked, change: "parked" })]).keys()]).toEqual(["m2"]);
  expect(parkedMilestones([event("p", "milestone.changed", "m2", { ...parked, change: "parked" }), event("u", "milestone.changed", "m2", { change: "unparked" }, "2026-11-25T00:00:00.000Z")]).size).toBe(0);
});
