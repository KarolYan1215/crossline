import { describe, expect, it } from "vitest";
import {
  blockIsFixed, countryKey, eventClashes, feasibilityOf, haversineKm, instantInZone, opportunityCategory, placeOn, quotedClock, quotedInstant,
  quotedRange, quotedZoneOffset, travelEstimate, type FeasibilityContext, type GeoPoint
} from "./feasibility";
import type { Opportunity } from "./opportunity";
import type { PersonPlace, VisaCheck } from "./opportunity-watch";

const CITIES: Record<string, GeoPoint> = {
  madison: { lat: 43.07, lon: -89.4, city: "Madison", country: "United States" },
  chicago: { lat: 41.88, lon: -87.63, city: "Chicago", country: "United States" },
  berlin: { lat: 52.52, lon: 13.405, city: "Berlin", country: "Germany" }
};
const home: PersonPlace = { from: "0000-01-01", to: "9999-12-31", city: "Madison", country: "United States", source: "fact", ref: "person//city" };

const opportunity = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "o1", key: "k", lineId: "research", kind: "event", title: "Reading group meetup", organizer: "Lab", url: "https://example.org/e",
  registrationHost: "example.org", deadlines: [], cost: null, eligibility: [], needsAccount: false, materials: [], consents: [],
  foundVia: "web", foundAt: "2026-11-01T00:00:00Z", ...over
});
const context = (over: Partial<FeasibilityContext> = {}): FeasibilityContext => ({
  now: new Date("2026-11-02T16:00:00Z"), timeZone: "America/Chicago", prepDays: 0, places: [home],
  geocode: (query) => CITIES[query.city.toLowerCase()], visa: () => undefined, blocks: [], availability: [], ...over
});
const visaOf = (leadDays: number): VisaCheck => ({ needed: true, leadDays, sourceUrl: "https://example.de/visa", quote: "x", checkedAt: "2026-11-01", verified: true });

