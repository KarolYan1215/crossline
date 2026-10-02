import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadTaskDetail, loadMilestoneDetail, loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "./task-detail";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

function seedOrderWithMilestone(store: CrosslineStore) {
  store.saveMilestone({ id: "m-paper", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "research", title: "论文初稿完成", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "初稿存在", required: true, evidenceOf: "outcome",
      measure: { kind: "artifact", mustExist: "draft.pdf" } }] });
  store.saveWorkOrder({
    id: "wo-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "research-default", milestoneId: "m-paper", intent: "把实验结果写成论文初稿",
    state: "preparing", riskTier: "milestone",
    estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: {
      manualPromotion: false, seeded: false,
      materialContract: [{ kind: "file", description: "三次实验的原始数据", why: "用来写方法与结果部分", required: true }],
      evidenceContract: [{ kind: "file", description: "导师签字确认的初稿", why: "证明已进入评审阶段", required: true }],
      blocker: { reason: "缺少上周实验的原始数据" }
    }
  });
  store.saveMaterial({ id: "mat-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    workOrderId: "wo-1", uri: "file:///data/materials/wo-1/outline.md", mediaType: "text/markdown", sourceRefs: [], createdAt: new Date().toISOString() });
}

test("loadTaskDetail assembles milestone link, contract items, prepared materials and blocker from one order", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  const detail = loadTaskDetail(TEST_CTX, "wo-1");
  expect(detail).toBeDefined();
  expect(detail?.milestone).toEqual({ id: "m-paper", title: "论文初稿完成" });
  expect(detail?.materialContract).toEqual([{ kind: "file", description: "三次实验的原始数据", why: "用来写方法与结果部分", required: true }]);
  expect(detail?.evidenceContract).toHaveLength(1);
  expect(detail?.preparedMaterials).toEqual([{ id: "mat-1", uri: "file:///data/materials/wo-1/outline.md", fileName: "outline.md", mediaType: "text/markdown" }]);
  expect(detail?.blocker).toEqual({ reason: "缺少上周实验的原始数据" });
  expect(detail?.identityLabel).toBe("科研");
});

test("loadTaskDetail returns undefined for an id that does not exist, rather than throwing", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(loadTaskDetail(TEST_CTX, "no-such-order")).toBeUndefined();
});

test("loadMilestoneDetail lists the work orders bound to it and its own success criteria", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  const detail = loadMilestoneDetail(TEST_CTX, "m-paper");
  expect(detail).toBeDefined();
  expect(detail?.title).toBe("论文初稿完成");
  expect(detail?.successCriteria).toHaveLength(1);
  expect(detail?.relatedWorkOrders).toEqual([{ id: "wo-1", intent: "把实验结果写成论文初稿", state: "preparing" }]);
});

test("a relation touching this milestone shows up as relatedFlywheel on both the task and the milestone", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  store.saveMilestone({ id: "m-other", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "startup", title: "验证客户假设", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "x", required: true, measure: { kind: "artifact", mustExist: "x.md" } }] });
  // An "approved" relation with no evidence is quietly coerced back to "candidate" by
  // `saveMilestoneRelation` itself ("a relation with no evidence decides nothing") — evidence is what
  // actually makes this one approved rather than pending.
  store.saveMilestoneRelation({ id: "rel-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    fromMilestoneId: "m-paper", toMilestoneId: "m-other", kind: "informs", status: "approved",
    evidence: [{ uri: "internal://analysis", source: "test", observedAt: new Date().toISOString() }],
    explanation: "论文方法可用于验证客户假设", refutedWhen: "如果完全无关" });
  const taskDetail = loadTaskDetail(TEST_CTX, "wo-1");
  expect(taskDetail?.relatedFlywheel).toEqual([{
    id: "rel-1", fromTitle: "论文初稿完成", toTitle: "验证客户假设", kindLabel: "提供输入",
    explanation: "论文方法可用于验证客户假设", pending: false
  }]);
  const milestoneDetail = loadMilestoneDetail(TEST_CTX, "m-paper");
  expect(milestoneDetail?.relatedFlywheel).toHaveLength(1);
});

function seedSecondOrderAcrossMilestones(store: CrosslineStore) {
  store.saveMilestone({ id: "m-other", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "startup", title: "验证客户假设", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "x", required: true, measure: { kind: "artifact", mustExist: "x.md" } }] });
  store.saveWorkOrder({
    id: "wo-2", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "startup",
    projectId: "startup-default", milestoneId: "m-other", intent: "约谈第一个客户",
    state: "active", riskTier: "routine",
    estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: {}
  });
  store.saveMilestoneRelation({ id: "rel-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    fromMilestoneId: "m-paper", toMilestoneId: "m-other", kind: "informs", status: "approved",
    evidence: [{ uri: "internal://analysis", source: "test", observedAt: new Date().toISOString() }],
    explanation: "论文方法可用于验证客户假设", refutedWhen: "如果完全无关" });
}

test("loadTaskDetailsBatch matches loadTaskDetail value-for-value across multiple orders and milestones", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  seedSecondOrderAcrossMilestones(store);
  const ids = ["wo-1", "wo-2"];
  const batch = loadTaskDetailsBatch(TEST_CTX, ids);
  for (const id of ids) expect(batch.get(id)).toEqual(loadTaskDetail(TEST_CTX, id));
});

test("loadTaskDetailsBatch returns an empty map for an empty id list", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(loadTaskDetailsBatch(TEST_CTX, [])).toEqual(new Map());
});

test("loadTaskDetailsBatch skips ids that don't exist rather than throwing or padding with undefined", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  const batch = loadTaskDetailsBatch(TEST_CTX, ["wo-1", "no-such-order"]);
  expect(batch.has("wo-1")).toBe(true);
  expect(batch.has("no-such-order")).toBe(false);
  expect(batch.size).toBe(1);
});

test("loadMilestoneDetailsBatch matches loadMilestoneDetail value-for-value across multiple milestones", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  seedSecondOrderAcrossMilestones(store);
  const ids = ["m-paper", "m-other"];
  const batch = loadMilestoneDetailsBatch(TEST_CTX, ids);
  for (const id of ids) expect(batch.get(id)).toEqual(loadMilestoneDetail(TEST_CTX, id));
});

test("loadMilestoneDetailsBatch returns an empty map for an empty id list", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(loadMilestoneDetailsBatch(TEST_CTX, [])).toEqual(new Map());
});

test("background facts set for an identity show up on both the task and milestone detail for that identity, and stay null until then", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOrderWithMilestone(store);
  expect(loadTaskDetail(TEST_CTX, "wo-1")?.background).toBeNull();
  expect(loadMilestoneDetail(TEST_CTX, "m-paper")?.background).toBeNull();

  store.mergeBackgroundFacts(TEST_CTX.workspaceId, "research", [
    { key: "paper_title", value: "XX 方法在 YY 场景下的应用", why: "捕获文本给出的暂定标题", sourceQuote: "论文标题暂定" }
  ]);

  const taskDetail = loadTaskDetail(TEST_CTX, "wo-1");
  expect(taskDetail?.background).toEqual([{ key: "paper_title", value: "XX 方法在 YY 场景下的应用",
    why: "捕获文本给出的暂定标题", sourceQuote: "论文标题暂定", updatedAt: expect.any(String) }]);
  const milestoneDetail = loadMilestoneDetail(TEST_CTX, "m-paper");
  expect(milestoneDetail?.background).toEqual(taskDetail?.background);

  const batchDetail = loadTaskDetailsBatch(TEST_CTX, ["wo-1"]).get("wo-1");
  expect(batchDetail?.background).toEqual(taskDetail?.background);
});
