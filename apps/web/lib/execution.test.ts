import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import {
  acceptWorkOrderEvidence, approveWorkOrderProposal, blockWorkOrderEvidence,
  completeWorkOrderExecution, getStore, markMaterialsReady, pauseWorkOrderExecution, resumeWorkOrderExecution,
  revokeAutoAcceptedWorkOrder, startWorkOrderExecution
} from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const seed = (state: string, materialContract: unknown[] = [], milestoneId = "m") => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({
    id: "w1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", milestoneId, intent: "审阅实验结论", state, riskTier: "milestone",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract, evidenceContract: [{ kind: "record", description: "结论记录", required: true }] }
  });
  return store;
};

test("an unbound work order runs approve → start → pause → resume → complete → accept on real records", () => {
  const store = seed("awaiting_plan_approval", [], "");
  expect(approveWorkOrderProposal(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("active");
  expect(pauseWorkOrderExecution(TEST_CTX, "w1", "被组会打断")).toEqual({ ok: true });
  expect(resumeWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [{ kind: "record", uri: "local://note", description: "结论记录" }])).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("evidence_review");
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)).toMatchObject([{ reviewStatus: "submitted", uri: "local://note" }]);

  expect(acceptWorkOrderEvidence(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("accepted");
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)[0]?.reviewStatus).toBe("accepted");
  const execution = store.listExecutions(TEST_CTX.workspaceId)[0]!;
  expect(execution).toMatchObject({ durationObserved: true, outcome: "completed" });
  expect(execution.interruptions).toMatchObject([{ reason: "被组会打断" }]);
});

test("a milestone-bound work order cannot bypass the AI gate through manual acceptance", () => {
  const store = seed("ready_for_human");
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [{ kind: "record", uri: "local://note", description: "结论记录" }])).toEqual({ ok: true });
  expect(acceptWorkOrderEvidence(TEST_CTX, "w1")).toEqual({ ok: false, code: "MILESTONE_GATE_REQUIRED" });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("evidence_review");
});

test("owing materials moves into preparation instead of dead-ending the work order", () => {
  const store = seed("approved", [{ kind: "file", description: "实验数据导出" }]);
  // Before this, any analysis that did its job and named a material need got stuck at `approved`
  // forever, because nothing in the system ever emitted `automation.started`.
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: false, code: "MATERIALS_PREPARING" });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("preparing");
  // Preparation that never finishes must not strand it either: the human can declare materials ready.
  expect(markMaterialsReady(TEST_CTX, "w1", "human")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("ready_for_human");
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("active");
});

test("materials can only be declared ready while preparation is actually under way", () => {
  seed("approved", [{ kind: "file", description: "实验数据导出" }]);
  expect(markMaterialsReady(TEST_CTX, "w1", "ai")).toEqual({ ok: false, code: "MATERIALS_NOT_PREPARING" });
});

test("the explicit execution path can honestly record completion without evidence", () => {
  const store = seed("ready_for_human");
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [])).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("evidence_review");
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)).toEqual([]);
  expect(store.listExecutions(TEST_CTX.workspaceId)[0]).toMatchObject({
    durationObserved: true, outcome: "completed_without_evidence"
  });
  expect(JSON.stringify(store.listEvents(TEST_CTX.workspaceId))).not.toContain("manual_confirmation");
});

test("a human can block an evidence review, and acceptance is the only gate to accepted", () => {
  const store = seed("ready_for_human");
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [])).toEqual({ ok: true });
  expect(blockWorkOrderEvidence(TEST_CTX, "w1", "")).toEqual({ ok: false, code: "BLOCK_REASON_REQUIRED" });
  expect(blockWorkOrderEvidence(TEST_CTX, "w1", "证据不足以支撑里程碑")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("blocked");
  expect(acceptWorkOrderEvidence(TEST_CTX, "w1")).toEqual({ ok: false, code: "EVIDENCE_REVIEW_NOT_READY" });
  expect(getStore().listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("blocked");
});

test("a blocked work order shows its reason and can be recovered by the same human approval", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "w", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "Draft", state: "evidence_review", riskTier: "routine", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
  expect(blockWorkOrderEvidence(TEST_CTX, "w", "证据不足")).toEqual({ ok: true });
  // The reason has to live on the row the page renders, not only in the ledger nobody opens.
  expect((store.listWorkOrders(TEST_CTX.workspaceId)[0]?.payload as { blocker?: { reason: string } }).blocker?.reason).toBe("证据不足");
  // Blocking must not be a one-way door: the transition table always allowed this recovery.
  expect(approveWorkOrderProposal(TEST_CTX, "w")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("approved");
  expect((store.listWorkOrders(TEST_CTX.workspaceId)[0]?.payload as { blocker?: unknown }).blocker).toBeUndefined();
});

test("revoking auto-acceptance twice on the same work order works both times", () => {
  // `revokeAutoAcceptedWorkOrder` computes its own idempotency key from how many times this work order
  // has already been revoked, rather than trusting a caller to number the attempt — a real revoke →
  // re-judge → revoke cycle used to reuse the first attempt's key on the second call and report success
  // for a revoke that silently never happened (packages/db/src/analysis.test.ts pins the store side).
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", title: "Measured", version: 1, status: "approved",
    successCriteria: [{ id: "c", statement: "three records", required: true, measure: { kind: "count", unit: "records", atLeast: 3 } }] });
  store.saveWorkOrder({ id: "w1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "Measure", state: "ready_for_human", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
  store.transitionWorkOrder(TEST_CTX.workspaceId, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(TEST_CTX.workspaceId, "w1", { type: "human.completed" }, "complete:w1", {
    evidence: [{ kind: "record", uri: "local://result", description: "three records support reuse" }]
  });
  const passResult = {
    verdict: "pass" as const,
    criteriaVerdict: [{ criterionId: "c", met: "met" as const, observed: "3", evidenceQuote: "three records", shortfall: null }],
    contractCoverage: [], unplannedGains: [], improvements: [], incomplete: [],
    flywheelAssessment: [], gaps: [], proposedNextMilestones: [], blockers: []
  };

  store.applyMilestoneGate(TEST_CTX.workspaceId, "w1", passResult, ["three records support reuse"], "gate:w1:0");
  expect(revokeAutoAcceptedWorkOrder(TEST_CTX, "w1", "第一次撤销")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("evidence_review");

  store.applyMilestoneGate(TEST_CTX.workspaceId, "w1", passResult, ["three records support reuse"], "gate:w1:1");
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("accepted");

  // Before the fix this returned { ok: true } while leaving the state exactly where it was.
  expect(revokeAutoAcceptedWorkOrder(TEST_CTX, "w1", "第二次撤销")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("evidence_review");
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)[0]?.reviewStatus).toBe("submitted");
});
