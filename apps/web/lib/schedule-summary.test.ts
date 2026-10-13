import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, readChangeSummary, readFrozen, lockBlock, saveSchedulePreferences } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const NOW = "2026-09-18T13:00:00.000Z";
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];

test("a calendar event that lands on a work block is named with where the block went, and 「钉回原位」 locks it at its old time", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human" });
  // First look: the basis the next comparison starts from.
  const before = (await loadCurrentPlan(TEST_CTX)).blocks.find((block) => block.id.startsWith(`scheduled:${order.id}`))!;
  expect(readChangeSummary(TEST_CTX)).toEqual([]);

  // A meeting arrives over that block's time.
  const plan = store.listPlanVersions(TEST_CTX.workspaceId)[0]!;
  const meeting = { id: "graph_calendar:sync", lane: "human", title: "Sync up", day: before.day, start: before.start, end: before.end, source: "日历", readOnly: true };
  store.savePlanVersion({ ...plan, payload: { blocks: [...((plan.payload as { blocks: unknown[] }).blocks ?? []), meeting] } });
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, idempotencyKey: "graph-sync:test", type: "plan.reality_changed",
    entityId: plan.id, payload: { changes: [{ kind: "add", blockId: "graph_calendar:sync", title: "Sync up", explanation: "日历新增「Sync up」" }] } });
  await loadCurrentPlan(TEST_CTX);
  const [change] = readChangeSummary(TEST_CTX);
  expect(change).toMatchObject({ blockId: before.id, day: before.day, from: { start: before.start, end: before.end }, cause: `${before.start} Sync up` });
  expect(change!.to.start === before.start && change!.to.day === before.day).toBe(false);

  // 「钉回原位」: locked at the old time, overlap accepted.
  expect(lockBlock(TEST_CTX, change!.blockId, { day: change!.day, start: change!.from.start, end: change!.from.end }, "locked", { overlapOk: true })).toEqual({ ok: true });
  expect(readFrozen(TEST_CTX, new Date(NOW))).toEqual([expect.objectContaining({ blockId: before.id, reason: "locked", overlapOk: true })]);
  const after = (await loadCurrentPlan(TEST_CTX)).blocks.find((block) => block.id === before.id)!;
  expect(after).toMatchObject({ day: before.day, start: before.start, end: before.end, tag: "已锁定" });
});
