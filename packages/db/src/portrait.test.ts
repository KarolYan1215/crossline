import { afterEach, expect, test, vi } from "vitest";
import { scheduledMinutesKey } from "@crossline/core";
import { CrosslineStore, type StepPlanInput } from "./index";
import { sayDoFor } from "./portrait";

afterEach(() => vi.useRealTimers());

const NOW = new Date("2026-10-12T12:00:00.000Z");
const day = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const at = (daysAgo: number, clock: string) => new Date(`${day(daysAgo)}T${clock}:00.000Z`);

const order = (store: CrosslineStore, id: string) => store.saveWorkOrder({
  id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m", intent: id, state: "ready_for_human", riskTier: "routine",
  estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: { materialContract: [], evidenceContract: [{ kind: "record", description: "记录", required: true }] }
});
const step = (id: string, dueBy: string) => ({ id, role: "do", title: id, deliverable: "d", doneCriterion: "c", share: 0.25,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], notBefore: "", dueBy, schedulable: true, executor: "human" as const, tickOutcome: "" });
const plan = (steps: StepPlanInput["steps"]): StepPlanInput => ({ archetypeId: "problem_set", quantity: { basis: "题目数", amount: 4, unit: "题" }, rationale: "r", steps });

test("the does side is read from executions, plans, steps, gate outcomes and waiting answers — and only for its own workspace", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const store = new CrosslineStore(":memory:");
  const clock = (time: Date) => vi.setSystemTime(time);
  // Ten sessions, the first twenty days ago: four handed in (two then accepted), six stopped as blocked.
  for (let index = 0; index < 10; index += 1) {
    const id = `o${index + 1}`;
    const daysAgo = 20 - index * 2;
    clock(at(daysAgo, "08:00")); order(store, id);
    clock(at(daysAgo, "09:00")); store.transitionWorkOrder("w", id, { type: "human.started" }, `start:${id}`, { durationObserved: true });
    if (id === "o1") { store.pauseExecution("w", id, "打断", at(daysAgo, "09:20").toISOString()); store.resumeExecution("w", id, at(daysAgo, "09:30").toISOString()); }
    if (index < 4) {
      clock(at(daysAgo, "10:00"));
      store.transitionWorkOrder("w", id, { type: "human.completed" }, `done:${id}`, { evidence: [{ kind: "record", uri: `local://${id}`, description: "记录" }] });
      if (index < 2) store.transitionWorkOrder("w", id, { type: "evidence.accepted" }, `accept:${id}`);
    } else {
      clock(at(daysAgo, "09:30")); store.transitionWorkOrder("w", id, { type: "blocked", reason: "x" }, `block:${id}`);
    }
  }
  // Planned on two days: o1's day 90 minutes, o2's day 60 + 30. Worked on those days: o1 50 (10 paused), o2 60.
  store.setSetting("w", scheduledMinutesKey(day(20)), JSON.stringify({ o1: 90 }));
  store.setSetting("w", scheduledMinutesKey(day(18)), JSON.stringify({ o2: 60, other: 30 }));
  // Steps: one done before its day, one done late, one overdue and not done; one still ahead and one skipped do not count.
  clock(at(10, "08:00"));
  store.saveStepPlan("w", "o1", plan([step("a", day(5)), step("b", day(5)), step("c", day(2)), step("d", day(-3)), step("e", day(6))]), "o", "initial");
  clock(at(6, "10:00")); store.updateStepProgress("w", "o1", "v1s1", { status: "done" }, "o", "user");
  clock(at(3, "10:00")); store.updateStepProgress("w", "o1", "v1s2", { status: "done" }, "o", "user");
  store.updateStepProgress("w", "o1", "v1s5", { status: "skipped" }, "o", "user");
  // Waiting: one answered the day after its follow-up day, one four days after.
  for (const [id, followUp] of [["wait-1", day(8)], ["wait-2", day(8)]] as const) {
    store.saveWaitingItem({ id, ownerId: "o", workspaceId: "w", title: id, who: "x", expectedAt: followUp, approximate: false, followUpAt: followUp, state: "open", blocks: [], source: "analysis" });
  }
  clock(at(7, "10:00")); store.answerWaitingItem("w", "wait-1", { kind: "arrived" }, "o");
  clock(at(4, "10:00")); store.answerWaitingItem("w", "wait-2", { kind: "arrived" }, "o");
  clock(NOW);

  const reading = sayDoFor(store, "w", NOW);
  expect(reading).toMatchObject({ sufficient: true, days: 20, executions: 10 });
  expect(reading.does).toEqual({ plan: 61, on_time: 33, follow_through: 40, acceptance: 50, waiting: 50 });
  expect(sayDoFor(store, "w2", NOW)).toEqual({ sufficient: false, days: 0, executions: 0,
    does: { plan: null, on_time: null, follow_through: null, acceptance: null, waiting: null } });
  store.close();
});
