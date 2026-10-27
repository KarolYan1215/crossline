import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { planAssistantTask, type ProposedAction } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
import { getStore, loadCurrentPlan, saveAvailability, saveSchedulePreferences } from "./crossline";
import { executeAction } from "./actions";
import { addReminder, createErrand, deliverDueReminders, reminderMoment } from "./life";
import { setPlaceMinutes, setTravel, refreshTravelEstimates } from "./travel";
import { answerAsk, collectAsks } from "./asks";
import { listNotices } from "./notices";
import { undoOp } from "./undo";
import { estimateTravelMinutes } from "./map-travel";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const NOW = new Date("2026-10-27T13:00:00.000Z"); // Tuesday 08:00 in Chicago
const ALWAYS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "21:00", energy: "high" as const }];
function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: ALWAYS, importance: {} });
  saveAvailability(TEST_CTX, ALWAYS);
}
const event = (args: Partial<Record<string, unknown>>): ProposedAction => ({ action: "event.create", summary: "", args: { title: "Costco 采购", date: "2026-10-31",
  weekdays: [], startTime: "14:00", endTime: "16:00", until: "", minutes: 0, lineId: "", location: "Costco Middleton", ...args } } as ProposedAction);

test("an event at a place gets 「路上」 on the plan, from the person's minutes; an online one gets none, and the place is asked once meanwhile", async () => {
  setup();
  expect((await executeAction(TEST_CTX, event({}))).ok).toBe(true);
  expect((await executeAction(TEST_CTX, event({ title: "组会", startTime: "17:00", endTime: "18:00", location: "Zoom" }))).ok).toBe(true);
  let travel = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("travel:"));
  expect(travel.map((block) => [block.start, block.end])).toEqual([["13:30", "14:00"], ["16:00", "16:30"]]);
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "travel_minutes");
  expect(ask).toMatchObject({ entityId: "Costco Middleton", title: "去「Costco Middleton」路上要多久？" });
  expect((await answerAsk(TEST_CTX, ask!.id, "m20", {}, NOW)).ok).toBe(true);
  travel = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("travel:"));
  expect(travel.map((block) => [block.start, block.end])).toEqual([["13:40", "14:00"], ["16:00", "16:20"]]);
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "travel_minutes")).toBe(false);
  // Work is planned around the travel too.
  const work = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("scheduled:") && block.day === "2026-10-31");
  expect(work.some((block) => block.start < "14:00" && block.end > "13:40")).toBe(false);
});

test("with a home address and the map on, the place is estimated in the background and not asked", async () => {
  setup();
  await executeAction(TEST_CTX, event({}));
  setTravel(TEST_CTX, { home: "1 Main St, Madison" });
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "travel_minutes")).toBe(false);
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(url.includes("nominatim")
    ? [{ lat: url.includes("Main") ? "43.07" : "43.1", lon: "-89.4" }] : { routes: [{ duration: 17 * 60 }] })));
  expect(await refreshTravelEstimates(TEST_CTX, { fetch: fetch as unknown as typeof globalThis.fetch })).toBe(1);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { "user-agent": expect.stringContaining("Crossline") } });
  const travel = (await loadCurrentPlan(TEST_CTX)).blocks.filter((block) => block.id.startsWith("travel:"));
  expect(travel[0]).toMatchObject({ start: "13:40", tag: "约 20 分钟" });
  expect(await refreshTravelEstimates(TEST_CTX, { fetch: fetch as unknown as typeof globalThis.fetch })).toBe(0);
});

test("a map that cannot find the place says why, and the geocode miss is kept", async () => {
  const cache = {};
  const fetch = vi.fn(async () => new Response("[]"));
  expect(await estimateTravelMinutes("home", "nowhere", cache, { fetch: fetch as unknown as typeof globalThis.fetch, paced: false })).toEqual({ failed: "HOME_NOT_FOUND" });
  expect(cache).toEqual({ home: null });
});

test("a reminder is said once at its time, into the bell; one long overdue is dropped", () => {
  setup();
  addReminder(TEST_CTX, { text: "取快递", date: "2026-10-27", time: "09:00" });
  addReminder(TEST_CTX, { text: "很久以前", date: "2026-10-25", time: "09:00" });
  expect(deliverDueReminders(TEST_CTX, new Date("2026-10-27T13:30:00Z"))).toBe(0);
  expect(deliverDueReminders(TEST_CTX, new Date("2026-10-27T14:01:00Z"))).toBe(1);
  expect(deliverDueReminders(TEST_CTX, new Date("2026-10-27T14:03:00Z"))).toBe(0);
  expect(listNotices(TEST_CTX, new Date("2026-10-27T14:04:00Z")).items.map((item) => item.text)).toEqual(["取快递"]);
});

test("an errand is the assistant's own work that takes effect at once, with a departure reminder that lists the checks", async () => {
  setup();
  setPlaceMinutes(TEST_CTX, "Costco Middleton", 25);
  // An event's own words (预约, 参加, 购买) must not make the preparation read as the person's act.
  const result = createErrand(TEST_CTX, { title: "预约参加 Costco 购买会员", goal: "补货", location: "Costco Middleton", date: "2026-10-31", startTime: "14:00",
    prepare: "购物清单与营业时间", checklist: ["检查油量", "带会员卡"], lineId: "" });
  expect(result.ok).toBe(true);
  const order = getStore().listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === (result as { orderId: string }).orderId)!;
  expect(order.state).toBe("approved");
  expect(planAssistantTask(order, { projectIsCourse: false })).toMatchObject({ fit: true, delegated: true });
  const departure = getStore().getSetting(TEST_CTX.workspaceId, "schedule.reminders");
  const reminder = JSON.parse(departure!)[0];
  expect(reminderMoment(TEST_CTX, reminder)).toEqual({ time: "13:20",
    text: "「预约参加 Costco 购买会员」14:00 开始（Costco Middleton），路上约 25 分钟，宜 13:20 出发。出门前检查：检查油量、带会员卡。准备材料未能备好。" });
});

test("undoing an errand takes back its preparation and its reminder", async () => {
  setup();
  const outcome = await executeAction(TEST_CTX, { action: "errand.prepare", summary: "周六 Costco", args: { title: "Costco 采购", goal: "", location: "Costco",
    date: "2026-10-31", startTime: "14:00", prepare: "购物清单", checklist: [], lineId: "" } });
  expect(outcome).toMatchObject({ ok: true });
  expect(undoOp(TEST_CTX, (outcome as { opId: string }).opId)).toMatchObject({ ok: true });
  expect(getStore().listWorkOrders(TEST_CTX.workspaceId).find((item) => (item.payload as { errand?: unknown }).errand)?.state).toBe("archived");
  expect(JSON.parse(getStore().getSetting(TEST_CTX.workspaceId, "schedule.reminders") ?? "[]")).toEqual([]);
});
