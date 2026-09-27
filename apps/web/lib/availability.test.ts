import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, loadDashboard, loadGoalForecast, planToday, readAvailability, readSchedulePreferences,
  readGoalSettings, saveAvailability, saveGoalSettings, saveSchedulePreferences, toZonedInstant } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

/** Every declared day, all day, so a scheduled block cannot be missing merely because today is a Sunday. */
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" as const }];
const setup = (windows = ALWAYS) => saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago",
  mode: "buffered", windows, importance: { "research-starter": "important",
    "startup-starter": "important", "media-starter": "ordinary", "investment-starter": "ordinary" } });

test("a real preview appears before setup off defaults, and an invalid zone is still rejected atomically", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  // No empty page waiting on a questionnaire: the preview is computed off defaults from the first load.
  expect((await loadCurrentPlan(TEST_CTX)).usingDefaultPreferences).toBe(true);
  expect(saveSchedulePreferences(TEST_CTX, { timeZone: "Invalid/Zone", mode: "buffered", windows: ALWAYS,
    importance: {} })).toEqual({ ok: false, code: "SCHEDULE_TIME_ZONE_INVALID" });
  expect(readSchedulePreferences(TEST_CTX)).toBeNull();
  expect(store.getSetting(TEST_CTX.workspaceId, "schedule.availability")).toBeUndefined();
  expect(setup()).toEqual({ ok: true });
  expect(readSchedulePreferences(TEST_CTX)?.mode).toBe("buffered");
  const after = await loadCurrentPlan(TEST_CTX);
  expect(after.usingDefaultPreferences).toBe(false);
  expect(after.blocks.some((block) => block.id.startsWith("scheduled:"))).toBe(true);
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
  expect(saveAvailability(TEST_CTX, ALWAYS)).toEqual({ ok: true });
  expect(readAvailability(TEST_CTX)).toEqual(ALWAYS);
});

test("a window that cannot mean anything is refused, not coerced into one that can", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(saveAvailability(TEST_CTX, [{ days: [1], start: "18:00", end: "09:00", energy: "high" }]))
    .toEqual({ ok: false, code: "AVAILABILITY_ENDS_BEFORE_IT_STARTS" });
  expect(saveAvailability(TEST_CTX, [{ days: [9], start: "09:00", end: "10:00", energy: "high" }]))
    .toEqual({ ok: false, code: "AVAILABILITY_INVALID" });
  // A refusal that still wrote would be worse than no validation at all.
  expect(store.getSetting(TEST_CTX.workspaceId, "schedule.availability")).toBeUndefined();
});

test("the plan's AI lane is the scheduler's output, and it moves when availability does", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  const scheduled = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:"));
  // The seeded ledger has actionable work orders; with a whole day free the scheduler must place some.
  expect(scheduled.length).toBeGreaterThan(0);
  expect(scheduled.every((block) => block.start >= "08:00" && block.end <= "20:00")).toBe(true);
  // Every placed block names a real work order — the old example blocks named nothing that existed.
  const orders = new Set(globalThis.crosslineStore!.listWorkOrders(TEST_CTX.workspaceId).map((order) => order.id));
  expect(scheduled.every((block) => orders.has(block.id.split(":")[1]!))).toBe(true);

  saveAvailability(TEST_CTX, [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "08:10", energy: "high" }]);
  // Ten minutes is below the minimum usable slot, so the honest answer is an empty lane, not a block
  // nobody could start. Derived-on-read is what makes this take effect without rewriting the plan.
  expect((await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:"))).toEqual([]);
});

test("a partial plan shows placed blocks and the work that has no room", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup([{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "09:00", energy: "high" }]);
  await loadCurrentPlan(TEST_CTX);
  const large = store.listWorkOrders(TEST_CTX.workspaceId)[0]!;
  store.saveWorkOrder({ ...large, estimate: { ...large.estimate, p25Minutes: 5000,
    p50Minutes: 5000, p85Minutes: 5000 } });
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.schedule.status).toBe("partial");
  expect(plan.blocks.some((block) => block.id.startsWith("scheduled:"))).toBe(true);
  expect(plan.schedule.blockers.length).toBeGreaterThan(0);
  expect(plan.schedule.blockers.every((blocker) => store.listWorkOrders(TEST_CTX.workspaceId)
    .some((order) => order.id === blocker.taskId))).toBe(true);
});

test("an approved work order keeps a provisional preparation label on its suggestion", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  await loadCurrentPlan(TEST_CTX);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.identityId === "research")!;
  store.saveWorkOrder({ ...order, state: "approved" });
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.blocks.find((block) => block.id === `scheduled:${order.id}`)?.title)
    .toContain("暂定·准备中");
});

test("real calendar occupancy is excluded from suggested time", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T11:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup([{ days: [5], start: "08:00", end: "20:00", energy: "high" }]);
  await loadCurrentPlan(TEST_CTX);
  const plan = store.listPlanVersions(TEST_CTX.workspaceId)[0]!;
  store.savePlanVersion({ ...plan, payload: { blocks: [{ id: "graph_calendar:busy",
    lane: "human", title: "真实日历占用", day: "2026-09-18", start: "08:00", end: "18:00",
    source: "日历", readOnly: true }] } });
  const blocks = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:") &&
    block.day === "2026-09-18");
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.every((block) => block.start >= "18:00")).toBe(true);
});

