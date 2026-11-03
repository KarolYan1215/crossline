import { describe, expect, it } from "vitest";
import { feasibilityNow, feasibilityOf, type GeoPoint } from "./feasibility";
import type { Opportunity } from "./opportunity";
import { citizenshipOf, deviceReading, homePlace, mailTripPlace, placeNameOf, roundCoord, tripsFromBlocks, withMailTrip } from "./person-places";
import { officialVisaHost, processingDays, validateVisaReading, visaCheckFrom } from "./visa";
import { validateMailTriage } from "./mail";

const fact = (slot: string, value: string, status = "confirmed") => ({ identityId: "person", slot, value, status });

describe("visa", () => {
  it("reads the worst case of a processing sentence, never a number the model states", () => {
    expect(processingDays("Applications are usually processed within 15 working days.")).toBe(21);
    expect(processingDays("Processing can take up to 8 weeks")).toBe(56);
    expect(processingDays("一般在 10 个工作日内办结")).toBe(14);
    expect(processingDays("审理时间为 2 至 3 个月")).toBe(90);
    expect(processingDays("five to ten business days")).toBe(14);
    expect(processingDays("Apply in good time before travelling")).toBeUndefined();
  });
  it("takes only government hosts", () => {
    expect(officialVisaHost("www.auswaertiges-amt.de")).toBe(true);
    expect(officialVisaHost("travel.state.gov")).toBe(true);
    expect(officialVisaHost("www.mofa.go.jp")).toBe(true);
    expect(officialVisaHost("www.canada.ca")).toBe(true);
    expect(officialVisaHost("visa-express-agency.com")).toBe(false);
    expect(officialVisaHost("gov.example.com")).toBe(false);
  });
  it("verifies only a quote found on an official page, and falls back unverified without a processing sentence", () => {
    const text = "Chinese nationals require a Schengen visa for short stays. Applications are usually processed within 15 working days.";
    const page = { url: "https://china.diplo.de/visa", needed: "yes" as const, quote: "Chinese nationals require a Schengen visa for short stays.",
      processingQuote: "Applications are usually processed within 15 working days." };
    expect(visaCheckFrom(page, text, "2026-11-02")).toMatchObject({ needed: true, leadDays: 35, verified: true });
    expect(visaCheckFrom({ ...page, processingQuote: "" }, text, "2026-11-02")).toMatchObject({ needed: true, leadDays: 60, verified: false });
    expect(visaCheckFrom({ ...page, quote: "Chinese nationals need no visa." }, text, "2026-11-02")).toBeUndefined();
    expect(visaCheckFrom({ ...page, url: "https://visa-agency.com/de" }, text, "2026-11-02")).toBeUndefined();
    expect(visaCheckFrom({ ...page, needed: "no", quote: "Chinese nationals require a Schengen visa for short stays." }, text, "x")).toMatchObject({ needed: false, leadDays: 0 });
  });
  it("sends back a non-government page or a verdict without its sentence", () => {
    expect(() => validateVisaReading({ pages: [{ url: "https://agency.com/x", needed: "yes", quote: "a", processingQuote: "" }] })).toThrow(/VISA_READING_INVALID/);
    expect(() => validateVisaReading({ pages: [{ url: "https://travel.state.gov/x", needed: "no", quote: "", processingQuote: "" }] })).toThrow(/VISA_READING_INVALID/);
    expect(validateVisaReading({ pages: [] })).toEqual({ pages: [] });
  });
});

