import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { milestoneDeadline, planningInputFor } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const ws = TEST_CTX.workspaceId;
const owner = TEST_CTX.principalId;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("a task worked back from an approved milestone is due on the milestone's date, with no goal setting and no saved preferences", () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-18T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const milestone = (id: string, status: "approved" | "draft") => {
    store.saveMilestone({ id, ownerId: owner, workspaceId: ws, identityId: "startup", projectId: "p", title: id, status, version: 1 });
    store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: id, stage: 1, deadline: "2026-10-25", baseline: "", target: "", stakeholders: [],
      sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-18T00:00:00Z" });
  };
  milestone("approved-one", "approved");
  milestone("draft-one", "draft");
  store.saveWorkOrder({ id: "checklist", ownerId: owner, workspaceId: ws, identityId: "startup", projectId: "p", milestoneId: "approved-one",
    intent: "起草验收清单", state: "approved", riskTier: "routine", estimate, payload: { backplan: {} } });

  expect(milestoneDeadline(TEST_CTX, "approved-one")).toBe("2026-10-25");
  // A draft's date is only a proposal until it is approved.
  expect(milestoneDeadline(TEST_CTX, "draft-one")).toBeUndefined();
  const task = planningInputFor(TEST_CTX, "2026-10-18", []).input.tasks.find((item) => item.id === "checklist")!;
  expect(task.deadline).toBeDefined();
  expect(task.deadline!.slice(0, 10)).toBe("2026-10-26");
  expect([1, 2]).toContain(task.deadlineTier);
});
