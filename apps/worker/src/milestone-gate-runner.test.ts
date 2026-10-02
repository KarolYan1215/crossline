import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createMilestoneGate, pendingMilestoneGates, MILESTONE_GATE_SKILL } from "./milestone-gate-runner";
import { fakeRuntime, recordedAnswer } from "./testing/fake-runtime";

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

/**
 * The gate Skill itself, which nothing had ever invoked from a test.
 *
 * It is the thing that accepts work without asking, so the three ways it was wrong all needed pinning:
 * it could be passed by reporting nothing, it demanded a verbatim quote for a criterion the evidence
 * says nothing about, and a spent idempotency key wrote an acceptance audit for a transition that
 * never happened.
 */
function readyToJudge(): void {
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "写材料", state: "ready_for_human", riskTier: "milestone",
    payload: { evidenceContract: [{ kind: "record", description: "结论记录", why: "本作业的交付物", required: true }] },
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.completed" }, "done:w1", {
    evidence: [{ kind: "record", uri: "local://r", description: "我写完了结论记录" }]
  });
}

const judgeWith = (answers: string[]) => {
  const { rpc, turns } = fakeRuntime(answers, MILESTONE_GATE_SKILL);
  return { turns, judge: createMilestoneGate(store, WORKSPACE, "C:\repo", () => rpc) };
};

test("the gate accepts the work order while reporting the milestone criterion as unmet", async () => {
  readyToJudge();
  const { judge } = judgeWith([recordedAnswer("gate-pass-with-unmet-criterion")]);

  expect(await judge("w1")).toMatchObject({ state: "accepted", verdict: "pass" });
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("accepted");
  // An unmet criterion carries no quote, because there is nothing in the evidence to quote. Demanding
  // one left the model a choice between inventing a quote and failing the whole run.
  const judged = store.listEvents(WORKSPACE).find((event) => event.type === "milestone_gate.judged");
  expect((judged?.payload as { criteriaVerdict: Array<{ met: string }> }).criteriaVerdict[0]?.met).toBe("unmet");
  // Delivered is not the same as achieved, and the ledger keeps them apart.
  expect(store.listEvents(WORKSPACE).some((event) => event.type === "milestone_gate.auto_accepted")).toBe(true);
});

test("the gate cannot be passed by reporting nothing", async () => {
  readyToJudge();
  const { judge, turns } = judgeWith([recordedAnswer("gate-pass-reporting-nothing")]);

  // `contractCoverage.every(...)` is satisfied by an empty array, so omitting every requirement used
  // to buy a free pass on an order that declared one.
  expect(await judge("w1")).toMatchObject({ state: "blocked", code: "GATE_VERDICT_INCONSISTENT" });
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("evidence_review");
  expect(store.listEvents(WORKSPACE).some((event) => event.type === "milestone_gate.auto_accepted")).toBe(false);
  // Asked to fix it twice before giving up.
  expect(turns()).toBe(3);
});

test("a failed gate run is recorded so the timer stops re-spending on it", async () => {
  readyToJudge();
  const { judge } = judgeWith([recordedAnswer("gate-pass-reporting-nothing")]);
  await judge("w1");
  expect(pendingMilestoneGates(store, WORKSPACE)).toEqual([]);
});

test("a refusal before the model runs is recorded too, and repeats after a retry are not swallowed", async () => {
  // An archived milestone is refused without ever calling the model. That used to be returned to the
  // caller and nowhere else, so the approvals page said 「等待里程碑闸门」 about a verdict already given.
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 2, status: "archived" });
  const { judge } = judgeWith([]);
  expect(await judge("w1")).toMatchObject({ state: "blocked", code: "MILESTONE_NOT_FOUND" });
  const blocks = () => store.listEvents(WORKSPACE, { type: "milestone_gate.blocked", entityId: "w1" });
  expect(blocks()).toHaveLength(1);
  expect(blocks()[0]?.payload).toMatchObject({ code: "MILESTONE_NOT_FOUND" });
  append("milestone_gate.retry_requested");
  await judge("w1");
  expect(blocks()).toHaveLength(2);
});

test("a milestone with no criteria is still judged on the order's own contract, and records no progress", async () => {
  // This is the first thing every new account hits: its starter milestones state no criteria, and the
  // gate used to stop every bound order at the very last step. `pass` is about the order's own contract.
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 2, status: "approved" });
  readyToJudge();
  const answer = JSON.parse(recordedAnswer("gate-pass-with-unmet-criterion")) as { criteriaVerdict: unknown[] };
  answer.criteriaVerdict = [];
  const { judge } = judgeWith([JSON.stringify(answer)]);

  expect(await judge("w1")).toMatchObject({ state: "accepted", verdict: "pass" });
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("accepted");
});

test("an optional requirement left unsatisfied does not hold pass back", async () => {
  const contract = (secondRequired: boolean) => [
    { kind: "record", description: "结论记录", why: "本作业的交付物", required: true },
    { kind: "record", description: "补充的原始日志", why: "佐证", required: secondRequired }
  ];
  const answerFor = (missingSecond: boolean) => {
    const answer = JSON.parse(recordedAnswer("gate-pass-with-unmet-criterion")) as { contractCoverage: unknown[] };
    answer.contractCoverage = [
      ...answer.contractCoverage,
      { requirement: "补充的原始日志", satisfiedBy: missingSecond ? null : "claim-1", reasoning: missingSecond ? "没有提交" : "已提交",
        quote: missingSecond ? "" : "我写完了结论记录" }
    ];
    return JSON.stringify(answer);
  };
  const setContract = (secondRequired: boolean) => {
    readyToJudge();
    const order = store.listWorkOrders(WORKSPACE)[0]!;
    store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), evidenceContract: contract(secondRequired) } });
  };

  setContract(false);
  expect(await judgeWith([answerFor(true)]).judge("w1")).toMatchObject({ state: "accepted", verdict: "pass" });
});

test("a required requirement left unsatisfied cannot be passed", async () => {
  readyToJudge();
  const order = store.listWorkOrders(WORKSPACE)[0]!;
  store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), evidenceContract: [
    { kind: "record", description: "结论记录", why: "本作业的交付物", required: true },
    { kind: "record", description: "补充的原始日志", why: "也是交付物", required: true }
  ] } });
  const answer = JSON.parse(recordedAnswer("gate-pass-with-unmet-criterion")) as { contractCoverage: unknown[] };
  answer.contractCoverage = [...answer.contractCoverage,
    { requirement: "补充的原始日志", satisfiedBy: null, reasoning: "没有提交", quote: "" }];
  const { judge } = judgeWith([JSON.stringify(answer), JSON.stringify(answer), JSON.stringify(answer)]);
  expect(await judge("w1")).toMatchObject({ state: "blocked", code: "GATE_VERDICT_INCONSISTENT" });
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("evidence_review");
});