describe("the person's places", () => {
  it("keeps a device reading to two decimals and refuses nonsense", () => {
    expect(deviceReading(43.074761, -89.384375, "t")).toEqual({ lat: 43.07, lon: -89.38, at: "t" });
    expect(deviceReading(120, 0, "t")).toBeUndefined();
    expect(roundCoord(1.005)).toBeCloseTo(1, 2);
  });
  it("reads home and citizenship only from confirmed facts, never an assumption", () => {
    expect(homePlace([fact("city", "Madison"), fact("country", "United States")])).toMatchObject({ city: "Madison", country: "United States", source: "fact" });
    expect(homePlace([fact("city", "假设：Madison")])).toBeUndefined();
    expect(homePlace([fact("city", "Madison", "inferred")])).toBeUndefined();
    expect(citizenshipOf([fact("apply.citizenship", "China")])).toBe("China");
  });
  it("reads trips from flights on the calendar until the next flight", () => {
    const trips = tripsFromBlocks([
      { id: "a", title: "Flight to Lisbon (TP 202)", day: "2026-11-10" },
      { id: "b", title: "Flight to Madison", day: "2026-11-15" }
    ], "Madison");
    expect(trips).toEqual([{ from: "2026-11-10", to: "2026-11-14", city: "Lisbon", country: "", source: "calendar", ref: "a" }]);
    expect(placeNameOf("Lisbon")).toBe("Lisbon");
    expect(placeNameOf("1210 W Dayton St")).toBeUndefined();
  });
  it("keeps a mail trip only when its quote is in the mail and it has not ended", () => {
    const mail = "Your booking is confirmed. Check-in: 20 Nov 2026, Hotel Lisboa, Lisbon. Check-out 23 Nov.";
    const trip = { city: "Lisbon", country: "Portugal", from: "2026-11-20", to: "2026-11-23", quote: "Check-in: 20 Nov 2026, Hotel Lisboa, Lisbon." };
    expect(mailTripPlace(trip, mail, "2026-11-02", "mail:1")).toMatchObject({ city: "Lisbon", source: "mail", ref: "mail:1" });
    expect(mailTripPlace({ ...trip, quote: "Check-in: 21 Nov 2026" }, mail, "2026-11-02", "mail:1")).toBeUndefined();
    expect(mailTripPlace(trip, mail, "2026-11-24", "mail:1")).toBeUndefined();
    expect(mailTripPlace({ ...trip, to: "2026-11-19" }, mail, "2026-11-02", "mail:1")).toBeUndefined();
    const kept = withMailTrip([{ ...mailTripPlace(trip, mail, "2026-11-02", "mail:1")! }, { from: "2026-10-01", to: "2026-10-03", city: "Old", country: "", source: "mail", ref: "mail:0" }],
      { ...mailTripPlace(trip, mail, "2026-11-02", "mail:1")!, city: "Lisboa" }, "2026-11-02");
    expect(kept.map((item) => item.city)).toEqual(["Lisboa"]);
  });
  it("sends back a travel mail without a dated trip and its quote", () => {
    const item = { uid: 1, kind: "travel" as const, title: "Lisbon", waitingId: "", why: "",
      money: { event: "", amount: 0, currency: "", amountLabel: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" } };
    const detail = (() => { try { validateMailTriage({ items: [{ ...item, trip: { city: "Lisbon", country: "", from: "2026-11-20", to: "", quote: "x" } }] } as never, [1], []); return ""; }
      catch (error) { return String((error as { detail?: string }).detail); } })();
    expect(detail).toMatch(/行程/);
    expect(() => validateMailTriage({ items: [{ ...item, trip: { city: "Lisbon", country: "", from: "2026-11-20", to: "2026-11-23", quote: "Check-in 20 Nov" } }] } as never, [1], [])).not.toThrow();
  });
});

describe("feasibilityNow and feasibilityOf", () => {
  const cities: Record<string, GeoPoint> = { madison: { lat: 43.07, lon: -89.4, city: "Madison", country: "United States" },
    berlin: { lat: 52.52, lon: 13.405, city: "Berlin", country: "Germany" } };
  const opportunity: Opportunity = { id: "o", key: "k", lineId: "research", kind: "event", title: "Berlin AI Summit", organizer: "x", url: "https://e.org",
    registrationHost: "e.org", deadlines: [], cost: null, eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01",
    category: "conference", startsAt: { day: "2027-01-20", quote: "January 20, 2027, 9:00–17:00 CET" }, place: { mode: "in_person", city: "Berlin", country: "Germany", quote: "Berlin" } };
  const base = { now: new Date("2026-11-02T16:00:00Z"), timeZone: "America/Chicago", prepDays: 0, citizenship: "China", blocks: [], availability: [],
    places: [{ from: "0000-01-01", to: "9999-12-31", city: "Madison", country: "United States", source: "fact" as const, ref: "f" }] };
  it("give the same verdict whether the lookups answer at once or later", async () => {
    const visa = { needed: true as const, leadDays: 35, checkedAt: "x", verified: true };
    const now = feasibilityNow(opportunity, { ...base, geocode: (query) => cities[query.city.toLowerCase()], visa: () => visa });
    const later = await feasibilityOf(opportunity, { ...base, geocode: async (query) => cities[query.city.toLowerCase()], visa: async () => visa });
    expect(later).toEqual(now);
    expect(now).toMatchObject({ state: "feasible", travel: { mode: "flight" }, visa: { leadDays: 35, verified: true } });
  });
  it("judges from what the caches hold: an unknown city is no travel, an unread visa the unverified fallback", () => {
    const verdict = feasibilityNow(opportunity, { ...base, geocode: () => undefined, visa: () => undefined });
    expect(verdict).toMatchObject({ state: "feasible", visa: { needed: "unknown", verified: false } });
    expect("travel" in verdict && verdict.travel).toBeFalsy();
  });
});
