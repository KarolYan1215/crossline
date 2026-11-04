import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { EVENT_MERGES, FIXED_EVENTS, readMergeBook } from "@crossline/core";

vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
const { ensureSeeded } = await import("./crossline");
const { decideDateBatch } = await import("./imported-dates");
const { mergePairs } = await import("./event-merges");
const { collectAsks, answerAsk } = await import("./asks");
const { loadTimeline } = await import("./timeline");
const { scheduleEvent } = await import("./event-scheduling");
const { fixedEventsToPublish } = await import("./fixed-events");
const { TEST_CTX } = await import("./test-support");

let store: CrosslineStore;
const NOW = new Date("2026-10-05T14:00:00Z"); // Monday, 09:00 in Chicago
beforeEach(() => { vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString()); store = new CrosslineStore(":memory:"); globalThis.crosslineStore = store; ensureSeeded(TEST_CTX); });
afterEach(() => { vi.unstubAllEnvs(); store.close(); globalThis.crosslineStore = undefined; });

const WS = TEST_CTX.workspaceId;
/** The class on the person's own (synced) calendar, Mondays and Fridays 14:30–15:45, for the next two weeks. */
const CLASS_DAYS = ["2026-10-05", "2026-10-09", "2026-10-12", "2026-10-16"];
function addCalendar(days = CLASS_DAYS, title = "ECE 555 Lecture") {
  const plan = store.listPlanVersions(WS)[0]!;
  const blocks = (plan.payload as { blocks?: unknown[] }).blocks ?? [];
  store.savePlanVersion({ ...plan, payload: { ...(plan.payload as object), blocks: [...blocks,
    ...days.map((day) => ({ id: `graph_calendar:uw:${day}`, lane: "human", title, day, start: "14:30", end: "15:45", source: "日历", readOnly: true, sourceKey: "acct:cal" }))] } });
}
const extract = () => store.appendEvent({
  ownerId: TEST_CTX.principalId, workspaceId: WS, idempotencyKey: "dates:extracted:b1", type: "dates.extracted", entityId: "b1",
  payload: { documentIds: ["d1"], dates: [], questions: [], dropped: [],
    recurring: [{ id: "class", title: "ECE 555 上课", project: "", weekdays: [1, 5], startTime: "14:30", endTime: "15:45", from: "2026-10-05", to: "2026-10-16",
      exceptions: [], location: "", sourceRef: "src-1", quote: "Mon and Fri 2:30PM - 3:45PM", confidence: "high" }] }
});
const merges = () => readMergeBook(store.getSetting(WS, EVENT_MERGES));
const dayItems = async (day: string) => (await loadTimeline(TEST_CTX)).items.filter((item) => item.day === day && (item.kind === "calendar" || item.kind === "import"));

test("a file's class the calendar already holds is merged by the system as the dates are adopted, once for every week", async () => {
  addCalendar();
  extract();
  expect(decideDateBatch(TEST_CTX, "b1", ["class"], "system")).toMatchObject({ ok: true });
  expect(Object.values(merges())).toEqual([expect.objectContaining({ how: "merge", by: "system", keep: expect.stringMatching(/^calendar\/acct:cal:/) })]);
  expect(mergePairs(TEST_CTX, NOW)).toHaveLength(0);
  const monday = await dayItems("2026-10-12");
  expect(monday.map((item) => item.id)).toEqual(["graph_calendar:uw:2026-10-12"]);
  expect(monday[0]).toMatchObject({ merged: ["ECE 555 上课"], tag: "已合并" });
});

