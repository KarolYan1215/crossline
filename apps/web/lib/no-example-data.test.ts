import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));

const { ensureSeeded } = await import("./crossline");
const { startReadiness } = await import("./start-gate");
const { seedReadyToStart, TEST_CTX } = await import("./test-support");

beforeEach(() => {
  // The suite-wide default turns the examples on; this file is about what a real account gets.
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("a new account starts with no example milestones, relations or work orders", () => {
  ensureSeeded(TEST_CTX);
  const store = globalThis.crosslineStore!;
  expect(store.listMilestones(TEST_CTX.workspaceId)).toEqual([]);
  expect(store.listMilestoneRelations(TEST_CTX.workspaceId)).toEqual([]);
  expect(store.listWorkOrders(TEST_CTX.workspaceId)).toEqual([]);
  // What is not an example still exists: the template library the architect builds on, and an empty plan.
  expect(store.listMilestoneTemplates(TEST_CTX.workspaceId).length).toBeGreaterThan(0);
  expect(store.listPlanVersions(TEST_CTX.workspaceId)).toHaveLength(1);
});

test("an empty workspace is not ready to start; it is once the five start items stand", () => {
  expect(startReadiness(TEST_CTX).ready).toBe(false);
  seedReadyToStart(globalThis.crosslineStore!, TEST_CTX.workspaceId);
  expect(startReadiness(TEST_CTX).ready).toBe(true);
});

test("with example data on, the example board meets the start standard", () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "1");
  ensureSeeded(TEST_CTX);
  expect(startReadiness(TEST_CTX).ready).toBe(true);
});
