import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, loadDashboard, loadGoalForecast, planToday, readAvailability, readSchedulePreferences,
  readGoalSettings, saveAvailability, saveGoalSettings, saveSchedulePreferences, toZonedInstant, WORKSPACE_ID } from "./crossline";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

/** Every declared day, all day, so a scheduled block cannot be missing merely because today is a Sunday. */
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];
const setup = (windows = ALWAYS) => saveSchedulePreferences({ timeZone: "America/Chicago",
  mode: "buffered", windows, importance: { "research-starter": "important",
    "startup-starter": "important", "media-starter": "ordinary", "investment-starter": "ordinary" } });

test("first schedule waits for the required questionnaire and rejects an invalid zone atomically", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect((await loadCurrentPlan()).blocks.filter((block) => block.id.startsWith("scheduled:"))).toEqual([]);
  expect(saveSchedulePreferences({ timeZone: "Invalid/Zone", mode: "buffered", windows: ALWAYS,
    importance: {} })).toEqual({ ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" });
  expect(readSchedulePreferences()).toBeNull();
  expect(store.getSetting(WORKSPACE_ID, "schedule.availability")).toBeUndefined();
  expect(setup()).toEqual({ ok: true });
  expect(readSchedulePreferences()?.mode).toBe("buffered");
  expect((await loadCurrentPlan()).blocks.some((block) => block.id.startsWith("scheduled:"))).toBe(true);
});

test("wall clock availability converts across daylight saving time", () => {
  expect(toZonedInstant("2026-03-07", "09:00", "America/Chicago")).toBe("2026-03-07T15:00:00.000Z");
  expect(toZonedInstant("2026-03-08", "09:00", "America/Chicago")).toBe("2026-03-08T14:00:00.000Z");
  expect(() => toZonedInstant("2026-03-08", "02:30", "America/Chicago"))
    .toThrow("AVAILABILITY_LOCAL_TIME_INVALID");
  expect(() => toZonedInstant("2026-11-01", "01:30", "America/Chicago"))
    .toThrow("AVAILABILITY_LOCAL_TIME_AMBIGUOUS");
});

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

test("the plan's AI lane is the scheduler's output, and it moves when availability does", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  const scheduled = (await loadCurrentPlan()).blocks.filter((block) => block.id.startsWith("scheduled:"));
  // The seeded ledger has actionable work orders; with a whole day free the scheduler must place some.
  expect(scheduled.length).toBeGreaterThan(0);
  expect(scheduled.every((block) => block.start >= "08:00" && block.end <= "20:00")).toBe(true);
  // Every placed block names a real work order — the old example blocks named nothing that existed.
  const orders = new Set(globalThis.crosslineStore!.listWorkOrders(WORKSPACE_ID).map((order) => order.id));
  expect(scheduled.every((block) => orders.has(block.id.split(":")[1]!))).toBe(true);

  saveAvailability([{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "08:10", energy: "high" }]);
  // Ten minutes is below the minimum usable slot, so the honest answer is an empty lane, not a block
  // nobody could start. Derived-on-read is what makes this take effect without rewriting the plan.
  expect((await loadCurrentPlan()).blocks.filter((block) => block.id.startsWith("scheduled:"))).toEqual([]);
});

test("a partial plan shows placed blocks and the work that has no room", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup([{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "09:00", energy: "high" }]);
  await loadCurrentPlan();
  const large = store.listWorkOrders(WORKSPACE_ID)[0]!;
  store.saveWorkOrder({ ...large, estimate: { ...large.estimate, p25Minutes: 5000,
    p50Minutes: 5000, p85Minutes: 5000 } });
  const plan = await loadCurrentPlan();
  expect(plan.schedule.status).toBe("partial");
  expect(plan.blocks.some((block) => block.id.startsWith("scheduled:"))).toBe(true);
  expect(plan.schedule.blockers.length).toBeGreaterThan(0);
  expect(plan.schedule.blockers.every((blocker) => store.listWorkOrders(WORKSPACE_ID)
    .some((order) => order.id === blocker.taskId))).toBe(true);
});

test("an approved work order keeps a provisional preparation label on its suggestion", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  await loadCurrentPlan();
  const order = store.listWorkOrders(WORKSPACE_ID).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "approved" });
  const plan = await loadCurrentPlan();
  expect(plan.blocks.find((block) => block.id === `scheduled:${order.id}`)?.title)
    .toContain("暂定·准备中");
});

test("real calendar occupancy is excluded from suggested time", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T11:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup([{ days: [5], start: "08:00", end: "20:00", energy: "high" }]);
  await loadCurrentPlan();
  const plan = store.listPlanVersions(WORKSPACE_ID)[0]!;
  store.savePlanVersion({ ...plan, payload: { blocks: [{ id: "graph_calendar:busy",
    lane: "human", title: "真实日历占用", day: "2026-09-18", start: "08:00", end: "18:00",
    source: "日历", readOnly: true }] } });
  const blocks = (await loadCurrentPlan()).blocks.filter((block) => block.id.startsWith("scheduled:") &&
    block.day === "2026-09-18");
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every((block) => block.start >= "18:00")).toBe(true);
});

