import { expect, test } from "vitest";
import { actionProblem, type ConciergeRefs, type ProposedAction } from "./concierge";
import { departureTime, isOnlineLocation, mapAddress, readTravelState, travelBlocks, travelMinutesFor, wantsMapEstimate, type TravelState } from "./life";

const state = (over: { settings?: Partial<TravelState["settings"]>; places?: TravelState["places"]; routes?: TravelState["estimates"]["routes"] } = {}): TravelState => {
  const base = readTravelState(() => undefined);
  return { settings: { ...base.settings, ...over.settings }, places: over.places ?? {}, estimates: { routes: over.routes ?? {}, geocode: {} } };
};

test("an online place needs no travel: a meeting link or the words for it", () => {
  for (const place of ["https://zoom.us/j/123", "Teams", "线上", "腾讯会议", "Online"]) expect(isOnlineLocation(place)).toBe(true);
  for (const place of ["Costco Middleton", "Engineering Hall 1800", "牙科诊所"]) expect(isOnlineLocation(place)).toBe(false);
});

test("travel time: the person's word, then the map (only with a home), then the default, else 30 minutes and asked", () => {
  expect(travelMinutesFor("Costco", state())).toEqual({ minutes: 30, source: "assumed" });
  expect(travelMinutesFor("Costco", state({ settings: { defaultMinutes: 20 } }))).toEqual({ minutes: 20, source: "default" });
  const mapped = { routes: { costco: { minutes: 15, at: "" } } };
  expect(travelMinutesFor("Costco", state({ ...mapped, settings: { defaultMinutes: 20 } })).source).toBe("default");
  expect(travelMinutesFor("Costco", state({ ...mapped, settings: { home: "1 Main St" } }))).toEqual({ minutes: 15, source: "map" });
  expect(travelMinutesFor("Costco", state({ ...mapped, settings: { home: "1 Main St", useMap: false } })).source).toBe("assumed");
  expect(travelMinutesFor(" costco ", state({ ...mapped, places: { costco: 40 }, settings: { home: "x" } }))).toEqual({ minutes: 40, source: "person" });
  expect(travelMinutesFor("Costco", state({ places: { costco: "online" } }))).toEqual({ minutes: 0, source: "online" });
  expect(travelMinutesFor("", state())).toEqual({ minutes: 0, source: "online" });
});

test("「学校」 and 「公司」 are the work address: a map asks for it, and minutes given for one serve the other", () => {
  const withWork = state({ settings: { home: "h", work: "1415 Engineering Dr" } });
  expect(mapAddress("学校", withWork.settings)).toBe("1415 Engineering Dr");
  expect(mapAddress("Costco", withWork.settings)).toBe("Costco");
  expect(travelMinutesFor("公司", state({ settings: { work: "1415 Engineering Dr" }, places: { "1415 engineering dr": 25 } }))).toEqual({ minutes: 25, source: "person" });
  expect(wantsMapEstimate("学校", withWork)).toBe(true);
  expect(wantsMapEstimate("学校", state({ settings: { work: "x" } }))).toBe(false);
  expect(wantsMapEstimate("学校", state({ settings: { home: "h", work: "1415 Engineering Dr" }, routes: { "1415 engineering dr": { failed: "PLACE_NOT_FOUND" } } }))).toBe(false);
});

test("an event at a place gets 「路上」 before and after it inside the day; an online or placeless one gets none", () => {
  const blocks = [{ id: "event:a:2026-10-30", day: "2026-10-30", start: "14:00", end: "16:00", location: "Costco" },
    { id: "event:b:2026-10-30", day: "2026-10-30", start: "18:00", end: "19:00", location: "Zoom" },
    { id: "graph_calendar:c", day: "2026-10-30", start: "00:10", end: "23:50", location: "Airport" },
    { id: "event:d:2026-10-30", day: "2026-10-30", start: "09:00", end: "10:00" }];
  const travel = travelBlocks(blocks, state({ places: { costco: 25 } }));
  expect(travel.map((block) => [block.id, block.start, block.end])).toEqual([
    ["travel:event:a:2026-10-30:to", "13:35", "14:00"], ["travel:event:a:2026-10-30:back", "16:00", "16:25"],
    ["travel:graph_calendar:c:to", "00:00", "00:10"], ["travel:graph_calendar:c:back", "23:50", "23:59"]]);
  expect(travel[0]).toMatchObject({ title: "路上", tag: "约 25 分钟", readOnly: true });
});

test("a departure reminder is travel plus a quarter of an hour before the start", () => {
  expect(departureTime("14:00", 25)).toBe("13:20");
  expect(departureTime("00:20", 30)).toBe("00:00");
});

const refs: ConciergeRefs = { tasks: new Map(), asks: new Map(), ops: new Set(), lines: new Set(["research"]), milestones: new Set(), draftMilestones: new Set(),
  proposals: new Set(), agentResults: new Set(), today: "2026-10-27" };
const act = (action: ProposedAction["action"], args: Record<string, unknown>) => ({ action, summary: "", args } as ProposedAction);

test("the life actions are checked like every other: a reminder in the past, an errand on an unknown line, travel with nothing to set", () => {
  expect(actionProblem(act("reminder.add", { text: "取快递", date: "2026-10-28", time: "10:00" }), refs)).toBe("");
  expect(actionProblem(act("reminder.add", { text: "取快递", date: "2026-10-20", time: "" }), refs)).toContain("已过去");
  expect(actionProblem(act("reminder.add", { text: "", date: "", time: "" }), refs)).toBe("提醒内容为空");
  const errand = { title: "Costco 采购", goal: "", location: "Costco", date: "2026-10-31", startTime: "14:00", prepare: "购物清单", checklist: ["检查油量"], lineId: "" };
  expect(actionProblem(act("errand.prepare", errand), refs)).toBe("");
  expect(actionProblem(act("errand.prepare", { ...errand, lineId: "fun" }), refs)).toContain("不存在");
  expect(actionProblem(act("errand.prepare", { ...errand, startTime: "2pm" }), refs)).toContain("HH:MM");
  const travel = { home: "", work: "", place: "", minutes: 0, defaultMinutes: 0, useMap: "" };
  expect(actionProblem(act("travel.set", travel), refs)).toBe("没有要设置的内容");
  expect(actionProblem(act("travel.set", { ...travel, place: "学校", minutes: 25 }), refs)).toBe("");
  expect(actionProblem(act("travel.set", { ...travel, place: "学校", minutes: 500 }), refs)).toContain("0–240");
});
