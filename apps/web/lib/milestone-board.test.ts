import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadMilestoneBoard, recordRetrospective } from "./milestone-board";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const { workspaceId, principalId: ownerId } = TEST_CTX;
const criterion = { id: "c1", statement: "模拟测验 ≥ 85 分", required: true, evidenceOf: "outcome" as const,
  measure: { kind: "threshold" as const, unit: "分", comparator: "gte" as const, value: 88, bareLine: 85 } };

test("a milestone carries its score line as a threshold, and a reached one gets a retrospective the person can annotate", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-10-08T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m1", ownerId, workspaceId, identityId: "research", projectId: "ece555", title: "ECE 555 期中达到 88 分", status: "approved",
    version: 1, successCriteria: [criterion] });
  let board = await loadMilestoneBoard(TEST_CTX);
  const milestone = board.milestones.find((item) => item.id === "m1")!;
  expect(milestone.criteria[0]).toMatchObject({ quarters: 0, threshold: { comparator: "gte", value: 88, bare: 85, unit: "分" } });
  expect(milestone.retrospective).toBeUndefined();
  expect(await recordRetrospective(TEST_CTX, "m1", "提前两天模拟")).toEqual({ ok: false, code: "MILESTONE_NOT_REACHED" });

  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "gate-1", type: "milestone_gate.judged", entityId: "wo",
    payload: { milestoneId: "m1", criteriaVerdict: [{ criterionId: "c1", met: "met", observed: "模拟测验 91 分" }] } });
  board = await loadMilestoneBoard(TEST_CTX);
  expect(board.milestones.find((item) => item.id === "m1")!.retrospective).toMatchObject({ readings: [{ observed: "模拟测验 91 分" }] });
  expect(await recordRetrospective(TEST_CTX, "m1", "提前两天模拟")).toEqual({ ok: true });
  board = await loadMilestoneBoard(TEST_CTX);
  expect(board.milestones.find((item) => item.id === "m1")!.retrospective?.note).toBe("提前两天模拟");
  expect(store.listEvents(workspaceId, { type: "milestone.retrospective" })[0]?.payload).toMatchObject({ identityId: "research", note: "提前两天模拟" });
});
