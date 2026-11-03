import { afterEach, beforeEach, expect, test } from "vitest";
import { SCOUT_STATS_SETTING, emptyStats, readScoutStats, type Opportunity, type StoredFormRun, type StoredWatch } from "@crossline/core";
import {
  CrosslineStore, addPersonWatch, confirmOpportunityFromRun, decideWatch, editWatch, lessLog, lessOpportunity, readWatchList, readWatchTuning,
  recordApplicationResult, recordOpportunityOutcome, retireQuietWatches, saveFormRun, saveWatchList, setWatchState, settleOpportunityOutcomes,
  surfacedOpportunities, undoLessEntry, waitingIdForNeed
} from "./index";

let store: CrosslineStore;
let ws: string;
let owner: string;
const NOW = new Date("2026-11-01T12:00:00.000Z");
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("owner", "o");
  ws = created.workspace.id;
  owner = created.principal.id;
});
afterEach(() => store.close());

const watch = (over: Partial<StoredWatch> = {}): StoredWatch => ({
  id: "need:research:intern", lineId: "research", title: "暑期研究实习", why: "需要工业界研究经历", origin: "derived",
  basis: { factIds: [], milestoneIds: [], opportunityIds: [] }, query: "研究实习", tools: ["web_search"], targets: [], judge: "研究型", explore: false,
  everyDays: 3, horizonDays: 200, cycle: { opens: "2027-09", closes: "2027-11", sourceUrl: "", confirmedAt: NOW.toISOString() }, state: "proposed",
  stats: emptyStats(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), leadDays: 30, prescreen: [], weight: 1, strictness: 0, ...over
});
const opportunity = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp-1", key: "k1", needId: "need:research:intern", lineId: "research", kind: "event", title: "Lab Open Day", organizer: "Lab",
  url: "https://lab.example.org/day", registrationHost: "lab.example.org", deadlines: [{ day: "2026-12-01", quote: "Register by December 1, 2026" }],
  startsAt: { day: "2026-12-05", quote: "Saturday December 5, 2026, 6:00 PM" }, cost: null, eligibility: [], needsAccount: false, materials: [], consents: [],
  foundVia: "web", foundAt: NOW.toISOString(), ...over
});
const save = (over: Partial<Opportunity> = {}) => store.saveOpportunity(ws, { opportunity: opportunity(over), terms: [], verdict: { state: "eligible", basis: [] } }).row;

test("盯住 a cycle writes its 「预计开放」 wait; 不要 is remembered and cancels it; watching again reopens it", () => {
  saveWatchList(store, ws, [watch()]);
  decideWatch(store, ws, owner, "need:research:intern", "active", NOW);
  expect(readWatchList(store, ws)[0]?.state).toBe("active");
  const waitingId = waitingIdForNeed("need:research:intern");
  expect(store.listWaitingItems(ws, { state: "open" }).find((item) => item.id === waitingId)).toMatchObject({ expectedAt: "2027-09-01", source: "opportunity" });
  decideWatch(store, ws, owner, "need:research:intern", "retired", NOW, "不想去大公司");
  expect(readWatchList(store, ws)[0]).toMatchObject({ state: "retired", retiredBy: "person" });
  expect(store.listWaitingItems(ws, { state: "open" }).some((item) => item.id === waitingId)).toBe(false);
  expect(store.listPreferences(ws).find((pref) => pref.source === "opportunity_declined")).toMatchObject({ scope: "research", refId: "need:research:intern" });
  decideWatch(store, ws, owner, "need:research:intern", "active", NOW);
  expect(store.listWaitingItems(ws, { state: "open" }).some((item) => item.id === waitingId)).toBe(true);
});

test("the person's edit makes a watch theirs, a link in it is watched for change, and the yield rule never retires it", () => {
  const stale = { ...emptyStats(), runs: 6, cost: 50_000 };
  saveWatchList(store, ws, [watch({ id: "a", state: "active", stats: stale, createdAt: "2026-07-01T00:00:00.000Z" }),
    watch({ id: "b", state: "active", stats: { ...emptyStats(), runs: 6, outcomes: { planned: 2 }, lastYieldAt: NOW.toISOString() } }),
    watch({ id: "c", state: "active", stats: stale, createdAt: "2026-07-01T00:00:00.000Z" })]);
  editWatch(store, ws, owner, "c", { query: "看 https://lab.example.org/jobs 上的实习", everyDays: 400 }, NOW);
  expect(readWatchList(store, ws).find((item) => item.id === "c")).toMatchObject({ origin: "person", everyDays: 180,
    targets: [{ tool: "web_fetch", url: "https://lab.example.org/jobs" }] });
  expect(retireQuietWatches(store, ws, NOW).map((item) => item.id)).toEqual(["a"]);
  expect(readWatchList(store, ws).find((item) => item.id === "a")).toMatchObject({ state: "retired", retiredBy: "system" });
  setWatchState(store, ws, owner, "a", "active", NOW);
  expect(readWatchList(store, ws).find((item) => item.id === "a")?.state).toBe("active");
  const mine = addPersonWatch(store, ws, owner, { lineId: "media", title: "城市播客线下活动", query: "芝加哥 播客 meetup" }, NOW);
  expect(mine).toMatchObject({ origin: "person", state: "active", tools: ["web_search"] });
});

