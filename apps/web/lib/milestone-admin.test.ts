import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { SuccessCriterion } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { ensureSeeded, getStore, saveMilestoneEdit, WORKSPACE_ID } from "./crossline";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const criterion = (over: Partial<SuccessCriterion> = {}): SuccessCriterion => ({
  id: "c1", statement: "有人主动回信约了后续", required: true, evidenceOf: "outcome",
  measure: { kind: "count", unit: "replies", atLeast: 1 }, ...over
});

test("a new milestone starts at version 1 and records that it was created", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const result = saveMilestoneEdit({
    identityId: "research", projectId: "", title: "把方法讲清楚",
    status: "draft", successCriteria: [criterion()]
  });
  expect(result).toMatchObject({ ok: true, version: 1 });
  const stored = store.listMilestones(WORKSPACE_ID)[0];
  expect(stored).toMatchObject({ title: "把方法讲清楚", status: "draft", verifiability: "measurable" });
  // An empty projectId becomes the identity's default rather than a NULL that analysis would skip.
  expect(stored?.projectId).toBe("research-default");
  expect(store.listEvents(WORKSPACE_ID).some((event) => event.type === "milestone.created")).toBe(true);
});

test("editing writes a new version instead of overwriting the one a gate judged against", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const created = saveMilestoneEdit({
    identityId: "research", projectId: "p", title: "原标题", status: "approved", successCriteria: [criterion()]
  });
  const id = (created as { id: string }).id;
  const revised = saveMilestoneEdit({
    id, identityId: "research", projectId: "p", title: "改过的标题",
    status: "approved", successCriteria: [criterion({ statement: "改过的标准" })]
  });
  expect(revised).toMatchObject({ ok: true, version: 2 });
  // The reader returns only the latest version, but the old row is still there to be read back.
  expect(store.listMilestones(WORKSPACE_ID)).toHaveLength(1);
  expect(store.listMilestones(WORKSPACE_ID)[0]).toMatchObject({ title: "改过的标题", version: 2 });
  const rows = store.exportSnapshot(WORKSPACE_ID).tables.milestones ?? [];
  expect(rows.filter((row) => row.id === id)).toHaveLength(2);
});

test("a judgement criterion with no falsifier is refused with the code that says which rule failed", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const result = saveMilestoneEdit({
    identityId: "research", projectId: "p", title: "含糊的目标", status: "draft",
    successCriteria: [criterion({ measure: { kind: "judgement", rubric: "做得好", failsWhen: "  " } })]
  });
  // Collapsing this into a generic failure would hide which criterion the person has to fix.
  expect(result).toEqual({ ok: false, code: "CRITERION_NOT_FALSIFIABLE" });
  expect(globalThis.crosslineStore.listMilestones(WORKSPACE_ID)).toEqual([]);
});

test("an identity with no installed pack is refused", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(saveMilestoneEdit({
    identityId: "not-a-pack", projectId: "p", title: "x", status: "draft", successCriteria: [criterion()]
  })).toEqual({ ok: false, code: "MILESTONE_IDENTITY_UNKNOWN" });
});

test("an all-output milestone still saves — the warning is the user's to judge, not the system's veto", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const result = saveMilestoneEdit({
    identityId: "research", projectId: "p", title: "只有产出物", status: "approved",
    successCriteria: [criterion({ evidenceOf: "output", measure: { kind: "artifact", mustExist: "summary" } })]
  });
  // The criteria belong to the user. Refusing to save would be the system overriding the person it
  // works for; the review surfaces the risk instead.
  expect(result).toMatchObject({ ok: true });
  expect(store.listMilestones(WORKSPACE_ID)[0]?.successCriteria[0]?.evidenceOf).toBe("output");
});

test("a pre-scheduler database is cleared of its example blocks and unblocked diffs", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.savePlanVersion({ id: "personal-plan-v1", ownerId: "local-owner", workspaceId: WORKSPACE_ID,
    version: 1, status: "draft", payload: { blocks: [
      { id: "class", lane: "human", title: "课程", start: "09:00", end: "10:15", source: "示例数据", readOnly: true },
      { id: "graph_calendar:real", lane: "human", title: "真实日程", start: "11:00", end: "12:00", source: "日历", readOnly: true }
    ] } });
  store.savePlanChange({ id: "personal-plan-v1-change-1", ownerId: "local-owner", workspaceId: WORKSPACE_ID,
    planVersionId: "personal-plan-v1", kind: "add", triggerEventId: "seed", explanation: "示例", status: "pending" });
  ensureSeeded();

  // The lanes are computed from the calendar and the scheduler now, so a seeded example is not just
  // decoration — it is a claim about the day that nothing made.
  const blocks = (store.listPlanVersions(WORKSPACE_ID)[0]?.payload as { blocks: Array<Record<string, string>> }).blocks;
  expect(blocks.map((block) => block.id)).toEqual(["graph_calendar:real"]);
  // And the example diff no longer holds the plan hostage: approval refuses while anything is pending.
  expect(store.listPlanChanges("personal-plan-v1")[0]?.status).toBe("excluded");
});

test("migration keeps real user-authored plan blocks", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.savePlanVersion({ id: "personal-plan-v1", ownerId: "local-owner", workspaceId: WORKSPACE_ID,
    version: 1, status: "approved", payload: { blocks: [{ id: "user-focus", lane: "human",
      title: "已确认的工作段", day: "2026-09-18", start: "09:00", end: "10:00",
      source: "用户确认", readOnly: true }] } });
  ensureSeeded();
  const blocks = (store.listPlanVersions(WORKSPACE_ID)[0]?.payload as { blocks: Array<{ id: string }> }).blocks;
  expect(blocks.map((block) => block.id)).toEqual(["user-focus"]);
});
