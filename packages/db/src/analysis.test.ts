import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

test("analysis transitions and event ledger are atomic and invalid transitions cannot create work", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.capture({ id: "c", ownerId: "o", workspaceId: "w", title: "Review supplied notes", context: "" }, "capture:c");
    expect(store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "start:c")).toMatchObject({ changed: true, state: "analyzing" });
    expect(store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "start:c")).toMatchObject({ changed: false });
    expect(() => store.transitionWorkOrder("w", "c", { type: "plan.approved", approvalId: "fake" }, "bad:c")).toThrow("INVALID_WORK_ORDER_TRANSITION");
    expect(store.listEvents("w")).toHaveLength(2);
    expect(store.listCaptures("w")[0]?.state).toBe("analyzing");
    expect(store.listWorkOrders("w")).toEqual([]);
    store.transitionWorkOrder("w", "c", { type: "blocked", reason: "ANALYSIS_UNAUTHENTICATED" }, "blocked:c");
    expect(() => store.transitionWorkOrder("w", "c", { type: "plan.approved", approvalId: "fake" }, "approve-blocked:c")).toThrow("INVALID_WORK_ORDER_TRANSITION");
  } finally { store.close(); }
});

test("valid analysis creates only an awaiting proposal with audit IDs; rejected finalization rolls back", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.capture({ id: "c", ownerId: "o", workspaceId: "w", title: "Decide", context: "" }, "capture:c");
    store.saveMilestone({ id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", title: "Decision", version: 1, status: "approved" });
    const context = { version: "crossline.analysis.v1", capture: { title: "Decide", context: "" }, approvedMilestones: [{ id: "m", projectId: "p", identityId: "research", title: "Decision", version: 1 }], availableInputs: [], identityPacks: [{ id: "research", version: 1, summary: "Human judgment" }], policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true } };
    const proposal = { identityId: "research", projectId: "p", milestoneId: "m", intent: "Decide", automationParts: [], humanCore: [{ id: "h", intent: "Decide", energy: "medium", interruptible: true, quote: "Decide", rationale: "Human judgment" }], materialContract: [], evidenceContract: [{ kind: "record", description: "Decision", why: "The decision is the deliverable", required: true }], estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: [] };
    store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "start:c");
    expect(() => store.transitionWorkOrder("w", "c", { type: "analysis.accepted", approvalId: "schema-validation" }, "finish:c", { proposal: { ...proposal, surprise: true }, context, audit: { threadId: "t", turnId: "u" } })).toThrow();
    expect(store.listEvents("w")).toHaveLength(2);
    expect(store.listWorkOrders("w")).toEqual([]);
    store.transitionWorkOrder("w", "c", { type: "analysis.accepted", approvalId: "schema-validation" }, "finish:c", { proposal, context, audit: { threadId: "t", turnId: "u" } });
    expect(store.listWorkOrders("w")[0]).toMatchObject({ state: "awaiting_plan_approval", payload: { audit: { threadId: "t", turnId: "u" }, humanCore: proposal.humanCore } });
    // The capture row is marked promoted rather than left frozen at the WorkOrder's state, so a later
    // WorkOrder transition can never make a stale duplicate of the same id resurface as analysable.
    expect(store.listCaptures("w")[0]).toMatchObject({ state: "promoted", audit: { threadId: "t", turnId: "u" } });
    store.transitionWorkOrder("w", "c", { type: "blocked", reason: "PLAN_REJECTED" }, "block:c");
    expect(store.listWorkOrders("w")[0]?.state).toBe("blocked");
    expect(store.listCaptures("w")[0]?.state).toBe("promoted");
  } finally { store.close(); }
});

test("a blocked capture may be re-analysed, but a blocked work order stays on the formal transitions", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.capture({ id: "c", ownerId: "o", workspaceId: "w", title: "Review supplied notes", context: "" }, "capture:c");
    store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "a0:start");
    store.transitionWorkOrder("w", "c", { type: "blocked", reason: "ANALYSIS_UNAUTHENTICATED" }, "a0:finish");
    // A blocked capture is still raw user text: a fresh attempt gets a fresh idempotency key.
    expect(store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "a1:start", { attempt: 1 }))
      .toMatchObject({ changed: true, state: "analyzing" });
    expect(store.listCaptures("w")[0]).toMatchObject({ state: "analyzing", attempt: 1 });
    expect(store.listEvents("w").at(-1)?.payload).toMatchObject({ from: "blocked", to: "analyzing" });
    // The retry must not become a back door into approval.
    expect(() => store.transitionWorkOrder("w", "c", { type: "plan.approved", approvalId: "fake" }, "a1:approve")).toThrow("INVALID_WORK_ORDER_TRANSITION");
  } finally { store.close(); }
});

