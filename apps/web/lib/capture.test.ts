import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { addCapturedTaskWithId, ensureSeeded, loadCurrentPlan, loadDashboard } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("capture persists text without classification, estimate or executable task, even on retry", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  addCapturedTaskWithId(TEST_CTX, { title: "分析论文", context: "只保留我提供的内容" }, "capture-1", "capture-1");
  addCapturedTaskWithId(TEST_CTX, { title: "分析论文", context: "只保留我提供的内容" }, "capture-1", "capture-1");
  expect(store.listWorkOrders(TEST_CTX.workspaceId)).toEqual([]);
  expect(store.listCaptures(TEST_CTX.workspaceId)).toEqual([{
    id: "capture-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    title: "分析论文", context: "只保留我提供的内容", state: "captured", attempt: 0, audit: {}
  }]);
  expect(store.listEvents(TEST_CTX.workspaceId)).toHaveLength(1);
});

test("seeding repairs starter milestones that an earlier version stored without a project", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  // Exactly the shape found in the live database: approved, but no projectId, so analysis skipped them all.
  store.saveMilestone({ id: "research-starter", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
    identityId: "research", title: "旧种子", version: 1, status: "approved" });
  ensureSeeded(TEST_CTX);
  const approved = store.listMilestones(TEST_CTX.workspaceId).filter((milestone) => milestone.status === "approved");
  expect(approved.filter((milestone) => milestone.projectId)).toHaveLength(approved.length);
  expect(approved.length).toBeGreaterThan(1);
});

test("the seeded plan never claims a connector imported it", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const plan = await loadCurrentPlan(TEST_CTX);
  // No connector is authorised, so a block that says "UW Outlook" or "Codex" is claiming an import
  // and an AI run that never happened.
  for (const block of plan.blocks) {
    expect(["UW Outlook", "Google Calendar", "Codex", "Crossline"]).not.toContain(block.source);
  }
  expect(JSON.stringify(plan.changes)).not.toContain("由 AI 准备完成");
});

test("an analysed work order appears on Today instead of vanishing from it", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  store.saveWorkOrder({
    id: "analysed", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "research-default", milestoneId: "research-starter", intent: "把三次实验异常整理成结论草稿",
    state: "ready_for_human", riskTier: "milestone",
    estimate: { p25Minutes: 45, p50Minutes: 70, p85Minutes: 105, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { humanCore: [{ id: "h", intent: "判断异常", energy: "high", interruptible: false }], materialContract: [] }
  });
  // Today used to read `tasks`, which analysis never writes — so a successful analysis removed the
  // item from the home page entirely.
  const data = loadDashboard(TEST_CTX);
  const shown = [data.primary, data.lowEnergy, data.shortGap].filter(Boolean);
  expect(shown.some((action) => action!.id === "analysed")).toBe(true);
  expect(data.upcoming.some((item) => item.id === "analysed")).toBe(true);
});

test("an item whose human core was never described shows unknown energy, not a default", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  store.saveWorkOrder({
    id: "aaa-no-core", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "research-default", milestoneId: "research-starter", intent: "未描述人工核心的条目",
    state: "ready_for_human", riskTier: "routine",
    estimate: { p25Minutes: 5, p50Minutes: 6, p85Minutes: 7, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract: [] }
  });
  const primary = loadDashboard(TEST_CTX).primary!;
  expect(primary.id).toBe("aaa-no-core");
  // "medium" would be a guess wearing the clothes of an observation.
  expect(primary.energy).toBeUndefined();
});
