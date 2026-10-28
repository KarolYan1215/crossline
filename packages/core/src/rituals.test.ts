import { describe, expect, test } from "vitest";
import {
  answerAllSteps, commitWeekOf, deferTarget, groupMinutes, overloaded, proposeWeeklyCommit, riskDigestShows, safeAssistantResult, staleProposal,
  weeklyCommitDue, weekStartOf, wrapTimeOf, type CommitTask
} from "./rituals";
import type { Ask } from "./asks";

describe("weeks", () => {
  test("a week runs Monday to Sunday", () => {
    expect(weekStartOf("2026-10-28")).toBe("2026-10-26"); // Wednesday
    expect(weekStartOf("2026-10-26")).toBe("2026-10-26"); // Monday
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26"); // Sunday
  });
  test("Sunday evening commits next week, any other moment this week", () => {
    expect(commitWeekOf("2026-11-01", "16:59")).toBe("2026-10-26");
    expect(commitWeekOf("2026-11-01", "17:00")).toBe("2026-11-02");
    expect(commitWeekOf("2026-11-02", "08:00")).toBe("2026-11-02");
  });
});

describe("proposeWeeklyCommit", () => {
  const today = "2026-10-28", weekStart = "2026-10-26";
  const task = (id: string, minutes: number, extra: Partial<CommitTask> = {}): CommitTask => ({ id, minutes, started: false, weight: 50, ...extra });

  test("started and due-this-week work is kept first; what does not fit is pushed; a smaller later task still fills what is left", () => {
    const { groups, keptMinutes } = proposeWeeklyCommit({ today, weekStart, capacityMinutes: 300, tasks: [
      task("later-big", 200, { dueDay: "2026-11-20" }),
      task("due", 180, { dueDay: "2026-10-30" }),
      task("started", 100, { started: true, dueDay: "2026-11-20" }),
      task("small", 20)
    ] });
    expect(groups.started).toEqual({ group: "keep", reason: "started" });
    expect(groups.due).toEqual({ group: "keep", reason: "due" });
    expect(groups["later-big"]?.group).toBe("defer");
    expect(groups.small).toEqual({ group: "keep", reason: "fits" });
    expect(keptMinutes).toBe(300);
  });

  test("never-started ordinary work a week overdue is suggested for 砍; important or started work never is", () => {
    const { groups } = proposeWeeklyCommit({ today, weekStart, capacityMinutes: 1000, tasks: [
      task("stale", 60, { dueDay: "2026-10-20" }),
      task("stale-important", 60, { dueDay: "2026-10-20", weight: 70 }),
      task("stale-started", 60, { dueDay: "2026-10-20", started: true }),
      task("recent", 60, { dueDay: "2026-10-25" })
    ] });
    expect(groups.stale).toEqual({ group: "drop", reason: "stale" });
    expect(groups["stale-important"]?.group).toBe("keep");
    expect(groups["stale-started"]?.group).toBe("keep");
    expect(groups.recent?.group).toBe("keep");
  });

  test("the heavier milestone wins inside the same due rank", () => {
    const { groups } = proposeWeeklyCommit({ today, weekStart, capacityMinutes: 100, tasks: [
      task("light", 100, { dueDay: "2026-10-30", weight: 30 }), task("heavy", 100, { dueDay: "2026-10-31", weight: 80 })] });
    expect(groups.heavy?.group).toBe("keep");
    expect(groups.light?.group).toBe("defer");
  });

  test("group minutes follow the person's choices; unchosen counts as kept", () => {
    const tasks = [task("a", 30), task("b", 50)];
    expect(groupMinutes(tasks, { b: "defer" }, "keep")).toBe(30);
    expect(groupMinutes(tasks, { b: "defer" }, "defer")).toBe(50);
  });

  test("a pushed task whose due day falls before next week is due at the end of next week", () => {
    expect(deferTarget({ dueDay: "2026-10-30" }, weekStart)).toEqual({ notBefore: "2026-11-02", dueDay: "2026-11-08" });
    expect(deferTarget({ dueDay: "2026-11-20" }, weekStart)).toEqual({ notBefore: "2026-11-02" });
    expect(deferTarget({}, weekStart)).toEqual({ notBefore: "2026-11-02" });
  });
});

describe("weeklyCommitDue", () => {
  const record = (week: string, demand = 600, capacity = 600, overloadAskedFor?: string) =>
    ({ week, at: "2026-10-26T13:00:00Z", demandMinutes: demand, capacityMinutes: capacity, ...(overloadAskedFor ? { overloadAskedFor } : {}) });

  test("a week not yet committed is asked about from Sunday evening to the end of Monday, not chased after", () => {
    expect(weeklyCommitDue({ today: "2026-10-26", clock: "22:00", last: undefined, demandMinutes: 0, capacityMinutes: 600 }))
      .toEqual({ week: "2026-10-26", reason: "weekly" });
    expect(weeklyCommitDue({ today: "2026-10-28", clock: "10:00", last: undefined, demandMinutes: 0, capacityMinutes: 600 })).toBeUndefined();
    expect(weeklyCommitDue({ today: "2026-11-01", clock: "16:00", last: record("2026-10-19"), demandMinutes: 0, capacityMinutes: 600 })).toBeUndefined();
    expect(weeklyCommitDue({ today: "2026-11-01", clock: "18:00", last: record("2026-10-26"), demandMinutes: 0, capacityMinutes: 600 }))
      .toEqual({ week: "2026-11-02", reason: "weekly" });
  });
  test("a committed week asks again only for a new overload past 15%, once", () => {
    const base = { today: "2026-10-28", clock: "10:00", capacityMinutes: 600 };
    expect(weeklyCommitDue({ ...base, last: record("2026-10-26"), demandMinutes: 690 })).toBeUndefined();
    expect(weeklyCommitDue({ ...base, last: record("2026-10-26"), demandMinutes: 700 })).toEqual({ week: "2026-10-26", reason: "overload" });
    expect(weeklyCommitDue({ ...base, last: record("2026-10-26", 600, 600, "2026-10-26"), demandMinutes: 900 })).toBeUndefined();
    // Committed while already over (the person chose to keep it all): not asked again for the same overload.
    expect(weeklyCommitDue({ ...base, last: record("2026-10-26", 900, 600), demandMinutes: 950 })).toBeUndefined();
  });
  test("overloaded is strictly more than 15% over", () => {
    expect(overloaded(1150, 1000)).toBe(false);
    expect(overloaded(1151, 1000)).toBe(true);
  });
});