test("audit on a promoted work order does not write back to its stale capture row", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.saveWorkOrder({ id: "w1", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
      intent: "Decide", state: "awaiting_plan_approval", riskTier: "routine", payload: {},
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
    // There is no capture row for this id; an audit-carrying transition must still succeed.
    expect(store.transitionWorkOrder("w", "w1", { type: "plan.approved", approvalId: "human" }, "approve:w1", { audit: { threadId: "t" } }))
      .toMatchObject({ changed: true, state: "approved" });
    expect(store.listWorkOrders("w")[0]?.state).toBe("approved");
  } finally { store.close(); }
});

test("milestone criteria round-trip, and a pre-v2 milestone is honestly unstated rather than invented", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.saveMilestone({ id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
      title: "旧种子", version: 1, status: "approved" });
    expect(store.listMilestones("w")[0]).toMatchObject({ successCriteria: [], verifiability: "unstated" });

    store.saveMilestone({ id: "m2", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
      title: "有指标", version: 1, status: "approved",
      successCriteria: [{ id: "c1", statement: "完成三门课", required: true, measure: { kind: "count", unit: "门", atLeast: 3 } }] });
    expect(store.listMilestones("w").find((m) => m.id === "m2"))
      .toMatchObject({ verifiability: "measurable", successCriteria: [{ measure: { atLeast: 3 } }] });

    // A judgement with no failure condition can never be judged short, so the store refuses it.
    expect(() => store.saveMilestone({ id: "m3", ownerId: "o", workspaceId: "w", identityId: "research",
      title: "说不清", version: 1, status: "draft",
      successCriteria: [{ id: "c1", statement: "想清楚", required: true, measure: { kind: "judgement", rubric: "有结论", failsWhen: "" } }] }))
      .toThrow("CRITERION_NOT_FALSIFIABLE");
  } finally { store.close(); }
});

test("a milestone-bound work order cannot be accepted on an empty evidence set", () => {
  const store = new CrosslineStore(":memory:");
  try {
    const base = { ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
      intent: "Draft", state: "evidence_review", riskTier: "routine" as const, payload: {},
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const } };
    store.saveWorkOrder({ ...base, id: "bound", milestoneId: "m" });
    store.saveWorkOrder({ ...base, id: "loose", milestoneId: "" });
    expect(() => store.transitionWorkOrder("w", "bound", { type: "evidence.accepted" }, "a:bound")).toThrow("EVIDENCE_REQUIRED");
    expect(store.listWorkOrders("w").find((o) => o.id === "bound")?.state).toBe("evidence_review");
    // An item bound to no milestone may still be closed without evidence, recorded as exactly that.
    expect(store.transitionWorkOrder("w", "loose", { type: "evidence.accepted" }, "a:loose")).toMatchObject({ changed: true, state: "accepted" });
  } finally { store.close(); }
});

test("milestone gate auto-accepts, can be revoked without losing evidence, and relation refutation questions it", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.saveMilestone({ id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
      title: "Measured", version: 1, status: "approved",
      successCriteria: [{ id: "c", statement: "three records", required: true, measure: { kind: "count", unit: "records", atLeast: 3 } }] });
    store.saveMilestoneRelation({ id: "r", ownerId: "o", workspaceId: "w", fromMilestoneId: "m", toMilestoneId: "m2",
      kind: "informs", status: "approved", evidence: [{ uri: "local://prior", source: "prior", observedAt: new Date().toISOString() }] });
    store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
      intent: "Measure", state: "ready_for_human", riskTier: "milestone", payload: {},
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
    store.transitionWorkOrder("w", "wo", { type: "human.started" }, "start");
    store.transitionWorkOrder("w", "wo", { type: "human.completed" }, "complete", {
      evidence: [{ kind: "record", uri: "local://result", description: "three records support reuse" }]
    });
    const result = {
      verdict: "pass" as const,
      criteriaVerdict: [{ criterionId: "c", met: "met" as const, observed: "3", evidenceQuote: "three records", shortfall: null }],
      contractCoverage: [], unplannedGains: [], improvements: [], incomplete: [],
      flywheelAssessment: [{ relationId: "r", targetMilestoneId: "m2", targetIdentityId: "startup", supports: "advances" as const,
        whatIsNowPossible: "reuse", whatIsStillMissing: "none", evidenceQuote: "support reuse" }],
      gaps: [], proposedNextMilestones: [], blockers: []
    };
    expect(store.applyMilestoneGate("w", "wo", result, ["three records support reuse"], "gate:wo"))
      .toMatchObject({ state: "accepted" });
    expect(store.listEvents("w").some((event) => event.type === "milestone_gate.auto_accepted")).toBe(true);
    // A spent key must not quietly record a second acceptance that never moved the work order.
    expect(() => store.applyMilestoneGate("w", "wo", result, ["three records support reuse"], "gate:wo"))
      .toThrow();
    store.refuteMilestoneRelation("w", "r", "later counterexample", "refute:r");
    expect((store.listWorkOrders("w")[0]?.payload as { autoAcceptance?: { questionedByRelationId?: string } })
      .autoAcceptance?.questionedByRelationId).toBe("r");
    expect(store.revokeAutoAcceptance("w", "wo", "manual audit disagreed", "revoke:wo"))
      .toMatchObject({ state: "evidence_review" });
    expect(store.listEvidenceClaims("w")[0]?.reviewStatus).toBe("submitted");
  } finally { store.close(); }
});

