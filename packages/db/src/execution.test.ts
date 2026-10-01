import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { CrosslineStore } from "./index";

afterEach(() => vi.useRealTimers());

const seed = (store: CrosslineStore, state: string) => store.saveWorkOrder({
  id: "w1", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
  intent: "Decide", state, riskTier: "routine",
  estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: { materialContract: [], evidenceContract: [{ kind: "record", description: "结论记录", required: true }] }
});

test("interrupted time stays distinguishable from actually active time", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store, "ready_for_human");
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:20:00.000Z"));
    store.pauseExecution("w", "w1", "被同事打断");
    vi.setSystemTime(new Date("2026-09-14T09:35:00.000Z"));
    store.resumeExecution("w", "w1");
    vi.setSystemTime(new Date("2026-09-14T10:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });

    const execution = store.listExecutions("w")[0]!;
    expect(execution).toMatchObject({
      workOrderId: "w1", startedAt: "2026-09-14T09:00:00.000Z", endedAt: "2026-09-14T10:00:00.000Z",
      pauseMinutes: 15, durationObserved: true, outcome: "completed"
    });
    // Total wall clock is 60 minutes; only 45 of them were actually worked.
    expect(execution.interruptions).toEqual([
      { pausedAt: "2026-09-14T09:20:00.000Z", resumedAt: "2026-09-14T09:35:00.000Z", reason: "被同事打断" }
    ]);
  } finally { store.close(); }
});

test("completing while paused closes the open interruption instead of losing it", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store, "ready_for_human");
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:10:00.000Z"));
    store.pauseExecution("w", "w1", "临时会议");
    vi.setSystemTime(new Date("2026-09-14T09:40:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1");
    const execution = store.listExecutions("w")[0]!;
    expect(execution.pauseMinutes).toBe(30);
    expect(execution.interruptions).toEqual([
      { pausedAt: "2026-09-14T09:10:00.000Z", resumedAt: "2026-09-14T09:40:00.000Z", reason: "临时会议" }
    ]);
  } finally { store.close(); }
});

test("an existing database whose capture was promoted before this marker is backfilled on open", () => {
  const path = `crossline-promoted-${randomUUID()}.db`;
  try {
    const before = new CrosslineStore(path);
    before.capture({ id: "c", ownerId: "o", workspaceId: "w", title: "Decide", context: "" }, "capture:c");
    // Reproduces the pre-marker shape: on promotion the capture row froze at the WorkOrder's state.
    seed(before, "awaiting_plan_approval");
    before.saveWorkOrder({ ...before.listWorkOrders("w")[0]!, id: "c" });
    before.transitionWorkOrder("w", "c", { type: "plan.approved", approvalId: "human" }, "approve:c");
    expect(before.listCaptures("w")[0]?.state).toBe("captured");
    before.close();

    const after = new CrosslineStore(path);
    expect(after.listCaptures("w")[0]?.state).toBe("promoted");
    after.close();
  } finally {
    // `.v0.bak` too: opening a file database runs the migrations, and the runner backs up first.
    // Leaving it behind littered the repo root with one stray backup per run of this test.
    for (const suffix of ["", "-wal", "-shm", ".v0.bak"]) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
  }
});

test("evidence claims are persisted on completion and only human acceptance marks them accepted", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store, "ready_for_human");
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "link", uri: "https://example.invalid/draft", description: "草稿链接" }] });
    expect(store.listEvidenceClaims("w")).toMatchObject([
      { workOrderId: "w1", kind: "link", uri: "https://example.invalid/draft", description: "草稿链接", reviewStatus: "submitted" }
    ]);
    expect(store.listWorkOrders("w")[0]?.state).toBe("evidence_review");

    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1");
    expect(store.listWorkOrders("w")[0]?.state).toBe("accepted");
    expect(store.listEvidenceClaims("w")[0]?.reviewStatus).toBe("accepted");
  } finally { store.close(); }
});

test("a completion with no evidence is typed as such instead of getting a stand-in claim", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store, "ready_for_human");
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: false });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1");
    expect(store.listEvidenceClaims("w")).toEqual([]);
    expect(store.listExecutions("w")[0]).toMatchObject({ outcome: "completed_without_evidence", durationObserved: false });
    expect(JSON.stringify(store.listEvents("w"))).not.toContain("manual_confirmation");
  } finally { store.close(); }
});

