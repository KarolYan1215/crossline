import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, readWatchList, readWatchTuning, saveFormRun, saveWatchList } from "@crossline/db";
import { RUNTIME_OWNER_SETTING, emptyStats, validateAskAnswer, type Ask, type Opportunity, type StoredFormRun, type StoredWatch } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import {
  addWatch, answerApplicationResult, answerOpportunityNeed, answerOpportunityOffer, changeWatch, loadLineWatches, loadOpportunitySettings, loadOutOfView,
  opportunityNeedAsks, opportunityOfferAsks, undoLess
} from "./opportunities";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const NOW = new Date("2026-11-01T15:00:00.000Z");
const ws = TEST_CTX.workspaceId;

function setup(owner = true) {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  if (owner) store.setSetting(ws, RUNTIME_OWNER_SETTING, "1");
  else vi.stubEnv("CROSSLINE_PUBLIC_BETA", "1");
  return store;
}
const watch = (over: Partial<StoredWatch> = {}): StoredWatch => ({
  id: "need:research:intern", lineId: "research", title: "暑期研究实习", why: "需要工业界研究经历", origin: "derived",
  basis: { factIds: [], milestoneIds: [], opportunityIds: [] }, query: "研究实习", tools: ["web_search"], targets: [], judge: "研究型", explore: false,
  everyDays: 3, horizonDays: 200, state: "proposed", stats: emptyStats(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), leadDays: 30,
  prescreen: [], weight: 1, strictness: 0, ...over
});
const opportunity = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp-1", key: "k1", needId: "need:research:intern", lineId: "research", kind: "event", title: "Lab Open Day", organizer: "Lab",
  url: "https://lab.example.org/day", registrationHost: "lab.example.org", deadlines: [{ day: "2026-11-20", quote: "Register by November 20, 2026" }],
  startsAt: { day: "2026-11-21", quote: "Saturday November 21, 2026, 6:00 PM" }, cost: null, eligibility: [], needsAccount: false, materials: [], consents: [],
  foundVia: "web", foundAt: NOW.toISOString(), ...over
});
const save = (store: CrosslineStore, over: Partial<Opportunity> = {}) =>
  store.saveOpportunity(ws, { opportunity: opportunity(over), terms: [], verdict: { state: "eligible", basis: [] } }).row;
const offer = (asks: Ask[], id: string) => asks.find((ask) => ask.id === id)!;

test("a proposed watch is a 盯住 / 不要 card; the scout's proposals wait for 视野外 instead", () => {
  const store = setup();
  saveWatchList(store, ws, [watch(), watch({ id: "explore:research:labs", origin: "scout", explore: true, title: "城市实验室开放日" })]);
  const asks = opportunityNeedAsks(TEST_CTX, NOW);
  expect(asks.map((ask) => ask.entityId)).toEqual(["need:research:intern"]);
  expect(answerOpportunityNeed(TEST_CTX, asks[0]!, "track", {})).toEqual({ ok: true });
  expect(readWatchList(store, ws)[0]?.state).toBe("active");
  expect(loadOutOfView(TEST_CTX, NOW).watches.map((item) => item.id)).toEqual(["explore:research:labs"]);
  expect(loadLineWatches(TEST_CTX).research?.map((item) => item.id)).toEqual(["need:research:intern"]);
});

test("two or more proposed watches are one card: 都盯住 tracks them all, 逐个看 splits it; one unanswered for 14 days stops asking but stays proposed (W-228)", () => {
  const store = setup();
  saveWatchList(store, ws, [watch(), watch({ id: "need:research:conf", title: "学术会议投稿" }),
    watch({ id: "need:research:old", title: "旧的提议", createdAt: "2026-10-10T00:00:00.000Z" })]);
  const [card] = opportunityNeedAsks(TEST_CTX, NOW);
  expect(opportunityNeedAsks(TEST_CTX, NOW)).toHaveLength(1);
  expect(card).toMatchObject({ entityId: "batch", title: "2 个机会来源等本人决定要不要盯" });
  expect(card!.items!.map((item) => item.title)).toEqual(["暑期研究实习", "学术会议投稿"]);
  expect(answerOpportunityNeed(TEST_CTX, card!, "split", {})).toEqual({ ok: true });
  expect(opportunityNeedAsks(TEST_CTX, NOW).map((ask) => ask.entityId)).toEqual(["need:research:intern", "need:research:conf"]);
  expect(answerOpportunityNeed(TEST_CTX, card!, "track_all", {})).toEqual({ ok: true });
  expect(readWatchList(store, ws).map((item) => [item.id, item.state])).toEqual([["need:research:intern", "active"], ["need:research:conf", "active"], ["need:research:old", "proposed"]]);
  expect(opportunityNeedAsks(TEST_CTX, NOW)).toEqual([]);
});

test("少来 takes a one-tap reason from a choice field, leaves the inbox, is listed for the review, and undo puts it back", async () => {
  const store = setup();
  saveWatchList(store, ws, [watch({ state: "active" })]);
  save(store);
  const card = offer(opportunityOfferAsks(TEST_CTX, NOW), "opp:opp-1");
  const less = card.options.find((option) => option.id === "less")!;
  expect(less.fields?.[0]).toMatchObject({ kind: "choice" });
  expect(validateAskAnswer(card, "less", { reason: "nonsense" })).toEqual({ ok: false, code: "ASK_FIELD_CHOICE_UNKNOWN" });
  const checked = validateAskAnswer(card, "less", { reason: "already_known" });
  expect(checked.ok).toBe(true);
  expect(await answerOpportunityOffer(TEST_CTX, card, "less", checked.ok ? checked.values : {}, NOW)).toEqual({ ok: true });
  expect(readWatchTuning(store, ws).knownHosts).toEqual(["lab.example.org"]);
  expect(opportunityOfferAsks(TEST_CTX, NOW).some((ask) => ask.id === "opp:opp-1")).toBe(false);
  const entries = loadOutOfView(TEST_CTX, NOW).less;
  expect(entries).toHaveLength(1);
  expect(undoLess(TEST_CTX, entries[0]!.id)).toEqual({ ok: true });
  expect(readWatchTuning(store, ws).knownHosts).toEqual([]);
  expect(loadOpportunitySettings(TEST_CTX, NOW)?.less[0]?.undone).toBe(true);
});