describe("quotes", () => {
  it("reads clocks, zones and ranges", () => {
    expect(quotedClock("Due November 15, 11:59 PM AoE")).toBe("23:59");
    expect(quotedClock("截止 23:59")).toBe("23:59");
    expect(quotedClock("by noon")).toBe("12:00");
    expect(quotedZoneOffset("11:59 PM AoE")).toBe(-720);
    expect(quotedZoneOffset("5 PM PST")).toBe(-480);
    expect(quotedZoneOffset("23:59 UTC+8")).toBe(480);
    expect(quotedZoneOffset("截止 23:59 CST，中国标准时间")).toBe(480);
    expect(quotedZoneOffset("11:59 PM CST")).toBe(-360);
    expect(quotedZoneOffset("Submit your paper")).toBeUndefined();
    expect(quotedRange("Nov 20, 7:00 PM – 9:00 PM")).toEqual({ start: "19:00", end: "21:00" });
    expect(quotedRange("11月20日 19:00-21:00")).toEqual({ start: "19:00", end: "21:00" });
    expect(quotedRange("Nov 20, 7–9pm")).toEqual({ start: "19:00", end: "21:00" });
  });
  it("finds the instant in the quote's zone, else the person's", () => {
    expect(new Date(quotedInstant({ day: "2026-11-15", quote: "11:59 PM AoE" }, "America/Chicago")!).toISOString()).toBe("2026-11-16T11:59:00.000Z");
    expect(new Date(quotedInstant({ day: "2026-11-15", quote: "Nov 15" }, "America/Chicago")!).toISOString()).toBe("2026-11-16T05:59:00.000Z");
    // The DST change on 2026-11-01 in Chicago: before it CDT (−5), after CST (−6).
    expect(new Date(instantInZone("2026-10-31", "12:00", "America/Chicago")).toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(new Date(instantInZone("2026-11-02", "12:00", "America/Chicago")).toISOString()).toBe("2026-11-02T18:00:00.000Z");
  });
});

describe("space", () => {
  it("measures and estimates by the rule table", () => {
    expect(haversineKm(CITIES.madison!, CITIES.chicago!)).toBeGreaterThan(195);
    expect(haversineKm(CITIES.madison!, CITIES.chicago!)).toBeLessThan(215);
    expect(travelEstimate(1).mode).toBe("walk");
    expect(travelEstimate(10)).toMatchObject({ mode: "transit", minutesOneWay: 34, nights: 0, costTier: "low" });
    expect(travelEstimate(200)).toMatchObject({ mode: "rail", minutesOneWay: 198, nights: 1, travelDays: 1, costTier: "medium" });
    expect(travelEstimate(7000)).toMatchObject({ mode: "flight", nights: 2, travelDays: 1, costTier: "high" });
  });
  it("keys countries however written", () => {
    expect(countryKey("美国")).toBe(countryKey("United States"));
    expect(countryKey("the Netherlands")).toBe("nl");
    expect(countryKey("Atlantis")).toBe("atlantis");
  });
  it("picks a trip over home and the device only for its own day", () => {
    const trip: PersonPlace = { from: "2026-11-20", to: "2026-11-23", city: "Berlin", country: "Germany", source: "calendar", ref: "graph_calendar:f" };
    const device: PersonPlace = { from: "2026-11-02", to: "2026-11-02", city: "Chicago", country: "United States", source: "device", ref: "device" };
    expect(placeOn("2026-11-21", [home, trip, device])?.city).toBe("Berlin");
    expect(placeOn("2026-11-02", [home, trip, device])?.city).toBe("Chicago");
    expect(placeOn("2026-11-10", [home, trip, device])?.city).toBe("Madison");
  });
  it("classifies categories from kind and title", () => {
    expect(opportunityCategory({ kind: "event", title: "Friday talk" })).toBe("local_event");
    expect(opportunityCategory({ kind: "event", title: "NeurIPS Workshop" })).toBe("conference");
    expect(opportunityCategory({ kind: "event", title: "ETH Hackathon" })).toBe("competition");
    expect(opportunityCategory({ kind: "application", title: "Research Intern" })).toBe("internship");
  });
});

/** Counterfactual pairs (§17.9 ③): one fact changes, the verdict must flip. */
describe("feasibilityOf: counterfactual pairs", () => {
  it("zone abbreviation: AoE is still open, CET has closed", async () => {
    const now = new Date("2026-11-16T10:00:00Z"); // 04:00 on the 16th in Chicago
    const aoe = opportunity({ deadlines: [{ day: "2026-11-15", quote: "Deadline: November 15, 11:59 PM AoE" }] });
    const cet = opportunity({ deadlines: [{ day: "2026-11-15", quote: "Deadline: November 15, 11:59 PM CET" }] });
    expect((await feasibilityOf(aoe, context({ now }))).state).toBe("feasible");
    const closed = await feasibilityOf(cet, context({ now }));
    expect(closed.state === "infeasible" && closed.reasons[0]?.code).toBe("expired");
  });
  it("zone abbreviation: PST later than EST across the person's midnight", async () => {
    const now = new Date("2026-11-16T06:30:00Z"); // 00:30 Chicago, the 16th
    expect((await feasibilityOf(opportunity({ deadlines: [{ day: "2026-11-15", quote: "11:59 PM PST" }] }), context({ now }))).state).toBe("feasible");
    expect((await feasibilityOf(opportunity({ deadlines: [{ day: "2026-11-15", quote: "11:59 PM EST" }] }), context({ now }))).state).toBe("infeasible");
  });
  it("year boundary: preparation across New Year", async () => {
    const now = new Date("2026-12-29T15:00:00Z");
    const item = opportunity({ kind: "application", title: "Winter fellowship", deadlines: [{ day: "2027-01-04", quote: "Apply by January 4, 2027" }] });
    const late = await feasibilityOf(item, context({ now, prepDays: 7 }));
    expect(late.state === "infeasible" && late.reasons[0]?.code).toBe("no_time_to_prepare");
    const ok = await feasibilityOf(item, context({ now, prepDays: 5 }));
    expect(ok.state === "feasible" && ok.latestStart).toBe("2026-12-30");
  });
  it("date to be announced: no deadline and no start day is feasible with the date unconfirmed; the same with a near deadline is not", async () => {
    // D10: the TBD visiting program used to be anchored on today and always came back no_time_to_prepare.
    const item = (over: Partial<Opportunity> = {}) => opportunity({ kind: "application", title: "Visiting Student Program 2027",
      startsAt: { day: "2027", quote: "Summer 2027 (dates TBD)" }, place: { mode: "in_person", city: "Berlin", country: "Germany", quote: "Berlin" }, ...over });
    const tbd = await feasibilityOf(item(), context({ prepDays: 14, citizenship: "China", visa: () => visaOf(35) }));
    expect(tbd).toMatchObject({ state: "feasible", dateUnconfirmed: true, latestStart: "2026-11-02", visa: { leadDays: 35 } });
    const dated = await feasibilityOf(item({ deadlines: [{ day: "2026-11-10", quote: "Apply by November 10, 2026" }] }), context({ prepDays: 14 }));
    expect(dated.state === "infeasible" && dated.reasons[0]?.code).toBe("no_time_to_prepare");
    const datedLater = await feasibilityOf(item({ deadlines: [{ day: "2027-01-10", quote: "Apply by January 10, 2027" }] }),
      context({ prepDays: 14, citizenship: "China", visa: () => visaOf(35) }));
    expect(datedLater.state).toBe("feasible");
    expect(datedLater.state === "feasible" && datedLater.dateUnconfirmed).toBeUndefined();
  });
  it("leap year: counting back over February 29", async () => {
    const now = new Date("2028-02-20T15:00:00Z");
    const item = opportunity({ kind: "application", title: "Spring program", deadlines: [{ day: "2028-03-01", quote: "Due March 1, 2028" }] });
    const ok = await feasibilityOf(item, context({ now, prepDays: 1 }));
    expect(ok.state === "feasible" && ok.latestStart).toBe("2028-02-29");
    // Ten days back from March 1 is February 20 only because February has 29 days; one more day of preparation is too late.
    const fine = await feasibilityOf(item, context({ now, prepDays: 10 }));
    expect(fine.state === "feasible" && fine.latestStart).toBe("2028-02-20");
    const tight = await feasibilityOf(item, context({ now, prepDays: 11 }));
    expect(tight.state === "infeasible" && tight.reasons[0]?.detail).toContain("2028-02-19");
  });
  it("too far: a local meetup in Chicago is too far from Madison, the same in Madison is not", async () => {
    const at = (city: string) => opportunity({ startsAt: { day: "2026-11-20", quote: "Nov 20, 7:00 PM – 9:00 PM" }, place: { mode: "in_person", city, country: "United States", quote: city } });
    const far = await feasibilityOf(at("Chicago"), context());
    expect(far.state === "infeasible" && far.reasons[0]?.code).toBe("too_far");
    expect((await feasibilityOf(at("Madison"), context())).state).toBe("feasible");
    // The same city as a conference carries its travel instead.
    const conference = await feasibilityOf({ ...at("Chicago"), title: "Midwest ML Symposium" }, context());
    expect(conference.state === "feasible" && conference.travel).toMatchObject({ mode: "rail", nights: 1, costTier: "medium" });
    // 「太远」 tightened the radius: a 34-minute trip stops being local enough.
    const near = opportunity({ startsAt: { day: "2026-11-20", quote: "Nov 20" }, place: { mode: "in_person", lat: 43.0, lon: -89.31, quote: "x" } });
    expect((await feasibilityOf(near, context())).state).toBe("feasible");
    expect((await feasibilityOf(near, context({ localMinutesMax: 15 }))).state).toBe("infeasible");
  });
  it("hybrid is never too far, online needs no place", async () => {
    const hybrid = opportunity({ startsAt: { day: "2026-11-20", quote: "Nov 20" }, place: { mode: "hybrid", city: "Chicago", quote: "Chicago or Zoom" } });
    expect((await feasibilityOf(hybrid, context())).state).toBe("feasible");
    const online = opportunity({ startsAt: { day: "2026-11-20", quote: "Nov 20" }, place: { mode: "online", quote: "Zoom" } });
    const verdict = await feasibilityOf(online, context({ places: [] }));
    expect(verdict.state === "feasible" && verdict.travel).toBeUndefined();
  });
  it("visa too late: a Berlin conference in 30 days, lead 45 versus 14", async () => {
    const berlin = opportunity({ title: "Berlin AI Conference", startsAt: { day: "2026-12-02", quote: "December 2, 2026" },
      place: { mode: "in_person", city: "Berlin", country: "Germany", quote: "Berlin, Germany" } });
    const slow = await feasibilityOf(berlin, context({ citizenship: "China", visa: () => visaOf(45) }));
    expect(slow.state === "infeasible" && slow.reasons[0]?.code).toBe("visa_too_late");
    const quick = await feasibilityOf(berlin, context({ citizenship: "China", visa: () => visaOf(14) }));
    expect(quick.state === "feasible" && quick.visa?.verified).toBe(true);
    // Nothing official could be read: the fallback of 60 days, unverified, makes it too late.
    const unknown = await feasibilityOf(berlin, context({ citizenship: "China" }));
    expect(unknown.state === "infeasible" && unknown.reasons[0]?.detail).toContain("未核实");
    // A German going home needs none.
    expect((await feasibilityOf(berlin, context({ citizenship: "Deutschland", visa: () => visaOf(45) }))).state).toBe("feasible");
  });
  it("visa runs beside the application when the deadline comes first", async () => {
    const berlin = opportunity({ title: "Berlin Summer School", deadlines: [{ day: "2026-11-20", quote: "Apply by Nov 20" }],
      startsAt: { day: "2027-03-01", quote: "March 1, 2027" }, place: { mode: "in_person", city: "Berlin", country: "Germany", quote: "Berlin" } });
    const verdict = await feasibilityOf(berlin, context({ prepDays: 7, citizenship: "China", visa: () => visaOf(45) }));
    expect(verdict.state === "feasible" && verdict.latestStart).toBe("2026-11-13");
  });
  it("a fixed clash versus a movable one", async () => {
    const meetup = opportunity({ startsAt: { day: "2026-11-20", quote: "Nov 20, 7:00 PM – 9:00 PM" }, place: { mode: "in_person", city: "Madison", quote: "Madison" } });
    const fixed = await feasibilityOf(meetup, context({ blocks: [{ id: "graph_calendar:a:b:c", title: "ECE 555 lecture", day: "2026-11-20", start: "18:00", end: "19:15" }] }));
    expect(fixed.state === "conflict" && fixed.clashes[0]?.fixed).toBe(true);
    const movable = await feasibilityOf(meetup, context({ blocks: [{ id: "scheduled:wo-1:v1s1", title: "作业 3", day: "2026-11-20", start: "18:00", end: "19:15" }] }));
    expect(movable.state === "conflict" && movable.clashes[0]?.fixed).toBe(false);
    const clear = await feasibilityOf(meetup, context({ blocks: [{ id: "graph_calendar:x", title: "Lunch", day: "2026-11-20", start: "12:00", end: "13:00" }] }));
    expect(clear.state).toBe("feasible");
  });
  it("no free time on the day the event falls on", async () => {
    const saturday = opportunity({ startsAt: { day: "2026-11-21", quote: "Saturday Nov 21" }, place: { mode: "online", quote: "Zoom" } });
    const weekdays = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", energy: "medium" as const }];
    const none = await feasibilityOf(saturday, context({ availability: weekdays }));
    expect(none.state === "infeasible" && none.reasons[0]?.code).toBe("no_free_time");
    expect((await feasibilityOf(saturday, context({ availability: [...weekdays, { days: [6], start: "10:00", end: "12:00", energy: "low" }] }))).state).toBe("feasible");
  });
  it("an in-person local event nobody can place is not shown", async () => {
    const nowhere = opportunity({ startsAt: { day: "2026-11-20", quote: "Nov 20" }, place: { mode: "in_person", city: "Atlantis", quote: "Atlantis" } });
    const verdict = await feasibilityOf(nowhere, context());
    expect(verdict.state === "infeasible" && verdict.reasons[0]?.code).toBe("place_unknown");
  });
});

describe("clashes", () => {
  it("reads fixed from the block id and counts the evening before a travel day", () => {
    expect(blockIsFixed({ id: "scheduled:a" })).toBe(false);
    expect(blockIsFixed({ id: "event:x" })).toBe(true);
    expect(blockIsFixed({ id: "scheduled:a", fixed: true })).toBe(true);
    const clashes = eventClashes({ day: "2026-11-20", travelMinutes: 200, travelDays: 1 }, [
      { id: "graph_calendar:1", title: "Seminar", day: "2026-11-19", start: "18:00", end: "19:00" },
      { id: "graph_calendar:2", title: "Morning", day: "2026-11-19", start: "09:00", end: "10:00" }
    ]);
    expect(clashes.map((clash) => clash.title)).toEqual(["Seminar"]);
  });
});
