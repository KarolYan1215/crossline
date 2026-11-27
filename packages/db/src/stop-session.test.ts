import { afterEach, expect, test, vi } from "vitest";
import { sessionWorkedMinutes } from "@crossline/core";
import { CrosslineStore } from "./index";

afterEach(() => vi.useRealTimers());

const seed = (store: CrosslineStore) => store.saveWorkOrder({
  id: "w1", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
  intent: "批准实测参数映射", state: "ready_for_human", riskTier: "routine",
  estimate: { p25Minutes: 60, p50Minutes: 90, p85Minutes: 180, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: { materialContract: [], evidenceContract: [] }
});

const open = (store: CrosslineStore) => store.listExecutions("w", "w1").find((item) => !item.endedAt)!;

test("a session left running is cut where the work ended: paused from then, later pauses dropped, still resumable", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  seed(store);
  vi.setSystemTime(new Date("2026-11-11T21:37:00.000Z"));
  store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
  // 结束 (a pause) pressed five hours later: what the owner's ledger held on 2026-11-11.
  vi.setSystemTime(new Date("2026-11-12T02:58:00.000Z"));
  store.pauseExecution("w", "w1", "本次计时结束");
  vi.setSystemTime(new Date("2026-11-12T03:24:00.000Z"));
  expect(sessionWorkedMinutes(open(store), Date.now())).toBe(321);

  // Corrected: the work ended at 21:45 (eight minutes in).
  expect(store.stopSessionAt("w", "w1", "2026-11-11T21:45:00.000Z", "更正", new Date().toISOString())).toEqual({ changed: true, stoppedAt: "2026-11-11T21:45:00.000Z" });
  expect(open(store).interruptions).toEqual([{ pausedAt: "2026-11-11T21:45:00.000Z", reason: "更正" }]);
  expect(sessionWorkedMinutes(open(store), Date.now())).toBe(8);
  // The same correction again changes nothing; a stop after the session's current pause keeps the earlier pause.
  expect(store.stopSessionAt("w", "w1", "2026-11-11T21:45:00.000Z", "更正", new Date().toISOString()).changed).toBe(false);
  expect(store.stopSessionAt("w", "w1", "2026-11-11T23:00:00.000Z", "更正", new Date().toISOString())).toMatchObject({ changed: false, stoppedAt: "2026-11-11T21:45:00.000Z" });
  expect(store.listEvents("w", { type: "execution.changed", change: "stopped_at", entityId: "w1" })).toHaveLength(1);

  // Resuming and completing work as after any pause.
  vi.setSystemTime(new Date("2026-11-12T03:30:00.000Z"));
  store.resumeExecution("w", "w1");
  vi.setSystemTime(new Date("2026-11-12T03:40:00.000Z"));
  expect(sessionWorkedMinutes(open(store), Date.now())).toBe(18);
});

test("a stop before the session began or after now is clamped to the session; a pause straddling the stop stays open from its own start", () => {
  const store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  seed(store);
  vi.setSystemTime(new Date("2026-11-11T10:00:00.000Z"));
  store.transitionWorkOrder("w", "w1", { type: "human.started" }, "start:w1", { durationObserved: true });
  vi.setSystemTime(new Date("2026-11-11T10:30:00.000Z"));
  store.pauseExecution("w", "w1", "午饭");
  vi.setSystemTime(new Date("2026-11-11T11:30:00.000Z"));
  store.resumeExecution("w", "w1");
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  // Work ended during lunch: the lunch pause is reopened, nothing after it counts.
  expect(store.stopSessionAt("w", "w1", "2026-11-11T11:00:00.000Z", "早停了", new Date().toISOString()).stoppedAt).toBe("2026-11-11T10:30:00.000Z");
  expect(sessionWorkedMinutes(open(store), Date.now())).toBe(30);
  expect(() => store.stopSessionAt("w", "nope", "2026-11-11T11:00:00.000Z", "x")).toThrow("NO_ACTIVE_EXECUTION");
  expect(store.stopSessionAt("w", "w1", "2026-11-11T09:00:00.000Z", "x", new Date().toISOString()).stoppedAt).toBe("2026-11-11T10:00:00.000Z");
});
