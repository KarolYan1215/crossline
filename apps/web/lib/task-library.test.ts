import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { libraryUntil } from "./crossline";
import { TEST_CTX } from "./test-support";

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
