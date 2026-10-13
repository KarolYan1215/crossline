import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "./index";

afterEach(() => vi.useRealTimers());

const BASELINE = { p25Minutes: 15, p50Minutes: 30, p85Minutes: 50 };

const seed = (store: CrosslineStore, family: string | undefined = "deep_work") => store.saveWorkOrder({
  id: "w1", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
  intent: "写一段分析", state: "ready_for_human", riskTier: "routine",
  estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: { materialContract: [], evidenceContract: [{ kind: "record", description: "结论记录", required: true }],
    ...(family ? { family } : {}) }
});

test("a full lifecycle with a real timer and a resolved baseline records exactly one observation", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:20:00.000Z"));
    store.pauseExecution("w", "w1", "被同事打断");
    vi.setSystemTime(new Date("2026-09-14T09:35:00.000Z"));
    store.resumeExecution("w", "w1");
    vi.setSystemTime(new Date("2026-09-14T10:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1",
      { durationCalibrationBaseline: BASELINE });

    const rows = store.listDurationObservations("w", "research", "deep_work");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workOrderId: "w1", identityId: "research", family: "deep_work",
      wallClockMinutes: 60, pauseMinutes: 15, observedMinutes: 45, interruptionDominant: false,
      baselineP25Minutes: 15, baselineP50Minutes: 30, baselineP85Minutes: 50, observedAt: "2026-09-14T10:00:00.000Z"
    });
  } finally { store.close(); }
});

test("re-accepting after a revoke reuses the same closed execution and does not duplicate the observation", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:30:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1",
      { durationCalibrationBaseline: BASELINE });
    store.transitionWorkOrder("w", "w1", { type: "acceptance.revoked", reason: "重新判定" }, "revoke:w1");
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "reaccept:w1",
      { durationCalibrationBaseline: BASELINE });

    expect(store.listDurationObservations("w", "research", "deep_work")).toHaveLength(1);
  } finally { store.close(); }
});

test("interruption dominating wall clock is recorded and flagged, not excluded at write time", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:05:00.000Z"));
    store.pauseExecution("w", "w1", "长时间中断");
    vi.setSystemTime(new Date("2026-09-14T09:45:00.000Z"));
    store.resumeExecution("w", "w1");
    vi.setSystemTime(new Date("2026-09-14T09:50:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1",
      { durationCalibrationBaseline: BASELINE });

    const [row] = store.listDurationObservations("w", "research", "deep_work");
    // 50 minutes wall clock, 40 paused, 10 active — paused time is the majority.
    expect(row).toMatchObject({ wallClockMinutes: 50, pauseMinutes: 40, observedMinutes: 10, interruptionDominant: true });
  } finally { store.close(); }
});

test("no observation is recorded without a family on the WorkOrder's payload", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store, undefined);
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1",
      { durationCalibrationBaseline: BASELINE });

    expect(store.listDurationObservations("w", "research", "deep_work")).toEqual([]);
  } finally { store.close(); }
});

test("no observation is recorded without a caller-supplied baseline", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store);
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1");

    expect(store.listDurationObservations("w", "research", "deep_work")).toEqual([]);
  } finally { store.close(); }
});

test("a backfilled completion with no observed timer never produces an observation", () => {
  const store = new CrosslineStore(":memory:");
  try {
    seed(store);
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: false });
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1",
      { durationCalibrationBaseline: BASELINE });

    expect(store.listDurationObservations("w", "research", "deep_work")).toEqual([]);
  } finally { store.close(); }
});

// Work done in two sittings (sent back after the first, finished in a second) used to be recorded as the
// second sitting alone — and a re-accept after new work inserted a second row, counting minutes twice.
test("two sittings of one order are summed into one observation, replaced rather than duplicated", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:40:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:1",
      { durationCalibrationBaseline: BASELINE });
    expect(store.listDurationObservations("w", "research", "deep_work").map((row) => row.observedMinutes)).toEqual([40]);

    store.transitionWorkOrder("w", "w1", { type: "acceptance.revoked", reason: "还差一张图" }, "revoke:1");
    store.transitionWorkOrder("w", "w1", { type: "blocked", reason: "补图" }, "block:1");
    store.transitionWorkOrder("w", "w1", { type: "plan.approved", approvalId: "human" }, "approve:2");
    store.transitionWorkOrder("w", "w1", { type: "materials.not_required" }, "nomat:2");
    vi.setSystemTime(new Date("2026-09-15T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:2", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-15T09:25:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:2",
      { evidence: [{ kind: "record", uri: "local://note-2", description: "结论记录" }] });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:2",
      { durationCalibrationBaseline: BASELINE });

    const rows = store.listDurationObservations("w", "research", "deep_work");
    expect(rows.map((row) => row.observedMinutes)).toEqual([65]);
    expect(rows[0]!.observedAt).toBe("2026-09-15T09:25:00.000Z");
  } finally { store.close(); }
});

