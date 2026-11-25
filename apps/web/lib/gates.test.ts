import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { GATE_CONFIRMED, GATE_JUDGED, GATE_OVERRIDDEN, type GateJudgedPayload } from "@crossline/core";

vi.mock("server-only", () => ({}));
const { answerGateCheck, gateCheckAsks, loadGateReview, overrideGate, reportSetback } = await import("./gates");
const { TEST_CTX } = await import("./test-support");

/** The execution gates' web half (docs/plans/execution-gates-1124.md §四): asked judgements, overrides, the weekly review's numbers. */
const NOW = new Date();
const store = () => globalThis.crosslineStore!;
const judge = (id: string, gate: GateJudgedPayload["gate"], subject: GateJudgedPayload["subject"], verdict: string, extra: Partial<GateJudgedPayload> = {}) => {
  const payload: GateJudgedPayload = { gate, subject, run: 1, model: "m", effort: "medium", promptVersion: "v1", inputDigest: { sha256: "0", summary: "" }, asked: false,
    output: { verdict, confidence: "medium", evidence: [{ kind: "file", ref: "draft.pdf", quote: "已发送给导师", at: NOW.toISOString() }], reason: "没有发送记录",
      ifWrong: { harm: "external", fixable: "after_submit" }, detail: {} }, ...extra };
  return store().appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, type: GATE_JUDGED, entityId: subject.id, idempotencyKey: id, payload }).eventId;
};

beforeEach(() => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  store().saveWorkOrder({ id: "send-draft", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "paper", milestoneId: "",
    intent: "把初稿发给导师", state: "approved", riskTier: "routine", payload: {},
    estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45, source: "llm_prior", observationCount: 0, confidence: "high" } });
});
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("only an asked judgement becomes a gate_check; answering with another verdict records it and the card goes", () => {
  judge("quiet", "completion", { kind: "task", id: "other" }, "done");
  const asked = judge("asked", "completion", { kind: "task", id: "send-draft" }, "planned", { asked: true });
  const asks = gateCheckAsks(TEST_CTX, NOW);
  expect(asks.map((ask) => ask.entityId)).toEqual([asked]);
  expect(asks[0]!.title).toContain("把初稿发给导师");
  expect(asks[0]!.options.map((option) => option.id)).toEqual(["right", "to:done", "to:submitted", "to:waiting"]);
  expect(answerGateCheck(TEST_CTX, asks[0]!, "to:submitted", "邮件在另一个邮箱")).toEqual({ ok: true });
  expect(store().listEvents(TEST_CTX.workspaceId, { type: GATE_OVERRIDDEN })[0]!.payload).toMatchObject({ judgedId: asked, from: "planned", to: "submitted", note: "邮件在另一个邮箱" });
  expect(gateCheckAsks(TEST_CTX, NOW)).toEqual([]);
});

test("a confirmation is not an override; an unknown verdict is refused", () => {
  const id = judge("j", "completion", { kind: "task", id: "send-draft" }, "planned", { asked: true });
  expect(overrideGate(TEST_CTX, { judgedId: id, to: "maybe" })).toEqual({ ok: false, code: "GATE_VERDICT_UNKNOWN" });
  expect(overrideGate(TEST_CTX, { judgedId: id, to: "planned" })).toEqual({ ok: true });
  expect(store().listEvents(TEST_CTX.workspaceId, { type: GATE_CONFIRMED })).toHaveLength(1);
  expect(store().listEvents(TEST_CTX.workspaceId, { type: GATE_OVERRIDDEN })).toHaveLength(0);
  expect(gateCheckAsks(TEST_CTX, NOW)).toEqual([]);
});

test("the weekly review lists a P1 task pressed 完成 without evidence, and every override", () => {
  judge("p1", "priority", { kind: "task", id: "send-draft" }, "p1_external");
  const done = judge("c", "completion", { kind: "task", id: "send-draft" }, "planned");
  store().appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, type: "human.completed", entityId: "send-draft", idempotencyKey: "hc", payload: { workOrderId: "send-draft" } });
  overrideGate(TEST_CTX, { judgedId: done, to: "waiting", note: "等导师回" });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString(), until = new Date(Date.now() + 60_000).toISOString();
  const review = loadGateReview(TEST_CTX, since, until, NOW);
  expect(review.claimedNoEvidence).toEqual([{ id: "send-draft", title: "把初稿发给导师", verdict: "waiting", reason: "没有发送记录" }]);
  expect(review.overrides).toHaveLength(1);
  expect(review.stats.find((row) => row.gate === "completion")).toMatchObject({ judged: 1, overridden: 1, agreedButOverridden: 1 });
});

test("a setback in the person's words is recorded for the worker; an empty one is refused", () => {
  expect(reportSetback(TEST_CTX, "  ")).toEqual({ ok: false, code: "SETBACK_EMPTY" });
  expect(reportSetback(TEST_CTX, "ISLPED 被拒").ok).toBe(true);
  expect(store().listEvents(TEST_CTX.workspaceId, { type: "setback.reported" })[0]!.payload).toEqual({ text: "ISLPED 被拒" });
});
