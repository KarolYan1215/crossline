import { expect, test } from "vitest";
import {
  currentRiskReview, keepMilestoneRisks, MILESTONE_RISK_SCHEMA, milestoneRiskFingerprint, riskBufferDays, ruleMilestoneRisks, validateMilestoneRisks,
  type MilestoneRiskContext
} from "./milestone-risk";
import { structuredOutputProblems } from "./structured-output";

const base = { today: "2026-10-15", criteria: [{ statement: "投稿系统显示已提交", measure: { kind: "artifact" } }], dependsOn: [], otherDeadlines: [] };

test("the schema keeps to the strict structured-output rules", () => {
  expect(structuredOutputProblems(MILESTONE_RISK_SCHEMA)).toEqual([]);
});

test("rules: a milestone with room, a standard and no clash has no risk", () => {
  expect(ruleMilestoneRisks({ ...base, deadline: "2026-12-01" })).toEqual([]);
});

test("rules read the date, the standard, the dependencies, the forecast and nearby deadlines, one risk per kind, highest first", () => {
  expect(ruleMilestoneRisks({ ...base, deadline: null, criteria: [] })).toEqual([
    expect.objectContaining({ level: "medium", kind: "unclear" })]);
  expect(ruleMilestoneRisks({ ...base, deadline: "2026-10-17" })[0]).toMatchObject({ level: "high", kind: "time", note: "距截止仅 2 天" });
  expect(ruleMilestoneRisks({ ...base, deadline: "2026-10-10" })[0]).toMatchObject({ level: "high", kind: "time", note: "截止日已过 5 天" });
  const risks = ruleMilestoneRisks({ ...base, deadline: "2026-11-20",
    criteria: [{ statement: "期末 ≥ 86", measure: { kind: "threshold", value: 86, bareLine: 85, comparator: "gte", unit: "分" } }],
    dependsOn: [{ title: "完成实验数据", deadline: "2026-11-21" }], otherDeadlines: ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-22"], slackDays: -3 });
  expect(risks.map((risk) => [risk.level, risk.kind])).toEqual([["high", "capacity"], ["high", "dependency"], ["medium", "unrealistic"]]);
  expect(risks[0]!.note).toBe("按现有排程预计晚 3 天");
});

test("a review counts only for the version it read; the buffer follows the highest risk that is not about the standard", () => {
  const fingerprint = milestoneRiskFingerprint({ title: "投出第一篇论文", deadline: "2026-12-01", criteria: ["已提交"], dependsOn: [] });
  expect(fingerprint).toBe(milestoneRiskFingerprint({ title: " 投出第一篇论文", deadline: "2026-12-01", criteria: ["已提交"], dependsOn: [] }));
  const stored = { fingerprint, at: "2026-10-15T00:00:00Z", source: "model" as const, risks: [] };
  expect(currentRiskReview(stored, fingerprint)).toEqual([]);
  expect(currentRiskReview(stored, milestoneRiskFingerprint({ title: "投出第一篇论文", deadline: "2026-12-08", criteria: ["已提交"], dependsOn: [] }))).toBeUndefined();
  expect(riskBufferDays([{ level: "high", kind: "unclear", note: "无标准" }])).toBe(0);
  expect(riskBufferDays([{ level: "medium", kind: "time", note: "两周" }, { level: "low", kind: "capacity", note: "同周" }])).toBe(1);
  expect(riskBufferDays([{ level: "high", kind: "dependency", note: "等数据" }])).toBe(2);
});

const context: MilestoneRiskContext = { version: "crossline.milestone-risk.v1", today: "2026-10-15", weeklyHours: 40, others: [],
  milestones: ["m1", "m2"].map((id) => ({ id, status: "draft", line: "research", lineLabel: "研究者", project: "", title: id, deadline: "2026-12-01", daysLeft: 47,
    criteria: [], rationale: "", dependsOn: [], ruleFindings: [] })) };

test("every draft comes back once (no risk is an answer); a missing one is sent back by name, and after the repairs the answered ones are kept", () => {
  const answer = { milestones: [{ milestoneId: "m1", risks: [{ level: "high", kind: "time", note: "两周内从零完成投稿" },
    { level: "low", kind: "time", note: "重复" }, { level: "medium", kind: "bogus", note: "未知种类" }] }, { milestoneId: "m2", risks: [] }, { milestoneId: "x", risks: [] }] };
  const kept = validateMilestoneRisks(answer, context);
  expect(kept.get("m1")).toEqual([{ level: "high", kind: "time", note: "两周内从零完成投稿" }]);
  expect(kept.get("m2")).toEqual([]);
  expect(kept.has("x")).toBe(false);
  expect(() => validateMilestoneRisks({ milestones: [{ milestoneId: "m1", risks: [] }] }, context)).toThrow("MILESTONE_RISK_MISSING");
  expect(keepMilestoneRisks({ milestones: [{ milestoneId: "m1", risks: [] }] }, context)).toEqual({ milestones: [{ milestoneId: "m1", risks: [] }] });
  expect(keepMilestoneRisks({ milestones: [] }, context)).toBeUndefined();
});
