import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, linkArtifactWork, saveStoredArtifactPlan, syncArtifactRelations } from "@crossline/db";
import { deriveArtifactRelations, type StoredArtifactPlan } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { approveMilestoneDrafts } from "./approvals";
import { answerAsk, collectAsks } from "./asks";
import { loadCurrentPlan, plannerIdOfBlock, saveMilestoneEdit, saveSchedulePreferences } from "./crossline";
import { loadEffectiveness } from "./effectiveness";
import { loadMilestoneBoard } from "./milestone-board";
import { removeCrossLineArtifact } from "./artifact-relations";
import { undoOp, withUndo } from "./undo";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const { workspaceId: W, principalId: owner } = TEST_CTX;
const criterion = { id: "c1", statement: "视频发布并收到 20 条评论", required: true, evidenceOf: "outcome" as const, measure: { kind: "count" as const, unit: "条", atLeast: 20 } };
const plan: StoredArtifactPlan = { version: 1, updatedAt: "t", needs: [],
  artifacts: [{ id: "research-figs", line: "research", kind: "论文图表", title: "MoS2 仿真图表", readyBy: "2026-10-20" }],
  supplies: [{ from: "research-figs", toLine: "media", use: "第 2 期视频配图", transfer: { metric: "图表", expected: 3, unit: "张" }, lagDays: 3,
    counterfactual: "没有这些图要自己重画，多花约 6 小时", hoursSaved: 6 }] };

function setup(now = "2026-10-10T15:00:00.000Z", status: { up?: "draft" | "approved"; down?: "draft" | "approved" } = {}) {
  vi.stubEnv("CROSSLINE_FIXED_NOW", now);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "up", ownerId: owner, workspaceId: W, identityId: "research", projectId: "p", title: "图表交付师兄确认", version: 1,
    status: status.up ?? "draft", successCriteria: [criterion] });
  store.saveMilestone({ id: "down", ownerId: owner, workspaceId: W, identityId: "media", projectId: "m", title: "第 2 期视频发布", version: 1,
    status: status.down ?? "draft", successCriteria: [criterion] });
  const anchor = { workspaceId: W, stage: 1, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "t" };
  store.saveMilestoneAnchor({ ...anchor, milestoneId: "up", deadline: "2026-10-20", outputs: ["research-figs"], inputs: [] });
  store.saveMilestoneAnchor({ ...anchor, milestoneId: "down", deadline: "2026-11-01", outputs: [], inputs: ["research-figs"] });
  saveStoredArtifactPlan(store, W, plan);
  const anchors = new Map(store.listMilestoneAnchors(W).map((item) => [item.milestoneId, item]));
  const { relations } = deriveArtifactRelations(["up", "down"].map((id) => { const milestone = store.getMilestone(W, id)!; return { id, line: milestone.identityId,
    title: milestone.title, status: milestone.status, deadline: anchors.get(id)!.deadline, outputs: anchors.get(id)!.outputs!, inputs: anchors.get(id)!.inputs! }; }), plan);
  syncArtifactRelations(store, W, owner, relations);
  return store;
}
const RELATION = "artifact:research-figs:up->down";

test("approving the downstream draft (batch) approves the relation with it", () => {
  const store = setup();
  expect(approveMilestoneDrafts(TEST_CTX, ["down"]).approved).toEqual(["down"]);
  expect(store.getMilestoneRelation(W, RELATION)!.status).toBe("approved");
});

test("undoing the downstream approval puts the relation back to a candidate", async () => {
  const store = setup();
  const result = await withUndo(TEST_CTX, "批准 1 个里程碑草稿", () => ({ ok: true as const, ...approveMilestoneDrafts(TEST_CTX, ["down"]) }));
  expect(store.getMilestoneRelation(W, RELATION)!.status).toBe("approved");
  expect(undoOp(TEST_CTX, result.op!.id)).toMatchObject({ ok: true });
  expect(store.getMilestone(W, "down")!.status).toBe("draft");
  expect(store.getMilestoneRelation(W, RELATION)!.status).toBe("candidate");
});

test("approving a single downstream milestone through its edit does the same", () => {
  const store = setup();
  expect(saveMilestoneEdit(TEST_CTX, { id: "down", identityId: "media", projectId: "m", title: "第 2 期视频发布", status: "approved", successCriteria: [criterion] }).ok).toBe(true);
  expect(store.getMilestoneRelation(W, RELATION)!.status).toBe("approved");
});