test("the wrap-up comes at the end of the day's last available window", () => {
  const windows = [{ days: [1, 2], start: "09:00", end: "12:00" }, { days: [1], start: "14:00", end: "21:30" }];
  expect(wrapTimeOf(windows, 1)).toBe("21:30");
  expect(wrapTimeOf(windows, 2)).toBe("12:00");
  expect(wrapTimeOf(windows, 0)).toBeUndefined();
});

describe("answerAllSteps", () => {
  const ask = (kind: Ask["kind"], options: Ask["options"], extra: Partial<Ask> = {}): Ask => ({ id: `${kind}:1`, kind, entityId: "x", title: kind, why: "",
    options, urgency: "soon", raisedAt: "", fingerprint: "f", ...extra });

  test("answers safe kinds by their recommendation and snoozes a relation check", () => {
    const steps = answerAllSteps([
      ask("missed_block", [{ id: "roll", label: "顺延", recommended: true }, { id: "split", label: "逐个" }]),
      ask("risk_digest", [{ id: "accept", label: "接受", recommended: true }]),
      ask("relation_check", [{ id: "fulfilled", label: "兑现" }])
    ]);
    expect(steps).toEqual([
      { askId: "missed_block:1", kind: "missed_block", title: "missed_block", optionId: "roll" },
      { askId: "risk_digest:1", kind: "risk_digest", title: "risk_digest", optionId: "accept" },
      { askId: "relation_check:1", kind: "relation_check", title: "relation_check", snooze: "week" }
    ]);
  });

  test("leaves every other kind, an urgent risk, and a recommendation that needs words, a field or a page", () => {
    expect(answerAllSteps([
      ask("interview_question", [{ id: "a", label: "a", recommended: true }]),
      ask("step_question", [{ id: "a", label: "a", recommended: true }]),
      ask("milestone_overdue", [{ id: "makeup", label: "补做", recommended: true }]),
      ask("milestone_risk", [{ id: "accept", label: "接受" }]),
      ask("weekly_commit", [{ id: "suggested", label: "按建议", recommended: true }]),
      ask("missed_block", [{ id: "x", label: "x", recommended: true, href: "/" }]),
      ask("milestone_risk_review", [{ id: "x", label: "x", recommended: true, fields: [{ id: "d", label: "d", kind: "date", required: true }] }]),
      ask("risk_digest", [{ id: "x", label: "x", recommended: true, needsNote: true }])
    ])).toEqual([]);
  });

  test("assistant results and proposals: only the clean and the stale", () => {
    expect(safeAssistantResult({ checksPassed: true, inputsModified: [], external: false, partial: false })).toBe(true);
    expect(safeAssistantResult({ checksPassed: true, inputsModified: [], external: true, partial: false })).toBe(false);
    expect(safeAssistantResult({ checksPassed: false, inputsModified: [], external: false, partial: false })).toBe(false);
    expect(safeAssistantResult({ checksPassed: true, inputsModified: ["a.md"], external: false, partial: false })).toBe(false);
    expect(staleProposal({ dueDay: "2026-10-27", createdAt: "2026-10-26T00:00:00Z", today: "2026-10-28" })).toBe(true);
    expect(staleProposal({ createdAt: "2026-10-14T00:00:00Z", today: "2026-10-28" })).toBe(true);
    expect(staleProposal({ dueDay: "2026-10-30", createdAt: "2026-10-20T00:00:00Z", today: "2026-10-28" })).toBe(false);
  });
});

describe("riskDigestShows", () => {
  const members = [{ id: "a", level: "medium" as const }, { id: "b", level: "high" as const }];
  test("once a week", () => {
    expect(riskDigestShows(members, undefined, "2026-10-26")).toBe(true);
    expect(riskDigestShows(members, { week: "2026-10-19", levels: { a: "medium", b: "high" } }, "2026-10-26")).toBe(true);
    expect(riskDigestShows(members, { week: "2026-10-26", levels: { b: "high" } }, "2026-10-26")).toBe(false);
    expect(riskDigestShows([], undefined, "2026-10-26")).toBe(false);
  });
  test("mid-week only when a risk turned high", () => {
    expect(riskDigestShows(members, { week: "2026-10-26", levels: { a: "medium", b: "medium" } }, "2026-10-26")).toBe(true);
    expect(riskDigestShows([{ id: "c", level: "medium" }], { week: "2026-10-26", levels: {} }, "2026-10-26")).toBe(false);
  });
});
