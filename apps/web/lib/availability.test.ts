import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, planToday, readAvailability, saveAvailability, WORKSPACE_ID } from "./crossline";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

/** Every declared day, all day, so a scheduled block cannot be missing merely because today is a Sunday. */
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];

test("availability survives a round trip through the ledger instead of an environment variable", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(saveAvailability(ALWAYS)).toEqual({ ok: true });
  expect(readAvailability()).toEqual(ALWAYS);
});

test("a window that cannot mean anything is refused, not coerced into one that can", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(saveAvailability([{ days: [1], start: "18:00", end: "09:00", energy: "high" }]))
    .toEqual({ ok: false, code: "AVAILABILITY_ENDS_BEFORE_IT_STARTS" });
  expect(saveAvailability([{ days: [9], start: "09:00", end: "10:00", energy: "high" }]))
    .toEqual({ ok: false, code: "AVAILABILITY_INVALID" });
  // A refusal that still wrote would be worse than no validation at all.
  expect(store.getSetting(WORKSPACE_ID, "schedule.availability")).toBeUndefined();
});

test("the plan's AI lane is the scheduler's output, and it moves when availability does", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveAvailability(ALWAYS);
  const scheduled = loadCurrentPlan().blocks.filter((block) => block.id.startsWith("scheduled:"));
  // The seeded ledger has actionable work orders; with a whole day free the scheduler must place some.
  expect(scheduled.length).toBeGreaterThan(0);
  expect(scheduled.every((block) => block.start >= "08:00" && block.end <= "20:00")).toBe(true);
  // Every placed block names a real work order — the old example blocks named nothing that existed.
  const orders = new Set(globalThis.crosslineStore!.listWorkOrders(WORKSPACE_ID).map((order) => order.id));
  expect(scheduled.every((block) => orders.has(block.id.slice("scheduled:".length)))).toBe(true);

  saveAvailability([{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "08:10", energy: "high" }]);
  // Ten minutes is below the minimum usable slot, so the honest answer is an empty lane, not a block
  // nobody could start. Derived-on-read is what makes this take effect without rewriting the plan.
  expect(loadCurrentPlan().blocks.filter((block) => block.id.startsWith("scheduled:"))).toEqual([]);
});

test("a stored value that no longer parses falls back rather than emptying the week", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(WORKSPACE_ID, "schedule.availability", "{ not json");
  expect(readAvailability().length).toBeGreaterThan(0);
  expect(planToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
