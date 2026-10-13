import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { ModelSolver, PlanningInput } from "@crossline/planner";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, planToday, planningInputFor, saveSchedulePreferences, scheduleHashOf, withPreview } from "./crossline";
import { configureOptimal, OPTIMAL_SETTING, optimalFor, optimalIdle, requestOptimal } from "./optimal-schedule";
import { TEST_CTX } from "./test-support";
import { blocksToPublish, OPTIMAL_WAIT_MS } from "./calendar-publish";

const highs = (createRequire(import.meta.url)("highs") as typeof import("highs").default)();
const NOW = "2026-09-18T13:00:00.000Z";
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];

/** A real HiGHS behind a counter; `gate` holds every solve until released. */
function countingSolver(gate?: Promise<void>) {
  const calls: string[] = [];
  const solve: ModelSolver = async (model, limit) => {
    calls.push(model);
    await gate;
    return (await highs).solve(model, { output_flag: false, time_limit: limit });
  };
  return { calls, solve };
}
const solvedHashes = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls
  .map(([line]) => JSON.parse(String(line)) as { type: string; workspaceId: string })
  .filter((entry) => entry.type === "solver.optimal");

afterEach(async () => {
  await optimalIdle();
  configureOptimal({ enabled: false });
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  return store;
}
const input = (title: string): PlanningInput => ({ now: new Date(NOW), horizonDays: 1, frozenBlocks: [],
  tasks: [{ id: title, title, estimate: { p25Minutes: 40, p50Minutes: 60, p85Minutes: 80, confidence: "high" }, inputsReady: true, deadlineTier: 3 }],
  availability: [{ day: "2026-09-18", start: "2026-09-18T13:00:00.000Z", end: "2026-09-18T18:00:00.000Z", energy: "high" }] });

test("a miss shows the greedy plan, asks once, and the next read of the same input gets the cached optimal plan", async () => {
  const store = setup();
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human" });
  const solver = countingSolver();
  configureOptimal({ enabled: true, solver: solver.solve });
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await loadCurrentPlan(TEST_CTX);
  await loadCurrentPlan(TEST_CTX);
  await optimalIdle();
  expect(solvedHashes(log)).toHaveLength(1);
  const entry = JSON.parse(store.getSetting(TEST_CTX.workspaceId, OPTIMAL_SETTING)!);
  expect(optimalFor(TEST_CTX, entry.hash)).toBeDefined();
  const calls = solver.calls.length;
  await loadCurrentPlan(TEST_CTX);
  await optimalIdle();
  expect(solver.calls.length).toBe(calls);
});

test("while one solve runs, three newer requests leave only the last to be solved next", async () => {
  setup();
  let release!: () => void;
  const solver = countingSolver(new Promise((resolve) => { release = resolve; }));
  configureOptimal({ enabled: true, solver: solver.solve });
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  requestOptimal(TEST_CTX, input("a"), "hash-a");
  requestOptimal(TEST_CTX, input("a"), "hash-a");
  requestOptimal(TEST_CTX, input("b"), "hash-b");
  requestOptimal(TEST_CTX, input("c"), "hash-c");
  requestOptimal(TEST_CTX, input("d"), "hash-d");
  release();
  await optimalIdle();
  expect(solvedHashes(log).map((entry) => entry.workspaceId)).toHaveLength(2);
  expect(optimalFor(TEST_CTX, "hash-d")).toBeDefined();
  expect(optimalFor(TEST_CTX, "hash-a")).toBeUndefined();
});

test("a cached plan replaces the greedy one on read, without its blocks that are already over", async () => {
  const store = setup();
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human" });
  const plan = await loadCurrentPlan(TEST_CTX);
  const committed = plan.blocks.filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && !block.id.startsWith("optional:"));
  const { input: planning, instants, currentEnergy } = planningInputFor(TEST_CTX, planToday(TEST_CTX), committed);
  const hash = scheduleHashOf(planning, instants, currentEnergy);
  const taskId = planning.tasks[0]!.id;
  store.setSetting(TEST_CTX.workspaceId, OPTIMAL_SETTING, JSON.stringify({ hash, at: NOW, result: { status: "feasible", solver: "optimal", blockers: [],
    plan: { blocks: [{ taskId, start: "2026-09-18T12:00:00.000Z", end: "2026-09-18T12:30:00.000Z" },
      { taskId, start: "2026-09-18T16:00:00.000Z", end: "2026-09-18T17:00:00.000Z" }] } } }));
  const mine = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:"));
  expect(mine.map((block) => [block.start, block.end])).toEqual([["11:00", "12:00"]]);
});

test("the automatic publish waits up to a minute for the optimal plan, then writes the greedy one; the optimal one once it is cached", async () => {
  const store = setup();
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  // A work order of the person's own: the example board's demo orders are never published.
  store.saveWorkOrder({ ...order, id: "essay", state: "ready_for_human" });
  let release!: () => void;
  const solver = countingSolver(new Promise((resolve) => { release = resolve; }));
  configureOptimal({ enabled: true, solver: solver.solve });
  vi.spyOn(console, "info").mockImplementation(() => {});
  const now = new Date(NOW);
  expect(await blocksToPublish(TEST_CTX, now, { waitForOptimal: true })).toEqual({ blocks: [], pending: true });
  // The person's own click never waits.
  expect((await blocksToPublish(TEST_CTX, now)).pending).toBeUndefined();
  const realNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + OPTIMAL_WAIT_MS + 1_000);
  const late = await blocksToPublish(TEST_CTX, now, { waitForOptimal: true });
  expect(late.pending).toBeUndefined();
  expect(late.blocks.some((block) => block.id.startsWith("scheduled:"))).toBe(true);
  clock.mockRestore();
  release();
  await optimalIdle();
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.schedule.optimal).toBe(true);
  const published = await blocksToPublish(TEST_CTX, now, { waitForOptimal: true });
  expect(published.blocks.filter((block) => block.id.startsWith("scheduled:")).map((block) => block.id))
    .toEqual(plan.blocks.filter((block) => block.id.startsWith("scheduled:") && !block.id.includes("-starter-work-order")).map((block) => block.id));
}, 60_000);

test("a preview neither reads nor asks for the optimal plan", async () => {
  const store = setup();
  await loadCurrentPlan(TEST_CTX);
  store.setSetting(TEST_CTX.workspaceId, OPTIMAL_SETTING, "untouched");
  const solver = countingSolver();
  configureOptimal({ enabled: true, solver: solver.solve });
  await withPreview({ estimates: {} }, () => loadCurrentPlan(TEST_CTX));
  await optimalIdle();
  expect(solver.calls).toHaveLength(0);
  expect(store.getSetting(TEST_CTX.workspaceId, OPTIMAL_SETTING)).toBe("untouched");
});