test("revoking auto-acceptance a second time on the same work order does not silently no-op", () => {
  // The bug this pins: `revokeAutoAcceptance` used to be keyed only on the work order id, with no
  // attempt counter. A work order that gets auto-accepted, revoked, re-judged and auto-accepted again
  // is a normal cycle (the milestone gate itself is retried this way), and a second revoke reused the
  // first revoke's idempotency key. `appendEvent` silently no-ops on a repeated key, `transitionWorkOrder`
  // returned `{ changed: false }`, and the caller returned success anyway without checking — the person
  // saw the UI reload and believed the revoke worked, while the ledger never left `accepted`.
  const store = new CrosslineStore(":memory:");
  try {
    store.saveMilestone({ id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
      title: "Measured", version: 1, status: "approved",
      successCriteria: [{ id: "c", statement: "three records", required: true, measure: { kind: "count", unit: "records", atLeast: 3 } }] });
    store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
      intent: "Measure", state: "ready_for_human", riskTier: "milestone", payload: {},
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
    store.transitionWorkOrder("w", "wo", { type: "human.started" }, "start");
    store.transitionWorkOrder("w", "wo", { type: "human.completed" }, "complete", {
      evidence: [{ kind: "record", uri: "local://result", description: "three records support reuse" }]
    });
    const passResult = {
      verdict: "pass" as const,
      criteriaVerdict: [{ criterionId: "c", met: "met" as const, observed: "3", evidenceQuote: "three records", shortfall: null }],
      contractCoverage: [], unplannedGains: [], improvements: [], incomplete: [],
      flywheelAssessment: [], gaps: [], proposedNextMilestones: [], blockers: []
    };

    // First cycle: accept, then revoke. This much already worked.
    store.applyMilestoneGate("w", "wo", passResult, ["three records support reuse"], "gate:wo:0");
    expect(store.revokeAutoAcceptance("w", "wo", "first look", "revoke:wo:0")).toMatchObject({ state: "evidence_review" });

    // Re-judged and auto-accepted again — a real second acceptance, keyed on its own attempt.
    store.applyMilestoneGate("w", "wo", passResult, ["three records support reuse"], "gate:wo:1");
    expect(store.listWorkOrders("w")[0]?.state).toBe("accepted");

    // Revoking again with the FIRST revoke's key is the exact collision the bug depended on: it must
    // throw rather than report success, and the work order must still be exactly where it was.
    expect(() => store.revokeAutoAcceptance("w", "wo", "second look, same stale key", "revoke:wo:0"))
      .toThrow("REVOCATION_ALREADY_APPLIED");
    expect(store.listWorkOrders("w")[0]?.state).toBe("accepted");

    // A correctly-numbered second attempt must still work — the fix is the counter, not a refusal to
    // ever revoke twice.
    expect(store.revokeAutoAcceptance("w", "wo", "second look, own key", "revoke:wo:1")).toMatchObject({ state: "evidence_review" });
    expect(store.listEvidenceClaims("w")[0]?.reviewStatus).toBe("submitted");
  } finally { store.close(); }
});

