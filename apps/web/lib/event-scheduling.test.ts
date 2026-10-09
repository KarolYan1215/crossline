import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
import { loadCurrentPlan, saveAvailability, saveSchedulePreferences } from "./crossline";
import { scheduleEvent } from "./event-scheduling";
import { fixedEventsToPublish } from "./fixed-events";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const NOW = new Date("2026-10-12T13:00:00.000Z"); // a Monday, 08:00 in Chicago
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  saveAvailability(TEST_CTX, ALWAYS);
}
const scheduled = async () => (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:"));

test("an event placed on a work block moves that block only; every other block stays where it was", async () => {
  setup();
  const before = await scheduled();
  expect(before.length).toBeGreaterThan(1);
  const target = before[0]!;
  const result = await scheduleEvent(TEST_CTX, { title: "和导师开会", lineId: "research", date: target.day!, weekdays: [], startTime: target.start, endTime: target.end, until: "", minutes: 60 }, NOW);
  expect(result).toMatchObject({ ok: true, moved: 1, placedBySystem: false });
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.blocks.some((block) => block.id.startsWith("event:") && block.day === target.day && block.start === target.start)).toBe(true);
  const after = plan.blocks.filter((block) => block.id.startsWith("scheduled:"));
  // Nothing scheduled over the event any more…
  expect(after.some((block) => block.day === target.day && block.start < target.end && target.start < block.end)).toBe(false);
  // …and the untouched blocks are exactly where they were.
  for (const block of before.slice(1).filter((item) => !(item.day === target.day && item.start < target.end && target.start < item.end)))
    expect(after.some((item) => item.day === block.day && item.start === block.start && item.end === block.end && item.title === block.title)).toBe(true);
});

test("with no time given the system finds a free one; a recurring event is one weekly series on the calendar, a one-off a single event", async () => {
  setup();
  const auto = await scheduleEvent(TEST_CTX, { title: "和师兄对数据", lineId: "", date: "2026-10-14", weekdays: [], startTime: "", endTime: "", until: "", minutes: 45 }, NOW);
  expect(auto).toMatchObject({ ok: true, placedBySystem: true, event: { date: "2026-10-14", repeat: null } });
  const series = await scheduleEvent(TEST_CTX, { title: "健身", lineId: "", date: "", weekdays: [2, 4], startTime: "07:00", endTime: "07:45", until: "2026-12-31", minutes: 45 }, NOW);
  expect(series).toMatchObject({ ok: true, event: { repeat: { weekdays: [2, 4], from: "2026-10-12", until: "2026-12-31" } } });
  expect(await scheduleEvent(TEST_CTX, { title: "组会", lineId: "", date: "", weekdays: [3], startTime: "", endTime: "", until: "2026-12-31", minutes: 60 }, NOW))
    .toMatchObject({ ok: false, code: "EVENT_TIME_REQUIRED" });
  const published = fixedEventsToPublish(TEST_CTX, NOW);
  const gym = published.find((block) => block.title === "健身")!;
  expect(gym.recurrence).toMatchObject({ daysOfWeek: ["tuesday", "thursday"], startDate: "2026-10-13", endDate: "2026-12-31", localStart: "07:00", localEnd: "07:45" });
  expect(published.find((block) => block.title === "和师兄对数据")?.recurrence).toBeUndefined();
});
