import { afterEach, beforeEach, expect, test } from "vitest";
import { GEO_CACHE_SETTING, VISA_CACHE_SETTING, geoCacheKey, readVisaCache, type Opportunity, type StoredWatch } from "@crossline/core";
import { CrosslineStore, WORK_BLOCKS_SETTING } from "@crossline/db";
import { geoQueryAllowed, geocoderFor, resetGeoPacing } from "./geo";
import { CLASH_SAID_SETTING, VISA_FINDER, discoveryFeasibility, findVisa, timeSpacePass } from "./time-space";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  resetGeoPacing();
});
afterEach(() => store.close());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const page = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

test("the geocoder asks only about a city or venue, one request a second, and keeps every answer and miss", async () => {
  const asked: string[] = [];
  const slept: number[] = [];
  let clock = 1_000_000;
  const http = { isPublicHost: async () => true, fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input));
    expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(/^Crossline\/1\.0 \(personal planner/);
    return String(input).includes("Nowhere") ? json([]) : json([{ lat: "43.07", lon: "-89.40", address: { city: "Madison", country: "United States" } }]);
  }) as typeof fetch };
  const geocoder = geocoderFor(store, ws, { http, sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => new Date(clock) });
  expect(await geocoder.geocode({ city: "Madison" })).toMatchObject({ lat: 43.07, city: "Madison" });
  expect(await geocoder.geocode({ city: "Nowhere" })).toBeUndefined();
  expect(slept).toEqual([1100]);
  // Cached: no request, and the miss is kept too.
  expect(await geocoder.geocode({ city: "Madison" })).toMatchObject({ city: "Madison" });
  expect(await geocoder.geocode({ city: "Nowhere" })).toBeUndefined();
  expect(asked).toHaveLength(2);
  expect(asked[0]).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search\?.*city=Madison/);
  // A street address or a link is never sent.
  expect(geoQueryAllowed({ city: "Madison", venue: "1210 W Dayton Street" })).toBe(false);
  expect(geoQueryAllowed({ city: "https://maps.example/x" })).toBe(false);
  expect(await geocoder.geocode({ city: "Madison", venue: "1210 W Dayton Street" })).toBeUndefined();
  expect(asked).toHaveLength(2);
  // Reverse lookups are city level from a rounded position.
  await geocoder.reverse(43.074761, -89.384375);
  expect(asked[2]).toMatch(/reverse\?.*zoom=10.*lat=43\.07&lon=-89\.38$/);
});

test("a service that does not answer is not cached as a place that does not exist", async () => {
  let up = false;
  const http = { isPublicHost: async () => true, fetchImpl: (async () => up ? json([{ lat: "1", lon: "2", address: { city: "X" } }]) : new Response("busy", { status: 503 })) as unknown as typeof fetch };
  const geocoder = geocoderFor(store, ws, { http, sleep: async () => {} });
  expect(await geocoder.geocode({ city: "X" })).toBeUndefined();
  up = true;
  expect(await geocoder.geocode({ city: "X" })).toMatchObject({ lat: 1, lon: 2 });
});

const visaPage = "<html><body><p>Chinese nationals require a Schengen visa for short stays.</p><p>Applications are usually processed within 15 working days.</p></body></html>";
const visaAnswer = { pages: [{ url: "https://china.diplo.de/visa", needed: "yes", quote: "Chinese nationals require a Schengen visa for short stays.",
  processingQuote: "Applications are usually processed within 15 working days." }] };

test("a visa is verified on the official page itself and cached; the days come from the page's sentence", async () => {
  const runtime = fakeRuntime([JSON.stringify(visaAnswer)], VISA_FINDER);
  const http = { isPublicHost: async () => true, fetchImpl: (async () => page(visaPage)) as unknown as typeof fetch };
  const deps = { client: () => runtime.rpc, cwd: ".", http, webBlocker: () => undefined, now: () => new Date("2026-11-02T12:00:00Z") };
  const check = await findVisa(store, ws, "China", "Germany", deps);
  expect(check).toMatchObject({ needed: true, leadDays: 35, verified: true, sourceUrl: "https://china.diplo.de/visa" });
  expect(Object.values(readVisaCache(store.getSetting(ws, VISA_CACHE_SETTING)))).toHaveLength(1);
  // From the cache: no second run.
  expect(await findVisa(store, ws, "China", "Germany", { ...deps, client: () => undefined })).toMatchObject({ leadDays: 35 });
});

test("a visa page whose sentence is not on it keeps only the unverified fallback", async () => {
  const runtime = fakeRuntime([JSON.stringify(visaAnswer)], VISA_FINDER);
  const http = { isPublicHost: async () => true, fetchImpl: (async () => page("<p>Nothing about visas here.</p>")) as unknown as typeof fetch };
  const check = await findVisa(store, ws, "China", "Germany", { client: () => runtime.rpc, cwd: ".", http, webBlocker: () => undefined });
  expect(check).toMatchObject({ needed: "unknown", leadDays: 60, verified: false });
});

