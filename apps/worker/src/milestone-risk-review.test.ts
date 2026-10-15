import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MILESTONE_RISKS_SETTING, parseMilestoneRisks } from "@crossline/core";
import { createMilestoneRiskReviewer, MILESTONE_RISK_REVIEWER, milestonesAwaitingRiskReview, riskReviewContext } from "./milestone-risk-review";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
const NOW = new Date("2026-10-15T15:00:00Z");
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  const save = (id: string, status: "draft" | "approved", deadline: string, dependsOn: string[] = []) => {
    store.saveMilestone({ id, ownerId: "user-1", workspaceId, identityId: "research", projectId: "", title: `里程碑 ${id}`, status, version: 1,
      successCriteria: [{ id: "c1", statement: "投稿系统显示已提交", required: true, evidenceOf: "output", measure: { kind: "artifact", mustExist: "提交确认" } }] });
    store.saveMilestoneAnchor({ workspaceId, milestoneId: id, stage: 1, deadline, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn,
      updatedAt: NOW.toISOString() });
  };
  save("a", "approved", "2026-11-20");
  save("b", "draft", "2026-11-19", ["a"]);
  save("c", "draft", "2026-12-20");
});
afterEach(() => store.close());

test("drafts wait for a review first, then approved milestones never reviewed; the context carries the rule findings and every other milestone", () => {
  expect(milestonesAwaitingRiskReview(store, workspaceId, NOW)).toEqual(["b", "c", "a"]);
  const context = riskReviewContext(store, workspaceId, ["b", "c"], NOW);
  expect(context.milestones[0]).toMatchObject({ id: "b", daysLeft: 35, dependsOn: [{ title: "里程碑 a", deadline: "2026-11-20" }],
    ruleFindings: [expect.objectContaining({ level: "high", kind: "dependency" })] });
  expect(context.others.map((item) => item.title)).toEqual(["里程碑 a"]);
});

test("each answer is stored under the milestone's fingerprint; an edit makes it stale; a left-out draft is retried after a day", async () => {
  const runtime = fakeRuntime([JSON.stringify({ milestones: [
    { milestoneId: "b", risks: [{ level: "high", kind: "dependency", note: "前置晚于本里程碑一天" }] }, { milestoneId: "c", risks: [] },
    { milestoneId: "a", risks: [] }] })], MILESTONE_RISK_REVIEWER);
  expect(await createMilestoneRiskReviewer(store, workspaceId, "C:\\repo", () => runtime.rpc)(NOW)).toEqual({ reviewed: 3, failed: 0 });
  const stored = parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING));
  expect(stored.b).toMatchObject({ source: "model", risks: [{ level: "high", kind: "dependency" }] });
  expect(stored.c).toMatchObject({ source: "model", risks: [] });
  expect(store.listEvents(workspaceId, { type: "milestone.risk_reviewed" })).toHaveLength(3);
  expect(milestonesAwaitingRiskReview(store, workspaceId, NOW)).toEqual([]);
  // An approved milestone edited after its review is not reviewed again (the page shows the rule estimate for it).
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "a", stage: 1, deadline: "2026-11-27", baseline: "", target: "", stakeholders: [], sourceFactIds: [],
    dependsOn: [], updatedAt: NOW.toISOString() });
  expect(milestonesAwaitingRiskReview(store, workspaceId, NOW)).toEqual([]);

  // A new deadline is a new milestone to judge.
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "c", stage: 1, deadline: "2026-10-18", baseline: "", target: "", stakeholders: [], sourceFactIds: [],
    dependsOn: [], updatedAt: NOW.toISOString() });
  expect(milestonesAwaitingRiskReview(store, workspaceId, NOW)).toEqual(["c"]);
  const partial = fakeRuntime(Array(3).fill(JSON.stringify({ milestones: [] })), MILESTONE_RISK_REVIEWER);
  expect(await createMilestoneRiskReviewer(store, workspaceId, "C:\\repo", () => partial.rpc)(NOW)).toMatchObject({ blocked: expect.any(String) });
  expect(parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING)).c).toMatchObject({ failed: expect.any(String) });
  expect(milestonesAwaitingRiskReview(store, workspaceId, NOW)).toEqual([]);
  expect(milestonesAwaitingRiskReview(store, workspaceId, new Date(NOW.getTime() + 25 * 3_600_000))).toEqual(["c"]);
});