test("outcomes are written once and drive the stats; the scout's finds count to the scout", () => {
  saveWatchList(store, ws, [watch({ state: "active" })]);
  save();
  expect(recordOpportunityOutcome(store, ws, "opp-1", "surfaced")).toBe(true);
  expect(recordOpportunityOutcome(store, ws, "opp-1", "surfaced")).toBe(false);
  expect(recordApplicationResult(store, ws, owner, "opp-1", "rejected")).toBe(true);
  expect(readWatchList(store, ws)[0]?.stats.outcomes).toEqual({ surfaced: 1, rejected: 1 });
  expect(readWatchList(store, ws)[0]?.stats.lastYieldAt).toBeDefined();
  save({ id: "opp-s", key: "ks", needId: "scout:2026-11-01" });
  recordOpportunityOutcome(store, ws, "opp-s", "planned");
  expect(readScoutStats(store.getSetting(ws, SCOUT_STATS_SETTING)).outcomes).toEqual({ planned: 1 });
});

test("the ledger settles what it can see: submitted and confirmed from the form run, ignored after three weeks", () => {
  saveWatchList(store, ws, [watch({ state: "active" })]);
  const row = save();
  save({ id: "opp-2", key: "k2", title: "Quiet Talk", foundAt: "2026-10-01T00:00:00.000Z" });
  recordOpportunityOutcome(store, ws, "opp-2", "surfaced");
  const run = { id: "run-1", opportunityId: row.id, opportunity: row, choice: "register", host: "lab.example.org", state: "confirmed", pageNo: 1,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as unknown as StoredFormRun;
  saveFormRun(store, ws, run);
  expect(settleOpportunityOutcomes(store, ws, "2026-12-06", NOW)).toBe(3);
  expect(store.listOpportunities(ws, { id: "opp-1" })[0]?.confirmedBy).toBe("form:run-1");
  expect(readWatchList(store, ws)[0]?.stats.outcomes).toMatchObject({ submitted: 1, attended: 1, ignored: 1, surfaced: 1 });
  expect(settleOpportunityOutcomes(store, ws, "2026-12-06", NOW)).toBe(0);
  expect(confirmOpportunityFromRun(store, ws, run)).toBe(false);
});

test("少来: each reason changes its own thing, the find leaves the inbox, and undo puts back exactly that", () => {
  saveWatchList(store, ws, [watch({ state: "active" })]);
  save();
  expect(surfacedOpportunities(store, ws, "2026-11-01").map((row) => row.id)).toEqual(["opp-1"]);
  const kind = lessOpportunity(store, ws, owner, { opportunityId: "opp-1", scope: "kind", reason: "off_topic", note: "不想要线下" }, NOW)!;
  expect(readWatchList(store, ws)[0]).toMatchObject({ everyDays: 6, strictness: 1, weight: 0.5 });
  expect(store.listPreferences(ws).some((pref) => pref.source === "opportunity_less")).toBe(true);
  const known = lessOpportunity(store, ws, owner, { opportunityId: "opp-1", scope: "item", reason: "already_known" }, NOW)!;
  expect(readWatchTuning(store, ws).knownHosts).toEqual(["lab.example.org"]);
  expect(surfacedOpportunities(store, ws, "2026-11-01")).toEqual([]);
  const time = lessOpportunity(store, ws, owner, { opportunityId: "opp-1", scope: "item", reason: "bad_time" }, NOW)!;
  expect(readWatchTuning(store, ws).badTimes).toEqual([{ id: time.id, weekday: 6, part: "evening" }]);
  expect(lessLog(store, ws)).toHaveLength(3);
  expect(undoLessEntry(store, ws, owner, known.id, NOW)).toBe(true);
  expect(readWatchTuning(store, ws).knownHosts).toEqual([]);
  expect(undoLessEntry(store, ws, owner, kind.id, NOW)).toBe(true);
  expect(readWatchList(store, ws)[0]).toMatchObject({ everyDays: 3, strictness: 0, weight: 1 });
  expect(store.listPreferences(ws).some((pref) => pref.source === "opportunity_less")).toBe(false);
  expect(undoLessEntry(store, ws, owner, kind.id, NOW)).toBe(false);
  expect(store.listEvents(ws, { type: "opportunity.outcome" }).filter((event) => (event.payload as { outcome: string }).outcome === "less")).toHaveLength(3);
});

test("a scout find waits for 视野外 unless it must be prepared within two weeks", () => {
  save({ id: "opp-far", key: "kf", needId: "scout:2026-11-01", deadlines: [{ day: "2027-03-01", quote: "Due March 1, 2027" }] });
  save({ id: "opp-near", key: "kn", needId: "scout:2026-11-01", deadlines: [{ day: "2026-11-20", quote: "Due November 20, 2026" }] });
  const rows = new Map(surfacedOpportunities(store, ws, "2026-11-01").map((row) => [row.id, row.inbox]));
  expect(rows.get("opp-far")).toBe(false);
  expect(rows.get("opp-near")).toBe(true);
});
