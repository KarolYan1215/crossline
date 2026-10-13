import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { libraryUntil } from "./crossline";
import { settledPlan, TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("a task worked back from a milestone due beyond three weeks waits in the library until its window opens", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const ws = TEST_CTX.workspaceId;
  const anchor = (milestoneId: string, deadline: string) => store.saveMilestoneAnchor({ workspaceId: ws, milestoneId, stage: 1, deadline,
    baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  anchor("far", "2026-12-17"); anchor("near", "2026-10-20");
  const order = (milestoneId: string, payload: Record<string, unknown>, state = "approved") => ({ state, milestoneId, payload: { backplan: { round: 1 }, ...payload } });
  expect(libraryUntil(TEST_CTX, order("far", {}), "2026-10-08")).toBe("2026-11-26");
  // Inside the window, with its own due day inside the window, already started, or not worked back from a milestone: scheduled now.
  expect(libraryUntil(TEST_CTX, order("near", {}), "2026-10-08")).toBeNull();
  expect(libraryUntil(TEST_CTX, order("far", { dueDate: "2026-10-15" }), "2026-10-08")).toBeNull();
  expect(libraryUntil(TEST_CTX, order("far", {}, "active"), "2026-10-08")).toBeNull();
  expect(libraryUntil(TEST_CTX, { state: "approved", milestoneId: "far", payload: {} }, "2026-10-08")).toBeNull();
  expect(libraryUntil(TEST_CTX, order("far", {}), "2026-11-26")).toBeNull();
});

test("a line the person gives a share of the week gets its library work placed, up to that share, and labelled why", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-12T14:00:00.000Z");
  const { saveSchedulePreferences, LINE_SHARES_SETTING } = await import("./crossline");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const ws = TEST_CTX.workspaceId;
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "asap", importance: {},
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "13:00", energy: "high" }] });
  store.saveMilestone({ id: "mvp", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "startup", projectId: "crossline", title: "MVP 上线", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mvp", stage: 1, deadline: "2026-11-30", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  const estimate = { p25Minutes: 120, p50Minutes: 120, p85Minutes: 120, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
  store.saveWorkOrder({ id: "build", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "startup", projectId: "crossline", milestoneId: "mvp",
    intent: "实现登录页", state: "approved", riskTier: "routine", estimate, payload: { backplan: { round: 1 }, materialContract: [] } });
  // Line-share work is placed by the solver only (the greedy pass skips floor-only work), so this reads the plan after the background solve.
  const startupBlocks = async () => (await settledPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:build"));
  expect(await startupBlocks()).toEqual([]);
  store.setSetting(ws, LINE_SHARES_SETTING, JSON.stringify({ research: 80, startup: 20 }));
  const placed = await startupBlocks();
  expect(placed.length).toBeGreaterThan(0);
  expect(placed[0]).toMatchObject({ tag: "按主线份额" });
  vi.unstubAllEnvs();
});