test("milestone gate inconsistency leaves state and evidence untouched", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.saveMilestone({ id: "m", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p",
      title: "Measured", version: 1, status: "approved",
      successCriteria: [{ id: "c", statement: "one result", required: true, measure: { kind: "count", unit: "result", atLeast: 1 } }] });
    store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
      intent: "Measure", state: "ready_for_human", riskTier: "milestone",
      payload: { evidenceContract: [{ kind: "record", description: "a written result", why: "It is what this order promised", required: true }] },
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
    store.transitionWorkOrder("w", "wo", { type: "human.started" }, "start:wo");
    store.transitionWorkOrder("w", "wo", { type: "human.completed" }, "done:wo", {
      evidence: [{ kind: "record", uri: "local://r", description: "no result" }]
    });
    const base = { criteriaVerdict: [{ criterionId: "c", met: "unmet" as const, observed: "nothing shows three records", evidenceQuote: "", shortfall: "3" }],
      unplannedGains: [], improvements: [], incomplete: [], flywheelAssessment: [], gaps: [], proposedNextMilestones: [], blockers: [] };
    // Passing while a contract requirement is unsatisfied is the inconsistency: the verdict answers
    // whether this work order delivered what it promised.
    const inconsistent = { ...base, verdict: "pass" as const,
      contractCoverage: [{ requirement: "a written result", satisfiedBy: null, reasoning: "nothing submitted", quote: "" }] };
    expect(() => store.applyMilestoneGate("w", "wo", inconsistent, ["no result"], "gate:bad"))
      .toThrow("GATE_VERDICT_INCONSISTENT");
    expect(store.listWorkOrders("w")[0]?.state).toBe("evidence_review");
    // Reporting nothing is not a way to pass. The order declares one requirement; an empty
    // contractCoverage used to satisfy `every(...)` vacuously and accept the work on no evidence at all.
    const silent = { ...base, verdict: "pass" as const, contractCoverage: [] };
    expect(() => store.applyMilestoneGate("w", "wo", silent, ["no result"], "gate:silent"))
      .toThrow("GATE_VERDICT_INCONSISTENT");
    expect(store.listWorkOrders("w")[0]?.state).toBe("evidence_review");
    // An unmet milestone criterion is not an inconsistency: a milestone spans many work orders, so
    // this one delivering its contract while the milestone is still short is the normal case — and an
    // unmet criterion carries no quote, because there is nothing in the evidence to quote.
    const delivered = { ...base, verdict: "pass" as const,
      contractCoverage: [{ requirement: "a written result", satisfiedBy: "claim-1", reasoning: "submitted", quote: "no result" }] };
    expect(store.applyMilestoneGate("w", "wo", delivered, ["no result"], "gate:delivered"))
      .toMatchObject({ state: "accepted" });
  } finally { store.close(); }
});

test("the ledger reads back in the order things happened, even within one millisecond", () => {
  const store = new CrosslineStore(":memory:");
  try {
    for (let i = 0; i < 40; i++) {
      store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: `k${i}`, type: "probe", entityId: "e", payload: { i } });
    }
    // These all land in the same millisecond; a UUID tiebreak would shuffle them.
    expect(store.listEvents("w").map((event) => (event.payload as { i: number }).i))
      .toEqual(Array.from({ length: 40 }, (_, i) => i));
  } finally { store.close(); }
});

test("a raw capture can be thrown away with a reason, and a promoted one cannot", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.capture({ id: "c1", ownerId: "o", workspaceId: "w", title: "重复的一条", context: "" }, "cap:c1");
    // A board that silently loses items is worse than one that keeps bad ones, so the reason is required.
    expect(() => store.discardCapture("w", "c1", "   ")).toThrow("DISCARD_REASON_REQUIRED");
    expect(store.listCaptures("w")[0]?.state).toBe("captured");
    expect(store.discardCapture("w", "c1", "和上一条重了")).toEqual({ changed: true });
    expect(store.listCaptures("w")[0]?.state).toBe("discarded");
    expect(store.listEvents("w").find((event) => event.type === "capture.discarded")?.payload)
      .toEqual({ reason: "和上一条重了" });
    // Idempotent: the second click after a slow reload must not append a second reason.
    expect(store.discardCapture("w", "c1", "再来一次")).toEqual({ changed: false });
    expect(store.listEvents("w").filter((event) => event.type === "capture.discarded")).toHaveLength(1);

    // Once promoted the WorkOrder is the live thing; discarding the archived raw text would hide it.
    store.capture({ id: "c2", ownerId: "o", workspaceId: "w", title: "已上板", context: "" }, "cap:c2");
    store.transitionWorkOrder("w", "c2", { type: "analysis.proposed", proposalId: "c2" }, "a:c2");
    expect(() => store.discardCapture("w", "c2", "算了")).toThrow("CAPTURE_IS_ANALYZING");
  } finally { store.close(); }
});
