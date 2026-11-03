import { afterEach, expect, test, vi } from "vitest";
import { DEVICE_LOCATION_SETTING, GEO_CACHE_SETTING, geoCacheKey, type Opportunity } from "@crossline/core";
import { CrosslineStore, WORK_BLOCKS_SETTING } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk } from "./asks";
import { getStore, saveSchedulePreferences } from "./crossline";
import { recordDeviceLocation, setDeviceLocationConsent } from "./device-location";
import { answerOpportunityOffer, opportunityOfferAsks } from "./opportunities";
import { FIXED_ADJUSTMENTS_SETTING, readFixedAdjustments } from "./opportunity-space";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const NOW = new Date("2026-11-02T18:00:00.000Z"); // Monday, 12:00 in Chicago
const ws = TEST_CTX.workspaceId;
const MADISON = { lat: 43.07, lon: -89.4, city: "Madison", country: "United States", at: "2026-11-01" };
const CHICAGO = { lat: 41.88, lon: -87.63, city: "Chicago", country: "United States", at: "2026-11-01" };

const opportunity = (over: Partial<Opportunity>): Opportunity => ({
  id: "opp-1", key: "k1", lineId: "research", kind: "event", title: "AI Meetup", organizer: "Lab", url: "https://example.org/e", registrationHost: "example.org",
  deadlines: [], cost: null, eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z",
  startsAt: { day: "2026-11-20", quote: "Nov 20, 10:00–16:00" }, ...over
});
function setup(rows: Opportunity[], blocks: Array<{ id: string; title: string; day: string; start: string; end: string }> = []) {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const store = getStore();
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: [], importance: {} });
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "home_city", value: "Madison", status: "confirmed", sourceRef: "", sourceQuote: "", updatedAt: "2026-11-01" });
  store.setSetting(ws, GEO_CACHE_SETTING, JSON.stringify({ [geoCacheKey({ city: "Madison" })]: MADISON, [geoCacheKey({ city: "Madison", country: "United States" })]: MADISON,
    [geoCacheKey({ city: "Chicago", country: "United States" })]: CHICAGO }));
  store.setSetting(ws, WORK_BLOCKS_SETTING, JSON.stringify(blocks));
  for (const row of rows) store.saveOpportunity(ws, { opportunity: row, terms: [], verdict: { state: "eligible", basis: [] } });
}

test("a local event too far away is not offered; one in town is, with where it is and the journey", () => {
  setup([opportunity({ id: "far", key: "far", category: "local_event", place: { mode: "in_person", city: "Chicago", country: "United States", quote: "Chicago" } }),
    opportunity({ id: "near", key: "near", category: "local_event", place: { mode: "in_person", city: "Madison", country: "United States", quote: "Madison" } })]);
  const asks = opportunityOfferAsks(TEST_CTX, NOW);
  expect(asks.map((ask) => ask.entityId)).toEqual(["near"]);
  expect(asks[0]!.why).toContain("现场举行：Madison，United States。");
  expect(asks[0]!.why).toMatch(/路上：约 0 公里，步行单程约 \d+ 分钟/);
});

test("a clash with a fixed arrangement is explained; agreeing to move it asks how, and the answer is kept and undoable", async () => {
  setup([opportunity({ place: { mode: "in_person", city: "Madison", country: "United States", quote: "Madison" } })],
    [{ id: "event:ev-1", title: "Lab meeting", day: "2026-11-20", start: "10:30", end: "11:30" },
      { id: "scheduled:wo-1:v1s1", title: "Write report", day: "2026-11-20", start: "14:00", end: "15:00" }]);
  const [card] = opportunityOfferAsks(TEST_CTX, NOW);
  expect(card!.why).toContain("与「Lab meeting」（11-20 10:30–11:30，固定安排）冲突；移动它需要本人同意");
  expect(card!.why).toContain("与「Write report」（11-20 14:00–15:00，工作块）冲突；报名或加入计划后会重排");
  expect(card!.options.map((option) => option.id)).toContain("adjust");
  expect(card!.options.map((option) => option.id)).not.toContain("adjust_move");
  const agreed = await answerAsk(TEST_CTX, card!.id, "adjust", {}, NOW);
  expect(agreed).toMatchObject({ ok: true, op: { id: expect.any(String) } });
  const [how] = opportunityOfferAsks(TEST_CTX, NOW);
  expect(how!.options.map((option) => option.id)).toEqual(expect.arrayContaining(["adjust_move", "adjust_skip", "adjust_self", "adjust_note"]));
  expect(await answerOpportunityOffer(TEST_CTX, how!, "adjust_move", {}, NOW)).toEqual({ ok: false, code: "OPPORTUNITY_ADJUST_DAY_REQUIRED" });
  const moved = await answerAsk(TEST_CTX, how!.id, "adjust_move", { day: "2026-11-21" }, NOW);
  expect(moved.ok).toBe(true);
  expect(readFixedAdjustments(TEST_CTX)).toEqual([expect.objectContaining({ opportunityId: "opp-1", how: "move", toDay: "2026-11-21", blockIds: ["event:ev-1"] })]);
  expect(getStore().getSetting(ws, FIXED_ADJUSTMENTS_SETTING)).toBeTruthy();
  // Answered: no more adjustment options on the card.
  expect(opportunityOfferAsks(TEST_CTX, NOW)[0]!.options.some((option) => option.id.startsWith("adjust"))).toBe(false);
});

test("the device location is kept only while its consent is on, rounded to about 1 km; turning it off deletes it", () => {
  setup([]);
  expect(recordDeviceLocation(TEST_CTX, 43.074761, -89.384375, NOW)).toEqual({ ok: false, code: "DEVICE_LOCATION_NOT_ENABLED" });
  setDeviceLocationConsent(TEST_CTX, true);
  expect(recordDeviceLocation(TEST_CTX, "x", 1, NOW)).toEqual({ ok: false, code: "DEVICE_LOCATION_INVALID" });
  expect(recordDeviceLocation(TEST_CTX, 43.074761, -89.384375, NOW)).toEqual({ ok: true });
  expect(JSON.parse(getStore().getSetting(ws, DEVICE_LOCATION_SETTING)!)).toEqual({ lat: 43.07, lon: -89.38, at: NOW.toISOString() });
  setDeviceLocationConsent(TEST_CTX, false);
  expect(getStore().getSetting(ws, DEVICE_LOCATION_SETTING)).toBeFalsy();
});