const meetup = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp-1", key: "k1", lineId: "research", kind: "event", title: "Madison AI Meetup", organizer: "Lab", url: "https://example.org/e", registrationHost: "example.org",
  deadlines: [], cost: null, eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z",
  startsAt: { day: "2026-11-20", quote: "Nov 20, 10:00–16:00" }, place: { mode: "in_person", city: "Madison", country: "United States", quote: "Madison" }, ...over
});
const seed = (blocks: Array<{ id: string; title: string; day: string; start: string; end: string }>) => {
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "home_city", value: "Madison", status: "confirmed", sourceRef: "", sourceQuote: "", updatedAt: "2026-11-01" });
  const point = { lat: 43.07, lon: -89.4, city: "Madison", country: "United States", at: "2026-11-01" };
  store.setSetting(ws, GEO_CACHE_SETTING, JSON.stringify({ [geoCacheKey({ city: "Madison" })]: point, [geoCacheKey({ city: "Madison", country: "United States" })]: point }));
  store.setSetting(ws, WORK_BLOCKS_SETTING, JSON.stringify(blocks));
  store.saveOpportunity(ws, { opportunity: meetup(), terms: [], verdict: { state: "eligible", basis: [] } });
};
const deps = (at: string) => ({ client: () => undefined, cwd: ".", now: () => new Date(at),
  http: { isPublicHost: async () => true, fetchImpl: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch } });

test("a clash with a fixed arrangement is told once, by day; a work block is left to the scheduler", async () => {
  seed([{ id: "event:ev-1", title: "Lab meeting", day: "2026-11-20", start: "10:30", end: "11:30" },
    { id: "scheduled:wo-1:v1s1", title: "Write report", day: "2026-11-20", start: "14:00", end: "15:00" }]);
  // Night in Chicago (03:00): nothing is sent; the morning pass sends it.
  expect((await timeSpacePass(store, ws, deps("2026-11-02T09:00:00Z"))).told).toBe(0);
  const day = await timeSpacePass(store, ws, deps("2026-11-02T18:00:00Z"));
  expect(day).toMatchObject({ judged: 1, told: 1, geocoded: 0 });
  const said = JSON.parse(store.getSetting(ws, CLASH_SAID_SETTING) ?? "{}") as Record<string, string>;
  expect(Object.keys(said)).toEqual(["opp-1:event:ev-1@2026-11-20T10:30"]);
  expect((await timeSpacePass(store, ws, deps("2026-11-02T19:00:00Z"))).told).toBe(0);
});

test("a clash with work blocks alone sends nothing", async () => {
  seed([{ id: "scheduled:wo-1:v1s1", title: "Write report", day: "2026-11-20", start: "14:00", end: "15:00" }]);
  expect((await timeSpacePass(store, ws, deps("2026-11-02T18:00:00Z"))).told).toBe(0);
});

test("a watch run judges each find with the watch's lead and radius; an event one turns up to needs no preparation", async () => {
  seed([]);
  const town = { lat: 43.1, lon: -89.5, city: "Middleton", country: "United States", at: "2026-11-01" };
  const cache = JSON.parse(store.getSetting(ws, GEO_CACHE_SETTING) ?? "{}") as Record<string, unknown>;
  store.setSetting(ws, GEO_CACHE_SETTING, JSON.stringify({ ...cache, [geoCacheKey({ city: "Middleton", country: "United States" })]: town }));
  const away = meetup({ place: { mode: "in_person", city: "Middleton", country: "United States", quote: "Middleton" } });
  const check = discoveryFeasibility(deps("2026-11-02T18:00:00Z"));
  const now = new Date("2026-11-02T18:00:00Z");
  const watch = { id: "need:research:talks", leadDays: 30 } as StoredWatch;
  // An event in the next town 18 days out under a 30-day lead: no preparation counted, so it stands.
  const stands = await check(away, { store, workspaceId: ws, now, watch });
  expect(stands?.state).not.toBe("infeasible");
  // The same event under a radius of ten minutes (「少来·太远」 tightened it) is too far.
  const near = await check(away, { store, workspaceId: ws, now, watch: { ...watch, radiusMinutes: 10 } });
  expect(near).toMatchObject({ state: "infeasible", reasons: [expect.objectContaining({ code: "too_far" })] });
  // An application takes the watch's lead.
  const late = await check(meetup({ kind: "application", deadlines: [{ day: "2026-11-20", quote: "Apply by Nov 20" }] }), { store, workspaceId: ws, now, watch });
  expect(late).toMatchObject({ state: "infeasible", reasons: [expect.objectContaining({ code: "no_time_to_prepare" })] });
});