test("fresh L and H self-reports change Today while preserving the skipped priority", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T15:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS,
    importance: { "research-starter": "important", "startup-starter": "important",
      "media-starter": "important", "investment-starter": "ordinary" } });
  const report = (id: string, level: "low" | "high", observedAt: string) =>
    store.saveEnergyObservation({ id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
      source: "self_report", level, confidence: "high", aggregate: {}, observedAt });
  report("low-now", "low", "2026-09-18T14:59:00.000Z");
  const low = await loadDashboard(TEST_CTX);
  expect(low.primary?.energy).toBe("low");
  report("high-now", "high", "2026-09-18T15:00:00.000Z");
  expect((await loadDashboard(TEST_CTX)).primary?.energy).toBe("high");
});

test("fresh L and H self-reports reorder today's suggestion blocks", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T14:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: [
    { days: [5], start: "09:00", end: "12:00", energy: "high" },
    { days: [5], start: "13:00", end: "17:00", energy: "high" }
  ], importance: { "research-starter": "important", "startup-starter": "important",
    "media-starter": "important", "investment-starter": "ordinary" } });
  const report = (id: string, level: "low" | "high", observedAt: string) =>
    store.saveEnergyObservation({ id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
      source: "self_report", level, confidence: "high", aggregate: {}, observedAt });
  report("low", "low", "2026-09-18T13:59:00.000Z");
  const first = (await loadCurrentPlan(TEST_CTX)).blocks.find((block) => block.day === "2026-09-18" &&
    block.id.startsWith("scheduled:"));
  expect(first?.id).toContain("media");
  expect((await loadCurrentPlan(TEST_CTX)).blocks.some((block) => block.title.includes("休息后待复评"))).toBe(true);
  report("high", "high", "2026-09-18T14:00:00.000Z");
  const second = (await loadCurrentPlan(TEST_CTX)).blocks.find((block) => block.day === "2026-09-18" &&
    block.id.startsWith("scheduled:"));
  expect(second?.id).toContain("research");
});

test("a stored value that no longer parses falls back rather than emptying the week", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(TEST_CTX.workspaceId, "schedule.availability", "{ not json");
  expect(readAvailability(TEST_CTX).length).toBeGreaterThan(0);
  expect(planToday(TEST_CTX)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("only an explicit valid date on an approved goal becomes a hard scheduling deadline", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T14:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  expect(saveGoalSettings(TEST_CTX, "research-starter", { importance: "important", confirmedDeadline: "2026-09-19",
    sourceQuote: "by September 19" })).toEqual({ ok: true });
  expect(readGoalSettings(TEST_CTX, "research-starter")).toEqual({ importance: "important",
    confirmedDeadline: "2026-09-19", sourceQuote: "by September 19" });
  expect(saveGoalSettings(TEST_CTX, "research-starter", { importance: "important", confirmedDeadline: "2026-02-30" }))
    .toEqual({ ok: false, code: "GOAL_DEADLINE_INVALID" });
  expect(saveGoalSettings(TEST_CTX, "missing", { importance: "important", confirmedDeadline: null }))
    .toEqual({ ok: false, code: "GOAL_NOT_APPROVED" });
  const event = store.listEvents(TEST_CTX.workspaceId, { type: "goal.settings_confirmed" });
  expect(event).toHaveLength(1);
  expect(event[0]?.payload).toMatchObject({ next: { confirmedDeadline: "2026-09-19" } });
  const plan = await loadCurrentPlan(TEST_CTX);
  expect(plan.blocks.some((block) => block.id.includes("research-starter-work-order"))).toBe(true);
});

test("a real calendar event in week two lowers the eight-week forecast capacity", () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T14:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  const before = loadGoalForecast(TEST_CTX).weeks[1]!.netMinutes;
  const plan = store.listPlanVersions(TEST_CTX.workspaceId)[0]!;
  store.savePlanVersion({ ...plan, payload: { blocks: [{ id: "graph_calendar:future", lane: "human",
    title: "下周真实会议", day: "2026-09-28", start: "08:00", end: "12:00", source: "日历", readOnly: true }] } });
  const after = loadGoalForecast(TEST_CTX);
  expect(after.weeks[1]!.netMinutes).toBe(before - 240);
});

test("changing importance on the schedule page keeps confirmed goal metadata in sync", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  setup();
  saveGoalSettings(TEST_CTX, "research-starter", { importance: "important", confirmedDeadline: "2026-10-01" });
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS,
    importance: { "research-starter": "ordinary", "startup-starter": "important",
      "media-starter": "ordinary", "investment-starter": "ordinary" } });
  expect(readGoalSettings(TEST_CTX, "research-starter")).toMatchObject({ importance: "ordinary",
    confirmedDeadline: "2026-10-01" });
});
