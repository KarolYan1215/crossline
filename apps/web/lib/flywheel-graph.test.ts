import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { ensureSeeded } from "./crossline";
import { loadFlywheelGraph } from "./flywheel-graph";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const criteria = [{ id: "c1", statement: "写完初稿", required: true, measure: { kind: "artifact" as const, mustExist: "draft.md" } }];
const save = (store: CrosslineStore, id: string, identityId: string, status: "approved" | "draft" | "archived") => store.saveMilestone({ id, ownerId: TEST_CTX.principalId,
  workspaceId: TEST_CTX.workspaceId, identityId, title: `里程碑 ${id}`, version: 1, status, successCriteria: criteria });
const estimate = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (store: CrosslineStore, id: string, identityId: string, milestoneId: string, state: string) => store.saveWorkOrder({ id, ownerId: TEST_CTX.principalId,
  workspaceId: TEST_CTX.workspaceId, identityId, projectId: "p", milestoneId, intent: id, state, riskTier: "routine", estimate, payload: {} });

test("the graph's data: the person's lines with their goal and open tasks, live milestones only, relations between live ones", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  save(store, "g-approved", "research", "approved");
  save(store, "g-draft", "media", "draft");
  save(store, "g-archived", "media", "archived");
  save(store, "g-health", "health", "approved");
  order(store, "o-1", "research", "g-approved", "approved");
  order(store, "o-2", "research", "g-approved", "active");
  order(store, "o-3", "research", "g-approved", "accepted");
  order(store, "o-4", "research", "g-approved", "archived");
  store.saveMilestoneRelation({ id: "rel-live", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, fromMilestoneId: "g-approved", toMilestoneId: "g-draft",
    kind: "reuses", status: "candidate", explanation: "图表复用", refutedWhen: "" });
  store.saveMilestoneRelation({ id: "rel-dead", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, fromMilestoneId: "g-approved", toMilestoneId: "g-archived",
    kind: "reuses", status: "candidate", explanation: "", refutedWhen: "" });
  const data = loadFlywheelGraph(TEST_CTX);
  expect(data.lines.some((line) => line.id === "health")).toBe(false);
  const ids = data.milestones.map((milestone) => milestone.id);
  expect(ids).toEqual(expect.arrayContaining(["g-approved", "g-draft"]));
  expect(ids).not.toContain("g-archived");
  expect(ids).not.toContain("g-health");
  expect(data.milestones.find((milestone) => milestone.id === "g-approved")).toMatchObject({ status: "approved", openTasks: 2, line: "research" });
  expect(data.relations.map((relation) => relation.id)).toContain("rel-live");
  expect(data.relations.map((relation) => relation.id)).not.toContain("rel-dead");
  const research = data.lines.find((line) => line.id === "research")!;
  expect(research.openTasks).toBeGreaterThanOrEqual(2);
  // A line with no long-term goal yet gives an empty goal; the graph labels its anchor with the line's name instead.
  expect(typeof research.goal).toBe("string");
});
