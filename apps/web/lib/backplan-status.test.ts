import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { milestonesBeingBackplanned } from "./backplan-status";

const workspaceId = "ws-backplan";
const ownerId = "owner-backplan";

test("approved milestones count as being worked backwards until a task serves them or a backplan was tried at their version", () => {
  const store = new CrosslineStore(":memory:");
  const save = (id: string, status: "approved" | "draft" = "approved") => store.saveMilestone({ id, ownerId, workspaceId,
    identityId: "research", projectId: "p", title: id, status, version: 1 });
  const anchor = (milestoneId: string, deadline: string) => store.saveMilestoneAnchor({ workspaceId, milestoneId, stage: 1, deadline,
    baseline: "b", target: "t", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  save("waiting"); anchor("waiting", "2026-10-24");
  save("undated");
  save("past"); anchor("past", "2026-10-01");
  save("draft", "draft");
  save("served"); anchor("served", "2026-10-20");
  store.saveWorkOrder({ id: "wo", ownerId, workspaceId, identityId: "research", projectId: "p", milestoneId: "served", intent: "x",
    state: "awaiting_plan_approval", riskTier: "routine", estimate: { p25Minutes: 1, p50Minutes: 2, p85Minutes: 3, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  save("refused"); anchor("refused", "2026-10-30");
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "bp-refused", type: "goal.backplan_blocked", entityId: "refused", payload: { milestoneVersion: 1 } });
  expect(milestonesBeingBackplanned(store, workspaceId, "2026-10-18")).toBe(2);
  store.close();
});