test("the board shows the artifact, transfer and check day, and flags an edge whose upstream is now due too late", async () => {
  const store = setup();
  let relation = (await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "up")!.relations[0]!;
  expect(relation).toMatchObject({ direction: "out", otherId: "down", pending: true, artifact: { id: "research-figs", title: "MoS2 仿真图表", kind: "论文图表" },
    transfer: { expected: 3, unit: "张", metric: "图表", measured: null }, checkOn: "2026-11-01", counterfactual: plan.supplies[0]!.counterfactual });
  expect(relation.broken).toBeUndefined();
  // The upstream deadline moved after the relation was made: the edge stays, drawn as broken.
  store.saveMilestoneAnchor({ ...store.listMilestoneAnchors(W).find((item) => item.milestoneId === "up")!, deadline: "2026-10-31" });
  relation = (await loadMilestoneBoard(TEST_CTX)).milestones.find((item) => item.id === "up")!.relations[0]!;
  expect(relation.broken).toContain("2026-10-29");
});

test("one cross-line artifact can be taken off a draft, and stays off", () => {
  const store = setup();
  expect(removeCrossLineArtifact(TEST_CTX, RELATION)).toEqual({ ok: true });
  expect(store.listMilestoneRelations(W)).toEqual([]);
  expect(removeCrossLineArtifact(TEST_CTX, RELATION)).toEqual({ ok: false, code: "RELATION_NOT_CANDIDATE" });
});

test("on the check day the person is asked whether the artifact arrived; 没有 refutes it and the fulfilment rate counts it", async () => {
  setup("2026-10-30T15:00:00.000Z", { up: "approved", down: "approved" });
  const store = globalThis.crosslineStore!;
  expect(collectAsks(TEST_CTX, new Date("2026-10-30T15:00:00.000Z")).some((ask) => ask.kind === "relation_check")).toBe(false);
  const day = new Date("2026-11-01T15:00:00.000Z");
  const ask = collectAsks(TEST_CTX, day).find((item) => item.kind === "relation_check")!;
  expect(ask).toMatchObject({ id: `relcheck:${RELATION}`, entityId: RELATION, urgency: "soon", dueDay: "2026-11-01", line: "research" });
  expect(ask.title).toMatch(/^\S+ · 图表交付师兄确认 是否给 \S+ · 第 2 期视频发布 提供了 3 张图表？$/);
  expect(ask.options.map((option) => option.label)).toEqual(["兑现", "部分", "没有"]);
  expect(await answerAsk(TEST_CTX, ask.id, "partial", { measured: "abc" }, day)).toEqual({ ok: false, code: "RELATION_MEASURED_INVALID" });
  expect(await answerAsk(TEST_CTX, ask.id, "none", { note: "图没画完" }, day)).toEqual({ ok: true });
  expect(store.getMilestoneRelation(W, RELATION)).toMatchObject({ status: "refuted", transfer: { measured: 0 } });
  expect(collectAsks(TEST_CTX, day).some((item) => item.kind === "relation_check")).toBe(false);
  const health = await loadEffectiveness(TEST_CTX, new Date("2026-11-01T15:00:00.000Z"));
  expect(health.relations).toEqual({ checked: 1, rate: 0, byKind: [{ kind: "论文图表", checked: 1, rate: 0 }] });
});

test("「部分」 records what arrived and counts half", async () => {
  setup("2026-11-01T15:00:00.000Z", { up: "approved", down: "approved" });
  const store = globalThis.crosslineStore!;
  expect(await answerAsk(TEST_CTX, `relcheck:${RELATION}`, "partial", { measured: "2 张" }, new Date("2026-11-01T15:00:00.000Z"))).toEqual({ ok: true });
  expect(store.getMilestoneRelation(W, RELATION)).toMatchObject({ status: "approved", transfer: { measured: 2 } });
  expect((await loadEffectiveness(TEST_CTX, new Date("2026-11-01T15:00:00.000Z"))).relations.rate).toBe(0.5);
});

const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];
const estimate = { p25Minutes: 60, p50Minutes: 90, p85Minutes: 120, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("a task that uses another line's artifact is scheduled after the task that produces it", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T13:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  await loadCurrentPlan(TEST_CTX);
  const order = (id: string, identityId: string, payload: Record<string, unknown>) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: W, identityId,
    projectId: `${identityId}-project`, milestoneId: "", intent: id, state: "ready_for_human", riskTier: "routine", estimate, payload });
  order("video", "media", { uses: ["research-figs"], dueDate: "2026-09-21" });
  order("make-figs", "research", { produces: "research-figs" });
  expect(linkArtifactWork(store, W)).toEqual(["video"]);
  const blocks = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:"));
  const first = (orderId: string) => blocks.filter((block) => plannerIdOfBlock(block.id).split("#")[0] === orderId).map((block) => `${block.day} ${block.start}`).sort()[0]!;
  expect(first("make-figs")).toBeDefined();
  expect(first("video")).toBeDefined();
  expect(first("make-figs") < first("video")).toBe(true);
});