test("blocking closes an open execution and rejects any submitted claims", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store, "ready_for_human");
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    store.transitionWorkOrder("w", "w1", { type: "blocked", reason: "INPUTS_MISSING" }, "block:w1");
    expect(store.listExecutions("w")[0]).toMatchObject({ outcome: "blocked" });
    expect(store.listExecutions("w")[0]?.endedAt).toBeTruthy();

    seed(store, "active");
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-2", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "blocked", reason: "EVIDENCE_INSUFFICIENT" }, "reject:w1");
    expect(store.listEvidenceClaims("w")[0]?.reviewStatus).toBe("rejected");
    expect(store.listWorkOrders("w")[0]?.state).toBe("blocked");
  } finally { store.close(); }
});

test("a replayed idempotency key writes nothing and reports the current state, so one key cannot serve two outcomes", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.capture({ id: "c", ownerId: "o", workspaceId: "w", title: "Decide", context: "" }, "capture:c");
    store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "a0:start");
    // The worker reuses one `:finish` key for both the accepted and blocked outcomes. A rejected
    // finalization must roll its event back, or the blocked path below would silently do nothing.
    expect(() => store.transitionWorkOrder("w", "c", { type: "analysis.accepted", approvalId: "x" }, "a0:finish",
      { proposal: { nonsense: true }, context: {}, audit: { threadId: "t", turnId: "u" } })).toThrow();
    expect(store.transitionWorkOrder("w", "c", { type: "blocked", reason: "ANALYSIS_RUNTIME_FAILED" }, "a0:finish"))
      .toMatchObject({ changed: true, state: "blocked" });
    // Once the key is consumed, a different event under the same key changes nothing and reports
    // the state the entity is actually in — never the state the caller hoped to reach.
    expect(store.transitionWorkOrder("w", "c", { type: "analysis.proposed", proposalId: "c" }, "a0:finish"))
      .toEqual({ changed: false, state: "blocked" });
    expect(store.listCaptures("w")[0]?.state).toBe("blocked");
    expect(store.listEvents("w")).toHaveLength(3);
  } finally { store.close(); }
});

test("checklist answers submitted at completion land on the closing execution, not on any evidence claim", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store, "ready_for_human");
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1", {
      evidence: [{ kind: "record", uri: "local://note-3", description: "结论记录" }],
      checklistAnswers: [{ questionId: "q1", answer: "是" }, { questionId: "q2", answer: "已完成综述" }]
    });
    const execution = store.listExecutions("w")[0]!;
    expect(execution.checklistAnswers).toEqual([
      { questionId: "q1", answer: "是" }, { questionId: "q2", answer: "已完成综述" }
    ]);
    // Not leaked onto the evidence claim's own payload.
    expect(store.listEvidenceClaims("w")[0]).not.toHaveProperty("checklistAnswers");
  } finally { store.close(); }
});

test("completing with no checklist answers leaves the field absent rather than an empty array", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store, "ready_for_human");
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1");
    expect(store.listExecutions("w")[0]?.checklistAnswers).toBeUndefined();
  } finally { store.close(); }
});

test("checklist answers survive a pause-then-complete cycle alongside the closed interruption", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store, "ready_for_human");
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:10:00.000Z"));
    store.pauseExecution("w", "w1", "临时会议");
    vi.setSystemTime(new Date("2026-09-14T09:40:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { checklistAnswers: [{ questionId: "q1", answer: "是" }] });
    const execution = store.listExecutions("w")[0]!;
    expect(execution.checklistAnswers).toEqual([{ questionId: "q1", answer: "是" }]);
    expect(execution.interruptions).toEqual([
      { pausedAt: "2026-09-14T09:10:00.000Z", resumedAt: "2026-09-14T09:40:00.000Z", reason: "临时会议" }
    ]);
  } finally { store.close(); }
});

test("blocking mid-pause closes the interruption so the record never reads as work", () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.saveWorkOrder({ id: "w", ownerId: "o", workspaceId: "w1", identityId: "research", projectId: "p", milestoneId: "m",
      intent: "Draft", state: "ready_for_human", riskTier: "routine", payload: {},
      estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
    store.transitionWorkOrder("w1", "w", { type: "human.started" }, "s", { durationObserved: true });
    store.pauseExecution("w1", "w", "去开会");
    store.transitionWorkOrder("w1", "w", { type: "blocked", reason: "INPUT_MISSING" }, "b");
    const execution = store.listExecutions("w1")[0]!;
    expect(execution.outcome).toBe("blocked");
    // An interruption left open would make wall-clock minus pauseMinutes count the whole pause as work.
    expect(execution.interruptions.every((item) => item.resumedAt)).toBe(true);
  } finally { store.close(); }
});
