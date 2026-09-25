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