test("fresh L and H self-reports change Today while preserving the skipped priority", () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences({ timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS,
    importance: { "research-starter": "important", "startup-starter": "important",
      "media-starter": "important", "investment-starter": "ordinary" } });
  const report = (id: string, level: "low" | "high", observedAt: string) =>
    store.saveEnergyObservation({ id, ownerId: "local-owner", workspaceId: WORKSPACE_ID,
      source: "self_report", level, confidence: "high", aggregate: {}, observedAt });
  report("low-now", "low", "2026-09-18T14:59:00.000Z");
  const low = loadDashboard();
  expect(low.primary?.energy).toBe("low");
  report("high-now", "high", "2026-09-18T15:00:00.000Z");
  expect(loadDashboard().primary?.energy).toBe("high");
});

test("fresh L and H self-reports reorder today's suggestion blocks", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T14:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences({ timeZone: "America/Chicago", mode: "buffered", windows: [
    { days: [5], start: "09:00", end: "12:00", energy: "high" },
    { days: [5], start: "13:00", end: "17:00", energy: "high" }
  ], importance: { "research-starter": "important", "startup-starter": "important",
    "media-starter": "important", "investment-starter": "ordinary" } });
  const report = (id: string, level: "low" | "high", observedAt: string) =>
    store.saveEnergyObservation({ id, ownerId: "local-owner", workspaceId: WORKSPACE_ID,
      source: "self_report", level, confidence: "high", aggregate: {}, observedAt });
  report("low", "low", "2026-09-18T13:59:00.000Z");
  const first = (await loadCurrentPlan()).blocks.find((block) => block.day === "2026-09-18" &&
    block.id.startsWith("scheduled:"));
  expect(first?.id).toContain("media");
  expect((await loadCurrentPlan()).blocks.some((block) => block.title.includes("休息后待复评"))).toBe(true);
  report("high", "high", "2026-09-18T14:00:00.000Z");
  const second = (await loadCurrentPlan()).blocks.find((block) => block.day === "2026-09-18" &&
    block.id.startsWith("scheduled:"));
  expect(second?.id).toContain("research");
});

test("a stored value that no longer parses falls back rather than emptying the week", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(WORKSPACE_ID, "schedule.availability", "{ not json");
  expect(readAvailability().length).toBeGreaterThan(0);
  expect(planToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("only an explicit valid date on an approved goal becomes a hard scheduling deadline", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T14:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  expect(saveGoalSettings("research-starter", { importance: "important", confirmedDeadline: "2026-09-19",
    sourceQuote: "by September 19" })).toEqual({ ok: true });
  expect(readGoalSettings("research-starter")).toEqual({ importance: "important",
    confirmedDeadline: "2026-09-19", sourceQuote: "by September 19" });
  expect(saveGoalSettings("research-starter", { importance: "important", confirmedDeadline: "2026-02-30" }))
    .toEqual({ ok: false, code: "GOAL_DEADLINE_INVALID" });
  expect(saveGoalSettings("missing", { importance: "important", confirmedDeadline: null }))
    .toEqual({ ok: false, code: "GOAL_NOT_APPROVED" });
  const event = store.listEvents(WORKSPACE_ID, { type: "goal.settings_confirmed" });
  expect(event).toHaveLength(1);
  expect(event[0]?.payload).toMatchObject({ next: { confirmedDeadline: "2026-09-19" } });
  const plan = await loadCurrentPlan();
  expect(plan.blocks.some((block) => block.id.includes("research-starter-work-order"))).toBe(true);
});

test("a real calendar event in week two lowers the eight-week forecast capacity", () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T14:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  const before = loadGoalForecast().weeks[1]!.netMinutes;
  const plan = store.listPlanVersions(WORKSPACE_ID)[0]!;
  store.savePlanVersion({ ...plan, payload: { blocks: [{ id: "graph_calendar:future", lane: "human",
    title: "下周真实会议", day: "2026-09-28", start: "08:00", end: "12:00", source: "日历", readOnly: true }] } });
  const after = loadGoalForecast();
  expect(after.weeks[1]!.netMinutes).toBe(before - 240);
});

test("changing importance on the schedule page keeps confirmed goal metadata in sync", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  saveGoalSettings("research-starter", { importance: "important", confirmedDeadline: "2026-10-01" });
  saveSchedulePreferences({ timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS,
    importance: { "research-starter": "ordinary", "startup-starter": "important",
      "media-starter": "ordinary", "investment-starter": "ordinary" } });
  expect(readGoalSettings("research-starter")).toMatchObject({ importance: "ordinary",
    confirmedDeadline: "2026-10-01" });
});
