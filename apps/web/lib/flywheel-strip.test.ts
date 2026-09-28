import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { ensureSeeded, loadDashboard } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

// Seeded first (so its own starter milestones/example relations land before ours), then two milestones
// of our own on top — a relation between them is what should surface as a flywheel-strip node/edge.
function seedTwoRelatedMilestones(store: CrosslineStore) {
  ensureSeeded(TEST_CTX);
  store.saveMilestone({ id: "m-quiet", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "research", title: "安静的里程碑·无动态", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "写完初稿", required: true, measure: { kind: "artifact", mustExist: "draft.md" } }] });
  store.saveMilestone({ id: "m-active", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "startup", title: "活跃的里程碑·有判定", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "验证客户", required: true, measure: { kind: "artifact", mustExist: "notes.md" } }] });
  store.saveMilestoneRelation({ id: "rel-test-informs", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    fromMilestoneId: "m-quiet", toMilestoneId: "m-active", kind: "informs", status: "candidate",
    explanation: "论文里的分析方法能验证客户假设", refutedWhen: "如果两者完全无关" });
  // A gate judgement is the recency signal `flywheelStrip` reads — appended directly rather than driving
  // the full WorkOrder state machine, since only the event's presence/timestamp matters here.
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    idempotencyKey: "test:gate:m-active", type: "milestone_gate.judged", entityId: "work-order-fake",
    payload: { milestoneId: "m-active", milestoneVersion: 1, verdict: "pass", criteriaVerdict: [] } });
}

test("a milestone with a real relation and a recorded signal becomes a flywheel-strip node", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedTwoRelatedMilestones(store);
  const data = await loadDashboard(TEST_CTX);
  const ids = data.flywheelStrip.nodes.map((node) => node.id);
  expect(ids).toContain("m-quiet");
  expect(ids).toContain("m-active");
  const edge = data.flywheelStrip.edges.find((item) => item.from === "m-quiet" && item.to === "m-active");
  expect(edge).toMatchObject({ kindLabel: "提供输入", pending: true, count: 1 });
});

test("a milestone with a recorded gate judgement sorts after one with no activity at all", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedTwoRelatedMilestones(store);
  const data = await loadDashboard(TEST_CTX);
  const quietIndex = data.flywheelStrip.nodes.findIndex((node) => node.id === "m-quiet");
  const activeIndex = data.flywheelStrip.nodes.findIndex((node) => node.id === "m-active");
  expect(quietIndex).toBeGreaterThanOrEqual(0);
  expect(activeIndex).toBeGreaterThan(quietIndex);
  const activeNode = data.flywheelStrip.nodes[activeIndex]!;
  expect(activeNode.latestSignal).toBe("已判定 1 次");
  const quietNode = data.flywheelStrip.nodes[quietIndex]!;
  expect(quietNode.latestSignal).toBe("等待进展");
});

test("a relation pointing at a milestone that was never saved produces no edge, and never crashes", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  // m-lonely is real, so it can still show up as an isolated node — what must never happen is a dangling
  // edge to "does-not-exist", which was never saved as a milestone at all.
  store.saveMilestone({ id: "m-lonely", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "research", title: "孤立里程碑", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "x", required: true, measure: { kind: "artifact", mustExist: "x.md" } }] });
  store.saveMilestoneRelation({ id: "rel-dangling", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    fromMilestoneId: "m-lonely", toMilestoneId: "does-not-exist", kind: "enables", status: "candidate",
    explanation: "x", refutedWhen: "y" });
  const data = await loadDashboard(TEST_CTX);
  expect(data.flywheelStrip.edges.some((edge) => edge.from === "m-lonely" || edge.to === "does-not-exist")).toBe(false);
  expect(data.flywheelStrip.nodes.some((node) => node.id === "does-not-exist")).toBe(false);
});
