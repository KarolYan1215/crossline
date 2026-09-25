import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { validateAnalysisContext } from "@crossline/core";

vi.mock("server-only", () => ({}));

/**
 * Gate 8 (design §12): replace the entire pack registry with identities this repo has never seen, and
 * the system must still run.
 *
 * Mocking this one module is not a stub standing in for the system — replacing the packs is precisely
 * what the gate asks for. Everything downstream is the real seeding, the real store and the real
 * trust check that used to refuse every analysis once the packs stopped saying "research".
 */
const priors = { review: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 } };
const swappedPacks = [
  { id: "teaching", label: "教学", kind: "identity", masterClock: true, workflowTemplates: ["lesson-prep"], evidencePolicy: "tiered", interviewQuestions: [], durationPriors: priors },
  { id: "woodwork", label: "木工", kind: "identity", masterClock: false, workflowTemplates: ["build-log"], evidencePolicy: "tiered", interviewQuestions: [], durationPriors: priors },
  { id: "band", label: "乐队", kind: "identity", masterClock: false, workflowTemplates: ["setlist"], evidencePolicy: "tiered", interviewQuestions: [], durationPriors: priors },
  { id: "recovery", label: "恢复", kind: "capacity", masterClock: false, workflowTemplates: [], evidencePolicy: "telemetry", interviewQuestions: [], durationPriors: priors }
];
vi.mock("@crossline/identity-packs", () => ({ defaultIdentityPacks: () => swappedPacks }));

const { ensureSeeded, loadDashboard } = await import("./crossline");
const { TEST_CTX } = await import("./test-support");

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("an entirely different pack set seeds its own identities and none of this repo's", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  const store = globalThis.crosslineStore;
  const identities = [...new Set(store.listMilestones(TEST_CTX.workspaceId).map((milestone) => milestone.identityId))].sort();
  expect(identities).toEqual(["band", "teaching", "woodwork"]);
  // The starter titles fall back to the pack's own label rather than being skipped or left blank.
  expect(store.listMilestones(TEST_CTX.workspaceId).map((milestone) => milestone.title))
    .toEqual(expect.arrayContaining([expect.stringContaining("教学")]));
  expect(store.listWorkOrders(TEST_CTX.workspaceId).map((order) => order.identityId).sort())
    .toEqual(["band", "teaching", "woodwork"]);
});

test("no relation is seeded pointing at a milestone the new packs never created", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  const store = globalThis.crosslineStore;
  const milestoneIds = new Set(store.listMilestones(TEST_CTX.workspaceId).map((milestone) => milestone.id));
  for (const relation of store.listMilestoneRelations(TEST_CTX.workspaceId)) {
    expect(milestoneIds.has(relation.fromMilestoneId)).toBe(true);
    expect(milestoneIds.has(relation.toMilestoneId)).toBe(true);
  }
});

test("the seeded ledger still passes the analysis trust check under the new packs", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  const store = globalThis.crosslineStore;
  // This is the failure the hardcoded seed caused: milestones for identities with no backing pack made
  // validateAnalysisContext throw ANALYSIS_CONTEXT_INVALID, so every analysis was refused before it ran.
  const context = {
    version: "crossline.analysis.v1" as const,
    capture: { title: "为下周的课准备一页讲义", context: "" },
    approvedMilestones: store.listMilestones(TEST_CTX.workspaceId)
      .filter((milestone) => milestone.status === "approved" && milestone.projectId)
      .map((milestone) => ({ id: milestone.id, projectId: milestone.projectId!, identityId: milestone.identityId, title: milestone.title, version: milestone.version })),
    identityPacks: swappedPacks.filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, version: 1, summary: pack.label })),
    availableInputs: [],
    historicalStats: [],
    policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true }
  };
  expect(validateAnalysisContext(context).approvedMilestones.length).toBeGreaterThan(0);
});

test("Today renders under the new packs, and the capacity pack stays out of the identity list", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const dashboard = loadDashboard(TEST_CTX);
  // Keyed on kind, not on the literal id "health": a differently named capacity pack must still be
  // treated as a constraint rather than a fourth identity competing for the same list.
  expect(dashboard.identities.map((identity) => identity.id).sort()).toEqual(["band", "teaching", "woodwork"]);
  // `primary`/`lowEnergy`/`shortGap` are the recommendation slots Today actually renders.
  for (const action of [dashboard.primary, dashboard.lowEnergy, dashboard.shortGap]) {
    if (action) expect(action.identityId).not.toBe("recovery");
  }
});
