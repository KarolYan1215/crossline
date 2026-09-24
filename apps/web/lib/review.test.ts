import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "./test-support";
import { loadWeeklyReview } from "./review";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const seed = () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", title: "稳定推进实验", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "三组实验归因到同一机制", required: true, measure: { kind: "count", unit: "组", atLeast: 3 } }] });
  store.saveMilestone({ id: "m2", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "media",
    projectId: "p", title: "只靠判断的里程碑", version: 1, status: "approved",
    successCriteria: [{ id: "c2", statement: "想清楚方向", required: true, measure: { kind: "judgement", rubric: "有结论", failsWhen: "没有给出反例检验" } }] });
  return store;
};

test("every automatic acceptance is listed individually, never folded into a count", () => {
  const store = seed();
  store.saveWorkOrder({ id: "w1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", milestoneId: "m1", intent: "整理三组实验异常", state: "accepted", riskTier: "milestone",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { autoAcceptance: { acceptedAt: "2026-09-20T03:00:00.000Z", relationIds: [] } } });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, idempotencyKey: "a1",
    type: "milestone_gate.auto_accepted", entityId: "w1", payload: { milestoneId: "m1", relationIds: [] } });

  const review = loadWeeklyReview(TEST_CTX);
  expect(review.autoAccepted).toHaveLength(1);
  expect(review.autoAccepted[0]).toMatchObject({ workOrderId: "w1", intent: "整理三组实验异常", milestoneId: "m1" });
});

test("a milestone with no criteria is flagged rather than shown as if it could be judged", () => {
  const store = seed();
  store.saveMilestone({ id: "m3", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "startup",
    projectId: "p", title: "旧种子", version: 1, status: "approved" });
  const review = loadWeeklyReview(TEST_CTX);
  expect(review.milestoneProgress.find((item) => item.id === "m3")?.criteria).toEqual([]);
  expect(review.milestoneProgress.find((item) => item.id === "m2")?.verifiability).toBe("judgement_only");
});

test("findings carry their source and expiry, so a stale one can be recognised later", () => {
  const store = seed();
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, idempotencyKey: "f1",
    type: "flywheel.finding", entityId: "m1",
    payload: { milestoneId: "m1", summary: "更快的标定", sourceUrl: "https://example.org/p",
      sourceTitle: "Faster", retrievedAt: "2026-09-20T03:00:00.000Z", staleWhen: "被后续工作证伪", helpsHow: "用于标准一" } });
  const review = loadWeeklyReview(TEST_CTX);
  expect(review.findings[0]).toMatchObject({ sourceUrl: "https://example.org/p", staleWhen: "被后续工作证伪" });
});

test("questions are only what the Skill actually asked; an empty list is not a fabricated one", () => {
  seed();
  expect(loadWeeklyReview(TEST_CTX).questions).toEqual([]);
});
