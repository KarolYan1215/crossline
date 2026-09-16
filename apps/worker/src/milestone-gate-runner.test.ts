import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { pendingMilestoneGates } from "./milestone-gate-runner";

const WORKSPACE = "personal-crossline";
let store: CrosslineStore;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 1, status: "approved",
    successCriteria: [{ id: "c", statement: "一条", required: true, measure: { kind: "count", unit: "份", atLeast: 1 } }] });
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "写材料", state: "evidence_review", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
});
afterEach(() => store.close());

const append = (type: string) => store.appendEvent({
  ownerId: "local-owner", workspaceId: WORKSPACE, idempotencyKey: `${type}:${Date.now()}:${Math.random()}`,
  type, entityId: "w1", payload: {}
});

test("a gate run that failed is not retried on every tick, and asking reopens it", () => {
  expect(pendingMilestoneGates(store, WORKSPACE)).toEqual(["w1"]);
  append("milestone_gate.blocked");
  expect(pendingMilestoneGates(store, WORKSPACE)).toEqual([]);
  append("milestone_gate.retry_requested");
  expect(pendingMilestoneGates(store, WORKSPACE)).toEqual(["w1"]);
});

test("a revoked acceptance is not re-judged and re-accepted behind the person's back", () => {
  // The order returns to `evidence_review` with the same evidence, so the gate would reach the same
  // verdict and silently undo the revocation on the next tick.
  append("milestone_gate.auto_acceptance_revoked");
  expect(pendingMilestoneGates(store, WORKSPACE)).toEqual([]);
  append("milestone_gate.retry_requested");
  expect(pendingMilestoneGates(store, WORKSPACE)).toEqual(["w1"]);
});

// There is deliberately no "work order without a milestone" case here: `work_orders.milestone_id` is
// NOT NULL, so such a row cannot exist. The unbound branch on the approvals page is unreachable today.