test("an event the person added over the same calendar event is asked about once; merged, it is not written to the calendar again", async () => {
  addCalendar(CLASS_DAYS, "Advisor meeting");
  store.setSetting(WS, FIXED_EVENTS, JSON.stringify([{ id: "ev-1", title: "Meeting with advisor", lineId: "", repeat: { weekdays: [1, 5], from: "2026-10-05", until: "2026-12-31", exceptions: [] },
    date: "2026-10-05", start: "15:00", end: "16:00", location: "", source: "input" }]));
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_merge");
  expect(asks).toHaveLength(1);
  expect(asks[0]!.why).toContain("两周内有 4 天");
  expect(fixedEventsToPublish(TEST_CTX, NOW).some((block) => block.title === "Meeting with advisor")).toBe(true);
  expect(await answerAsk(TEST_CTX, asks[0]!.id, "merge", {})).toMatchObject({ ok: true });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "event_merge")).toBe(false);
  expect(fixedEventsToPublish(TEST_CTX, NOW).some((block) => block.title === "Meeting with advisor")).toBe(false);
  expect((await dayItems("2026-10-16")).map((item) => item.title)).toEqual(["Advisor meeting"]);
});

test("「不是同一件事」 is remembered by series: neither is hidden and the pair is not asked again", async () => {
  addCalendar(CLASS_DAYS, "Advisor meeting");
  store.setSetting(WS, FIXED_EVENTS, JSON.stringify([{ id: "ev-1", title: "Meeting with advisor", lineId: "", repeat: null,
    date: "2026-10-09", start: "15:00", end: "16:00", location: "", source: "input" }]));
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "event_merge")!;
  expect(await answerAsk(TEST_CTX, ask.id, "different", {})).toMatchObject({ ok: true });
  expect(mergePairs(TEST_CTX, NOW)).toHaveLength(0);
  expect((await dayItems("2026-10-09")).length).toBe(2);
});

test("a time typed into the input box that the calendar already holds is merged into, not made twice", async () => {
  addCalendar();
  const result = await scheduleEvent(TEST_CTX, { title: "ECE 555 上课", lineId: "", date: "2026-10-09", weekdays: [], startTime: "14:35", endTime: "15:45", until: "", minutes: 60 }, NOW);
  expect(result).toMatchObject({ ok: true, created: false, merged: [expect.objectContaining({ kind: "calendar", title: "ECE 555 Lecture" })] });
  expect(store.getSetting(WS, FIXED_EVENTS) ?? null).toBeNull();
});

test("a weekly event keeps only the weekdays the calendar does not already hold", async () => {
  addCalendar(["2026-10-05", "2026-10-12"]); // Mondays only
  const result = await scheduleEvent(TEST_CTX, { title: "ECE 555 上课", lineId: "", date: "", weekdays: [1, 3], startTime: "14:30", endTime: "15:45", until: "2026-12-31", minutes: 75 }, NOW);
  expect(result).toMatchObject({ ok: true, created: true, event: { repeat: { weekdays: [3] } }, merged: [expect.objectContaining({ kind: "calendar" })] });
});

test("a locked work block over a calendar event of the same work offers 「合并」; merged, the overlap is accepted and not asked again", async () => {
  const { lockBlock, readFrozen } = await import("./crossline");
  const { taskTitleOf } = await import("@crossline/core");
  const order = store.listWorkOrders(WS).find((item) => item.state === "approved" || item.state === "ready_for_human")!;
  addCalendar(["2026-10-06"], taskTitleOf(order));
  expect(lockBlock(TEST_CTX, `scheduled:${order.id}:v1s1`, { day: "2026-10-06", start: "14:30", end: "15:30" }, "locked")).toEqual({ ok: true });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "locked_conflict")!;
  expect(ask.options[0]).toMatchObject({ id: "merge", recommended: true });
  expect(await answerAsk(TEST_CTX, ask.id, "merge", {})).toMatchObject({ ok: true });
  expect(readFrozen(TEST_CTX, NOW).find((item) => item.blockId === `scheduled:${order.id}:v1s1`)?.overlapOk).toBe(true);
  expect(Object.values(merges())).toEqual([expect.objectContaining({ how: "merge", keep: `work:${order.id}` })]);
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "locked_conflict")).toBe(false);
});
