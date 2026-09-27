import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createWeeklyInsight, WEEKLY_INSIGHT_SKILL, buildWeeklyInsightContext } from "./weekly-insight-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, WEEKLY_INSIGHT_SKILL);
const WORKSPACE = "workspace-a";
let store: CrosslineStore;
const now = new Date("2026-09-27T12:00:00.000Z");

const seedOrder = (id: string) => store.saveWorkOrder({
  id, ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p", milestoneId: "",
  intent: `写作任务 ${id}`, state: "ready_for_human", riskTier: "routine",
  estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: { family: "deep_work" }
});

/** One full start-to-completion execution on the given day, via the real transition path — there is
 * no direct "insert an execution row" method, on purpose: an execution only ever exists because a
 * WorkOrder was actually run through, not because a row was fabricated. */
const runOneDay = (id: string, day: string) => {
  vi.setSystemTime(new Date(`2026-09-${day}T10:00:00.000Z`));
  store.transitionWorkOrder(WORKSPACE, id, { type: "human.started" }, `start:${id}`, { durationObserved: true });
  vi.setSystemTime(new Date(`2026-09-${day}T11:00:00.000Z`));
  store.transitionWorkOrder(WORKSPACE, id, { type: "human.completed" }, `done:${id}`, { evidence: [] });
};

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  seedOrder("w1"); seedOrder("w2"); seedOrder("w3");
  runOneDay("w1", "21"); runOneDay("w2", "22"); runOneDay("w3", "23");
  // Real timers from here: `runCodexSkill`'s own timeout/abort machinery needs real ones to progress,
  // and every test below either calls it or does not care which clock is running.
  vi.useRealTimers();
});
afterEach(() => { vi.useRealTimers(); store.close(); });

test("buildWeeklyInsightContext reads the real ledger for the trailing week", () => {
  const context = buildWeeklyInsightContext(store, WORKSPACE, now);
  expect(context.executions).toHaveLength(3);
  expect(context.executions[0]?.identityId).toBe("research");
});

test("three real observations produce a written insight_proposal event", async () => {
  const ids = buildWeeklyInsightContext(store, WORKSPACE, now).executions.map((item) => item.id);
  const result = {
    insightProposals: [{ id: "insight-1", claim: "深度写作耗时经常超过 p50", observationCount: 3, period: "week",
      supportingEventIds: ids, counterexampleEventIds: [], proposedOverlayPatch: "上调 p50" }],
    estimateUpdates: [], retentionActions: [], blockers: []
  };
  const { rpc } = fakeRuntime([JSON.stringify(result)]);
  const run = createWeeklyInsight(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await run(now);
  expect(outcome).toMatchObject({ state: "ready" });
  expect(store.listEvents(WORKSPACE, { type: "weekly_review.insight_proposal" })).toHaveLength(1);
});

test("fewer than three executions is a blocker before any Skill call happens", async () => {
  const empty = new CrosslineStore(":memory:");
  const run = createWeeklyInsight(empty, WORKSPACE, "C:\\repo", () => fakeRuntime(["{}"]).rpc);
  const outcome = await run(now);
  expect(outcome).toMatchObject({ state: "blocked", code: "WEEKLY_INSIGHT_INSUFFICIENT_EVIDENCE" });
  empty.close();
});