// An offline session synced hours later keeps the device's times; a replayed time can never run backwards.
test("replayed execution times are kept, and clamped so an end never precedes its start", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T18:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1",
      { durationObserved: true, occurredAt: "2026-09-14T14:00:00.000Z" });
    store.pauseExecution("w", "w1", "吃饭", "2026-09-14T14:30:00.000Z");
    store.resumeExecution("w", "w1", "2026-09-14T14:10:00.000Z");
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }], occurredAt: "2026-09-14T15:00:00.000Z" });
    const execution = store.listExecutions("w", "w1")[0]!;
    expect(execution.startedAt).toBe("2026-09-14T14:00:00.000Z");
    expect(execution.endedAt).toBe("2026-09-14T15:00:00.000Z");
    expect(execution.interruptions[0]).toMatchObject({ pausedAt: "2026-09-14T14:30:00.000Z", resumedAt: "2026-09-14T14:30:00.000Z" });
  } finally { store.close(); }
});

// The calibration learns the model's own error, so the observation keeps the estimate the analysis wrote.
test("an observation keeps the analysis's own estimate and where the minutes came from; a one-tap report counts", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:05:00.000Z"));
    // The person worked away from the timer and says it took about an hour.
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }], reportedMinutes: 60, reportedSource: "one_tap" });
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1",
      { durationCalibrationBaseline: BASELINE });
    expect(store.listDurationObservations("w", "research", "deep_work")[0]).toMatchObject({
      observedMinutes: 60, actualSource: "one_tap", llmP50Minutes: 20, llmP85Minutes: 40, interruptionDominant: false });
  } finally { store.close(); }
});

test("finishing the work records how long it took, even before (or without) the evidence being accepted", () => {
  // Real ledger, 2026-09-26 → 10-10: two timed sessions, zero observations, because only acceptance wrote one and nothing had
  // passed the gate yet. The time spent is a fact at completion; what the gate later thinks of the evidence does not change it.
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  try {
    seed(store);
    vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
    vi.setSystemTime(new Date("2026-09-14T09:40:00.000Z"));
    store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
      { evidence: [{ kind: "record", uri: "local://note-1", description: "结论记录" }], durationCalibrationBaseline: BASELINE });
    expect(store.listDurationObservations("w", "research", "deep_work")).toMatchObject([{ observedMinutes: 40 }]);
    // Accepting later adds nothing: same session, same minutes.
    store.transitionWorkOrder("w", "w1", { type: "evidence.accepted", approvalId: "human" }, "accept:w1", { durationCalibrationBaseline: BASELINE });
    expect(store.listDurationObservations("w", "research", "deep_work")).toHaveLength(1);
  } finally { store.close(); }
});

test("sessions confirmed after the fact count towards the observation written at completion, marked one_tap", () => {
  const store = new CrosslineStore(":memory:");
  seed(store);
  store.recordConfirmedSession("w", "w1", "o", { startedAt: "2026-09-14T09:00:00.000Z", endedAt: "2026-09-14T10:00:00.000Z", minutes: 90, source: "one_tap", key: "c1" });
  store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true, occurredAt: "2026-09-15T09:00:00.000Z" });
  store.transitionWorkOrder("w", "w1", { type: "human.completed" }, "done:w1",
    { occurredAt: "2026-09-15T09:40:00.000Z", reportedMinutes: 30, reportedSource: "one_tap", durationCalibrationBaseline: BASELINE });
  const [observation] = store.listDurationObservations("w", "research", "deep_work");
  expect(observation).toMatchObject({ observedMinutes: 120, actualSource: "one_tap" });
});