test("after 报名 the card shows the form filler's progress until a day after it is confirmed", async () => {
  const store = setup();
  saveWatchList(store, ws, [watch({ state: "active" })]);
  const row = save(store);
  const card = offer(opportunityOfferAsks(TEST_CTX, NOW), "opp:opp-1");
  expect(await answerOpportunityOffer(TEST_CTX, card, "register", {}, NOW)).toEqual({ ok: true });
  const progress = () => opportunityOfferAsks(TEST_CTX, NOW).find((ask) => ask.id.startsWith("oppform:"));
  expect(progress()?.title).toContain("填写中");
  expect(progress()?.options).toEqual([expect.objectContaining({ href: "/settings#apply" })]);
  const run = { id: "run-1", opportunityId: row.id, opportunity: row, host: "lab.example.org", state: "waiting_person", pageNo: 2,
    queuedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), pages: [], screenshots: [] } as unknown as StoredFormRun;
  saveFormRun(store, ws, run);
  expect(progress()?.title).toContain("等本人");
  saveFormRun(store, ws, { ...run, state: "confirmed", updatedAt: "2026-10-30T00:00:00.000Z", confirmation: { quote: "You're in", kind: "confirmed", at: "2026-10-30T00:00:00.000Z" } });
  expect(progress()).toBeUndefined();
});

test("an application past its deadline asks for its result, which counts to the watch", () => {
  const store = setup();
  saveWatchList(store, ws, [watch({ state: "active" })]);
  save(store, { kind: "application", deadlines: [{ day: "2026-10-20", quote: "Apply by October 20, 2026" }] });
  store.decideOpportunity(ws, "opp-1", "apply", "2026-10-01T00:00:00.000Z");
  const ask = opportunityOfferAsks(TEST_CTX, NOW).find((item) => item.kind === "opportunity_result")!;
  expect(ask.entityId).toBe("opp-1");
  expect(answerApplicationResult(TEST_CTX, ask, "rejected")).toEqual({ ok: true });
  expect(readWatchList(store, ws)[0]?.stats.outcomes.rejected).toBe(1);
  expect(opportunityOfferAsks(TEST_CTX, NOW).some((item) => item.kind === "opportunity_result")).toBe(false);
});

test("the line card's hand on watches: add, edit, pause, restore — and none of it outside the machine owner's workspace", () => {
  const store = setup();
  saveWatchList(store, ws, [watch({ state: "active" })]);
  const added = addWatch(TEST_CTX, { lineId: "media", title: "城市播客线下活动", query: "芝加哥 播客 meetup" }, NOW);
  expect(added.ok).toBe(true);
  expect(addWatch(TEST_CTX, { lineId: "nowhere", title: "x", query: "y" }, NOW)).toEqual({ ok: false, code: "OPPORTUNITY_LINE_UNKNOWN" });
  expect(changeWatch(TEST_CTX, "need:research:intern", { action: "edit", query: "看 https://lab.example.org/jobs" }, NOW)).toEqual({ ok: true });
  expect(readWatchList(store, ws)[0]).toMatchObject({ origin: "person", targets: [{ tool: "web_fetch", url: "https://lab.example.org/jobs" }] });
  expect(changeWatch(TEST_CTX, "need:research:intern", { action: "state", state: "paused" }, NOW)).toEqual({ ok: true });
  expect(changeWatch(TEST_CTX, "need:research:intern", { action: "state", state: "retired" }, NOW)).toEqual({ ok: true });
  expect(loadOpportunitySettings(TEST_CTX, NOW)?.retired.map((item) => item.id)).toEqual(["need:research:intern"]);
  expect(changeWatch(TEST_CTX, "need:research:intern", { action: "state", state: "active" }, NOW)).toEqual({ ok: true });
  expect(changeWatch(TEST_CTX, "missing", { action: "state", state: "paused" }, NOW)).toEqual({ ok: false, code: "OPPORTUNITY_WATCH_NOT_FOUND" });

  globalThis.crosslineStore?.close();
  setup(false);
  expect(addWatch(TEST_CTX, { lineId: "media", title: "x", query: "y" }, NOW)).toEqual({ ok: false, code: "OPPORTUNITY_NOT_OWNER" });
  expect(loadLineWatches(TEST_CTX)).toEqual({});
  expect(loadOpportunitySettings(TEST_CTX, NOW)).toBeUndefined();
});

test("the hosted beta's machine owner has the agent; a guest there does not", async () => {
  const { opportunityOwner } = await import("./opportunities");
  const store = setup();
  vi.stubEnv("CROSSLINE_PUBLIC_BETA", "1");
  expect(opportunityOwner(TEST_CTX)).toBe(true);
  const guest = store.createPrincipalWithWorkspace("g", "g").workspace.id;
  expect(opportunityOwner({ ...TEST_CTX, workspaceId: guest })).toBe(false);
});
