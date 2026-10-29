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

test("an unbound work order runs approve → start → pause → resume → complete, and completing is accepting (2026-10-15)", () => {
  const store = seed("awaiting_plan_approval", [], "");
  expect(approveWorkOrderProposal(TEST_CTX, "w1")).toEqual({ ok: true });
  // The standard is fixed at approval: judging afterwards uses it and nothing more.
  expect((store.listWorkOrders(TEST_CTX.workspaceId)[0]?.payload as { acceptanceStandard?: unknown }).acceptanceStandard).toMatchObject({ lines: ["结论记录"] });
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("active");
  expect(pauseWorkOrderExecution(TEST_CTX, "w1", "被组会打断")).toEqual({ ok: true });
  expect(resumeWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [{ kind: "record", uri: "local://note", description: "结论记录" }]))
    .toEqual({ ok: true, completion: { mode: "self_evident" } });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("accepted");
  // A replayed completion is not an error.
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [])).toEqual({ ok: true });
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)[0]?.reviewStatus).toBe("accepted");
  const execution = store.listExecutions(TEST_CTX.workspaceId)[0]!;
  expect(execution).toMatchObject({ durationObserved: true, outcome: "completed" });
  expect(execution.interruptions).toMatchObject([{ reason: "被组会打断" }]);
});

test("pausing or resuming an active order whose session a confirmed block already closed is refused, not thrown", () => {
  const store = seed("approved", [], "");
  expect(startWorkOrderExecution(TEST_CTX, "w1", "2026-10-29T14:00:00.000Z")).toEqual({ ok: true });
  // The completion check closes the session over the block's own times; the task stays active.
  store.recordConfirmedSession(TEST_CTX.workspaceId, "w1", TEST_CTX.principalId, { startedAt: "2026-10-29T14:00:00.000Z", endedAt: "2026-10-29T15:00:00.000Z",
    minutes: 60, source: "one_tap", key: "confirmed-session:t" });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("active");
  expect(pauseWorkOrderExecution(TEST_CTX, "w1", "块结束")).toEqual({ ok: false, code: "NO_ACTIVE_EXECUTION" });
  expect(resumeWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: false, code: "NO_ACTIVE_EXECUTION" });
  // Starting again opens a new session, which pauses as usual.
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(pauseWorkOrderExecution(TEST_CTX, "w1", "块结束")).toEqual({ ok: true });
});

test("work the assistant handed in still waits for the gate: a milestone-bound review cannot be accepted by hand", () => {
  const store = seed("evidence_review");
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

test("a milestone-bound order pressed 完成 with no evidence is accepted, recorded honestly as without evidence", () => {
  const store = seed("ready_for_human");
  expect(startWorkOrderExecution(TEST_CTX, "w1")).toEqual({ ok: true });
  expect(completeWorkOrderExecution(TEST_CTX, "w1", [])).toMatchObject({ ok: true });
  expect(store.listWorkOrders(TEST_CTX.workspaceId)[0]?.state).toBe("accepted");
  expect(store.listEvidenceClaims(TEST_CTX.workspaceId)).toEqual([]);
  expect(store.listExecutions(TEST_CTX.workspaceId)[0]).toMatchObject({
    durationObserved: true, outcome: "completed_without_evidence"
  });
  expect(JSON.stringify(store.listEvents(TEST_CTX.workspaceId))).not.toContain("manual_confirmation");
});

test("a human can block an evidence review, and acceptance is the only gate to accepted", () => {
  const store = seed("evidence_review");
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

// Every backplanned step has an empty material contract; counting an approved one as "not ready" left 「下一步」 empty with five
// approved orders on the real board.
test("an approved order that needs no materials is ready to start; one that needs them is not until they are prepared", async () => {
  const { inputsReady } = await import("./crossline");
  expect(inputsReady({ state: "approved", payload: { materialContract: [] } })).toBe(true);
  expect(inputsReady({ state: "approved", payload: {} })).toBe(true);
  expect(inputsReady({ state: "approved", payload: { materialContract: [{ kind: "file" }] } })).toBe(false);
  expect(inputsReady({ state: "preparing", payload: {} })).toBe(false);
  expect(inputsReady({ state: "ready_for_human", payload: { materialContract: [{ kind: "file" }] } })).toBe(true);
});

test("work whose result comes later is accepted at once and followed up; a stated outcome is kept", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const order = (id: string, title: string) => store.saveWorkOrder({ id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "ece548", milestoneId: "m", intent: title, state: "ready_for_human", riskTier: "milestone",
    estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { title } });
  order("exam", "ECE 548 期中考试 1");
  order("draft", "起草组会报告");
  for (const id of ["exam", "draft"]) startWorkOrderExecution(TEST_CTX, id);
  expect(completeWorkOrderExecution(TEST_CTX, "exam", [], [], "2026-10-27T20:00:00.000Z")).toEqual({ ok: true,
    completion: { mode: "needs_assessment", followUp: "「ECE 548 期中考试 1」的成绩或结果出来了吗？" } });
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "exam")?.state).toBe("accepted");
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "assessment.pending", entityId: "exam" })[0]?.payload)
    .toMatchObject({ reason: "result_pending", askAfter: "2026-10-28T20:00:00.000Z", milestoneId: "m" });
  // Said how it went at completion: a quality follow-up has nothing left to ask.
  expect(completeWorkOrderExecution(TEST_CTX, "draft", [], [], undefined, undefined, { level: "barely", note: "图表还差一张" }))
    .toEqual({ ok: true, completion: { mode: "needs_assessment" } });
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "assessment.pending", entityId: "draft" })).toEqual([]);
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "work_order.outcome_reported", entityId: "draft" })[0]?.payload).toMatchObject({ level: "barely", note: "图表还差一张" });
});

test("a standard edited on the card before approving replaces the contract's wording and is what the task is judged by", () => {
  const store = seed("awaiting_plan_approval");
  expect(approveWorkOrderProposal(TEST_CTX, "w1", { acceptanceStandard: ["  结论记录与三条依据 ", ""] })).toEqual({ ok: true });
  const payload = store.listWorkOrders(TEST_CTX.workspaceId)[0]?.payload as { evidenceContract: unknown[]; acceptanceStandard: unknown };
  expect(payload.evidenceContract).toEqual([{ kind: "record", description: "结论记录与三条依据", why: "本人批准时定下的验收标准", required: true }]);
  expect(payload.acceptanceStandard).toMatchObject({ lines: ["结论记录与三条依据"], by: "person" });
});
