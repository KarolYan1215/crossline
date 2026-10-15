import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { clearKept, commitSoon, keepBlocks, loadCurrentPlan, lockBlock, readFrozen, saveSchedulePreferences, unlockBlock } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const NOW = "2026-09-18T13:00:00.000Z";
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];
const setup = () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  return store;
};

test("the two settings the freeze table replaced are taken over once and then deleted", () => {
  const store = setup();
  store.setSetting(TEST_CTX.workspaceId, "schedule.pins", JSON.stringify([{ taskId: "wo-1", day: "2026-09-19", start: "09:00", end: "10:00" }]));
  store.setSetting(TEST_CTX.workspaceId, "schedule.keep", JSON.stringify({ until: "2026-09-25T00:00:00.000Z",
    blocks: [{ taskId: "wo-2#v1s1", day: "2026-09-19", start: "11:00", end: "12:00" }] }));
  const frozen = readFrozen(TEST_CTX, new Date(NOW));
  expect(frozen.map((item) => [item.blockId, item.reason])).toEqual([["scheduled:wo-1", "pinned"], ["scheduled:wo-2:v1s1", "keep"]]);
  expect(frozen[1]!.until).toBe("2026-09-25T00:00:00.000Z");
  expect(store.getSetting(TEST_CTX.workspaceId, "schedule.pins")).toBeUndefined();
  expect(store.getSetting(TEST_CTX.workspaceId, "schedule.keep")).toBeUndefined();
  expect(readFrozen(TEST_CTX, new Date(NOW))).toEqual(frozen);
});

test("re-planning everything clears what a local re-plan kept, never what the person locked", () => {
  setup();
  keepBlocks(TEST_CTX, [{ blockId: "scheduled:wo-2", day: "2026-09-19", start: "11:00", end: "12:00" }], new Date(NOW));
  expect(lockBlock(TEST_CTX, "scheduled:wo-1:2", { day: "2026-09-19", start: "09:00", end: "10:00" }, "locked")).toEqual({ ok: true });
  clearKept(TEST_CTX, new Date(NOW));
  expect(readFrozen(TEST_CTX, new Date(NOW)).map((item) => [item.blockId, item.reason])).toEqual([["scheduled:wo-1:2", "locked"]]);
  expect(unlockBlock(TEST_CTX, "scheduled:wo-1:2")).toEqual({ ok: true });
  expect(readFrozen(TEST_CTX, new Date(NOW))).toEqual([]);
});

test("locking one segment keeps its id and time, and the task's other minutes are still placed under other ids", async () => {
  const store = setup();
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human", estimate: { ...order.estimate, p25Minutes: 120, p50Minutes: 120, p85Minutes: 120, confidence: "high" },
    payload: { ...(order.payload as object), humanCore: [{ energy: "high", interruptible: true }] } });
  expect(lockBlock(TEST_CTX, `scheduled:${order.id}:2`, { day: "2026-09-19", start: "09:00", end: "10:00" }, "locked")).toEqual({ ok: true });
  const blocks = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith(`scheduled:${order.id}`));
  expect(blocks.find((block) => block.id === `scheduled:${order.id}:2`)).toMatchObject({ day: "2026-09-19", start: "09:00", end: "10:00", tag: "已锁定" });
  expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  const minutes = (block: { start: string; end: string }) => {
    const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
    return (eh! * 60 + em!) - (sh! * 60 + sm!);
  };
  // 60 locked minutes and the other 60 placed elsewhere.
  expect(blocks.filter((block) => block.id !== `scheduled:${order.id}:2`).reduce((sum, block) => sum + minutes(block), 0)).toBeGreaterThanOrEqual(60);
});

test("the commit window: a block starting within fifteen minutes keeps its time until it ends; later ones and locked ones are left alone", () => {
  setup();
  // NOW is 08:00 in Chicago.
  expect(lockBlock(TEST_CTX, "scheduled:locked", { day: "2026-09-18", start: "08:05", end: "08:30" }, "locked")).toEqual({ ok: true });
  const added = commitSoon(TEST_CTX, [
    { id: "scheduled:soon", day: "2026-09-18", start: "08:10", end: "08:40" },
    { id: "scheduled:later", day: "2026-09-18", start: "09:00", end: "09:30" },
    { id: "scheduled:locked", day: "2026-09-18", start: "08:05", end: "08:30" },
    { id: "proposed:p", day: "2026-09-18", start: "08:05", end: "08:30" }
  ], new Date(NOW));
  expect(added).toBe(1);
  const frozen = readFrozen(TEST_CTX, new Date(NOW));
  expect(frozen.map((item) => [item.blockId, item.reason])).toEqual([["scheduled:locked", "locked"], ["scheduled:soon", "commit"]]);
  expect(frozen[1]!.until).toBe("2026-09-18T13:40:00.000Z");
  expect(readFrozen(TEST_CTX, new Date("2026-09-18T13:41:00.000Z")).map((item) => item.blockId)).toEqual([]);
});

test("改时间 on a held block is previewed without writing, then locks it at the new time; deferring the task voids an older lock", async () => {
  const store = setup();
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "ready_for_human", estimate: { ...order.estimate, p25Minutes: 60, p50Minutes: 60, p85Minutes: 60, confidence: "high" },
    payload: { ...(order.payload as object), humanCore: [{ energy: "high", interruptible: true }] } });
  const id = `scheduled:${order.id}`;
  expect(lockBlock(TEST_CTX, id, { day: "2026-09-19", start: "09:00", end: "10:00" }, "locked")).toEqual({ ok: true });
  const { previewChange, applyChange } = await import("./impact");
  const move = { kind: "move_block" as const, workOrderId: order.id, blockId: id, day: "2026-09-19", start: "15:00", end: "16:00" };
  const impact = await previewChange(TEST_CTX, move);
  expect(impact.task?.firstAfter).toBe("2026-09-19 15:00");
  expect(readFrozen(TEST_CTX, new Date(NOW))[0]).toMatchObject({ start: "2026-09-19T14:00:00.000Z" });
  expect(applyChange(TEST_CTX, move)).toEqual({ ok: true });
  expect((await loadCurrentPlan(TEST_CTX)).blocks.find((block) => block.id === id)).toMatchObject({ day: "2026-09-19", start: "15:00", tag: "已锁定" });
  // 「推到 21 号再做」: the lock on the 19th no longer holds the task there.
  store.saveWorkOrder({ ...store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === order.id)!,
    payload: { ...(order.payload as object), humanCore: [{ energy: "high", interruptible: true }], notBefore: "2026-09-21" } });
  const after = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith(id));
  expect(after.every((block) => (block.day ?? "") >= "2026-09-21")).toBe(true);
});
