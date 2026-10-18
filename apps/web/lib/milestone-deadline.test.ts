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

test("moving only a milestone's date keeps the importance in effect instead of writing 「ordinary」", async () => {
  const { effectiveWeight, readGoalSettings, saveGoalSettings } = await import("./crossline");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "launch", ownerId: owner, workspaceId: ws, identityId: "startup", projectId: "p", title: "门店试用启动条件齐备", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "launch", stage: 1, deadline: "2026-10-25", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-18T00:00:00Z" });
  const before = effectiveWeight(TEST_CTX, "launch");
  expect(saveGoalSettings(TEST_CTX, "launch", { confirmedDeadline: "2026-10-31" })).toEqual({ ok: true });
  expect(readGoalSettings(TEST_CTX, "launch")).toMatchObject({ confirmedDeadline: "2026-10-31" });
  expect(readGoalSettings(TEST_CTX, "launch")?.importance).toBeUndefined();
  expect(effectiveWeight(TEST_CTX, "launch")).toBe(before);
});

test("a date moved from a risk question before the fix no longer counts as the person choosing 「ordinary」", async () => {
  const { readGoalSettings } = await import("./crossline");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { goalSettingKey } = await import("@crossline/core");
  store.setSetting(ws, goalSettingKey("launch"), JSON.stringify({ importance: "ordinary", confirmedDeadline: "2026-10-31", sourceQuote: "在「可能赶不上」的询问里推迟" }));
  store.setSetting(ws, goalSettingKey("chosen"), JSON.stringify({ importance: "ordinary", confirmedDeadline: "2026-10-31", sourceQuote: "本人在主线页改的" }));
  expect(readGoalSettings(TEST_CTX, "launch")?.importance).toBeUndefined();
  expect(readGoalSettings(TEST_CTX, "chosen")?.importance).toBe("ordinary");
});
