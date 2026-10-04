import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));

const { ensureSeeded, needsOnboarding } = await import("./crossline");
const { TEST_CTX } = await import("./test-support");

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

test("an empty workspace is sent to the interview, and stops being once there is any profile or session", () => {
  ensureSeeded(TEST_CTX);
  expect(needsOnboarding(TEST_CTX)).toBe(true);
  const store = globalThis.crosslineStore!;
  store.upsertProfileFact({ workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "", slot: "stage", value: "博一",
    status: "confirmed", sourceRef: "reply-1", sourceQuote: "博一", updatedAt: "2026-10-02T00:00:00.000Z" });
  expect(needsOnboarding(TEST_CTX)).toBe(false);
});

test("an existing account with work on its board is never redirected", () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "1");
  ensureSeeded(TEST_CTX);
  expect(needsOnboarding(TEST_CTX)).toBe(false);
});
