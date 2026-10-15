import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { DRAFT_WEIGHTS_SETTING, loadMilestoneBoard, recordRetrospective, saveDraftSettings } from "./milestone-board";
import { approveMilestoneDrafts } from "./approvals";
import { readGoalSettings } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const { workspaceId, principalId: ownerId } = TEST_CTX;
const criterion = { id: "c1", statement: "模拟测验 ≥ 85 分", required: true, evidenceOf: "outcome" as const,
  measure: { kind: "threshold" as const, unit: "分", comparator: "gte" as const, value: 88, bareLine: 85 } };

test("a milestone carries its score line as a threshold, and a reached one gets a retrospective the person can annotate", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-08T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m1", ownerId, workspaceId, identityId: "research", projectId: "ece555", title: "ECE 555 期中达到 88 分", status: "approved",
    version: 1, successCriteria: [criterion] });
  let board = await loadMilestoneBoard(TEST_CTX);
  const milestone = board.milestones.find((item) => item.id === "m1")!;
  expect(milestone.criteria[0]).toMatchObject({ quarters: 0, threshold: { comparator: "gte", value: 88, bare: 85, unit: "分" } });
  expect(milestone.retrospective).toBeUndefined();
  expect(await recordRetrospective(TEST_CTX, "m1", "提前两天模拟")).toEqual({ ok: false, code: "MILESTONE_NOT_REACHED" });

  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "gate-1", type: "milestone_gate.judged", entityId: "wo",
    payload: { milestoneId: "m1", criteriaVerdict: [{ criterionId: "c1", met: "met", observed: "模拟测验 91 分" }] } });
  board = await loadMilestoneBoard(TEST_CTX);
  expect(board.milestones.find((item) => item.id === "m1")!.retrospective).toMatchObject({ readings: [{ observed: "模拟测验 91 分" }] });
  expect(await recordRetrospective(TEST_CTX, "m1", "提前两天模拟")).toEqual({ ok: true });
  board = await loadMilestoneBoard(TEST_CTX);
  expect(board.milestones.find((item) => item.id === "m1")!.retrospective?.note).toBe("提前两天模拟");
  expect(store.listEvents(workspaceId, { type: "milestone.retrospective" })[0]?.payload).toMatchObject({ identityId: "research", note: "提前两天模拟" });
});

test("a draft carries its risks (the review for this version, else the rule estimate), the system's importance, and a date editable before approval", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-15T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "d1", ownerId, workspaceId, identityId: "research", projectId: "", title: "投出第一篇期刊论文", status: "draft", version: 1, successCriteria: [] });
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "d1", stage: 1, deadline: "2026-10-17", baseline: "", target: "", stakeholders: [], sourceFactIds: [],
    dependsOn: [], updatedAt: "2026-10-15T00:00:00Z" });
  let draft = (await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "d1")!;
  expect(draft.riskSource).toBe("rules");
  expect(draft.risks.map((risk) => [risk.level, risk.kind])).toEqual([["high", "time"], ["medium", "unclear"]]);
  expect(draft.weight).toBe(draft.presetWeight);
  expect(draft.ownWeight).toBe(false);

  const { MILESTONE_RISKS_SETTING, milestoneRiskFingerprint } = await import("@crossline/core");
  const fingerprint = milestoneRiskFingerprint({ title: "投出第一篇期刊论文", deadline: "2026-10-17", criteria: [], dependsOn: [] });
  store.setSetting(workspaceId, MILESTONE_RISKS_SETTING, JSON.stringify({ d1: { fingerprint, at: "2026-10-15T00:00:00Z", source: "model",
    risks: [{ level: "high", kind: "unrealistic", note: "两天内从零完成投稿" }] } }));
  draft = (await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "d1")!;
  expect(draft).toMatchObject({ riskSource: "model", risks: [{ kind: "unrealistic" }] });

  expect(saveDraftSettings(TEST_CTX, "d1", { deadline: "2026-12-01" })).toEqual({ ok: true });
  expect(saveDraftSettings(TEST_CTX, "d1", { deadline: "2026-13-01" })).toEqual({ ok: false, code: "MILESTONE_DATE_INVALID" });
  draft = (await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "d1")!;
  // The date moved: the old review no longer describes this milestone, and the estimate is back.
  expect(draft).toMatchObject({ deadline: "2026-12-01", riskSource: "rules" });
  expect(store.listEvents(workspaceId, { type: "milestone.revised" })).toHaveLength(1);
});

test("importance set on a draft is shown as the person's, and takes effect as the milestone's goal setting when it is approved", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-15T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "d2", ownerId, workspaceId, identityId: "research", projectId: "", title: "ECE 555 期末达到 88 分", status: "draft", version: 1,
    successCriteria: [criterion] });
  expect(saveDraftSettings(TEST_CTX, "d2", { weight: 83.4 })).toEqual({ ok: true });
  expect(saveDraftSettings(TEST_CTX, "d2", { weight: "high" })).toEqual({ ok: false, code: "MILESTONE_WEIGHT_INVALID" });
  expect(saveDraftSettings(TEST_CTX, "missing", { weight: 50 })).toEqual({ ok: false, code: "MILESTONE_NOT_DRAFT" });
  const draft = (await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "d2")!;
  expect(draft).toMatchObject({ weight: 83, ownWeight: true });
  expect(readGoalSettings(TEST_CTX, "d2")).toBeNull();

  expect(approveMilestoneDrafts(TEST_CTX, ["d2"]).approved).toEqual(["d2"]);
  expect(readGoalSettings(TEST_CTX, "d2")).toMatchObject({ weight: 83, importance: "important" });
  expect(JSON.parse(store.getSetting(workspaceId, DRAFT_WEIGHTS_SETTING) ?? "{}")).toEqual({});
  expect((await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "d2")).toMatchObject({ status: "approved", weight: 83, ownWeight: true });
});
