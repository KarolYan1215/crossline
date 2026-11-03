import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CCFDDL_URL, RUNTIME_OWNER_SETTING, SCOUT_NEEDS_SETTING, SCOUT_PURPOSE, SCOUT_STATS_SETTING, WATCHES_SETTING, emptyStats, readScoutStats,
  type StoredNeed, type StoredWatch
} from "@crossline/core";
import { CrosslineStore, readWatchList, saveWatchList } from "@crossline/db";
import {
  MAIL_CANDIDATES_SETTING, OPPORTUNITY_NEEDS, OPPORTUNITY_READER, deriveWatches, lineNodeEventsSince, opportunityAgentOn, runWatch, todayFor, watchesDeriveDue, watchesToRun
} from "./opportunities";
import { afterScout, opportunityScoutDue } from "./opportunity-scout";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-01T12:00:00.000Z");
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
});
afterEach(() => store.close());

const watch = (over: Partial<StoredWatch> = {}): StoredWatch => ({
  id: "need:research:venue", lineId: "research", title: "顶会投稿", why: "研究线的论文需要投稿去处", origin: "derived",
  basis: { factIds: [], milestoneIds: [], opportunityIds: [] }, query: "NeurIPS", tools: ["deadline_list"], targets: [], judge: "顶会", explore: false,
  everyDays: 1, horizonDays: 365, state: "active", stats: emptyStats(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), leadDays: 30,
  prescreen: [], weight: 1, strictness: 0, ...over
});

const routes = (map: Record<string, { body: string; type: string }>) => ({
  isPublicHost: async () => true,
  fetchImpl: (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(map).find(([prefix]) => url.startsWith(prefix));
    return hit ? new Response(hit[1].body, { status: 200, headers: { "content-type": hit[1].type } }) : new Response("not found", { status: 404 });
  }) as typeof fetch
});
const setUp = () => store.saveOnboardingSession({ id: "s", ownerId: "o", workspaceId: ws, state: "complete", coverage: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
const usage = (purpose: string, inputTokens: number, at = NOW.toISOString()) => store.saveModelUsage({ workspaceId: ws, skill: "x", tier: "mid", model: "m", effort: "high",
  spendMode: "normal", threadId: "t", ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  totalTokens: inputTokens, durationMs: 1, at, purpose } as Parameters<CrosslineStore["saveModelUsage"]>[0]);

test("only the machine owner's workspace runs the agent, on the hosted beta too", () => {
  const guest = store.createPrincipalWithWorkspace("g", "g").workspace.id;
  store.setSetting(ws, RUNTIME_OWNER_SETTING, "1");
  expect(opportunityAgentOn(store, ws, {})).toBe(true);
  expect(opportunityAgentOn(store, guest, {})).toBe(false);
  expect(opportunityAgentOn(store, ws, { CROSSLINE_PUBLIC_BETA: "1" })).toBe(true);
  expect(opportunityAgentOn(store, guest, { CROSSLINE_PUBLIC_BETA: "1" })).toBe(false);
});

test("watches are not derived before the account is set up; a result, a gate or a confirmed sign-up is a node of its line", () => {
  expect(watchesDeriveDue(store, ws, NOW)).toEqual([]);
  setUp();
  expect(watchesDeriveDue(store, ws, NOW)).toContain("research");
  expect(lineNodeEventsSince(store, ws, NOW.toISOString()).size).toBe(0);
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "r1", type: "opportunity.result", entityId: "opp-1", payload: { lineId: "research", result: "rejected" } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "x1", type: "capture.discarded", entityId: "c-1", payload: { lineId: "media" } });
  const nodes = lineNodeEventsSince(store, ws, "");
  expect([...nodes.keys()]).toEqual(["research"]);
  expect(nodes.get("research")?.[0]?.type).toBe("opportunity.result");
});

test("old needs become watches one to one, decisions kept, and a migrated deadline list is run without a model", async () => {
  const yaml = `- title: NeurIPS
  description: Neural Information Processing Systems
  dblp: nips
  confs:
    - year: 2027
      link: https://neurips.cc
      timezone: AoE
      place: Sydney
      timeline:
        - deadline: '2027-05-15 23:59:59'
        - deadline: '2026-05-15 23:59:59'
`;
  const need = (over: Partial<StoredNeed>): StoredNeed => ({ id: "need:research:venue", lineId: "research", kind: "stream", title: "顶会投稿", why: "论文去处",
    factIds: [], milestoneIds: [], leadDays: 30, eligibility: [], sources: [{ kind: "deadline_list", list: "ccfddl", query: "NeurIPS" }], state: "tracking", ...over });
  store.setSetting(ws, SCOUT_NEEDS_SETTING, JSON.stringify([need({}), need({ id: "need:research:no", state: "declined" }), need({ id: "need:research:new", state: "proposed" })]));
  const watches = readWatchList(store, ws);
  expect(watches.map((item) => [item.id, item.state, item.origin])).toEqual([
    ["need:research:venue", "active", "migrated"], ["need:research:no", "retired", "migrated"], ["need:research:new", "proposed", "migrated"]]);
  expect(store.getSetting(ws, SCOUT_NEEDS_SETTING)).toContain("tracking");
  const deps = { client: () => undefined, cwd: ".", http: routes({ [CCFDDL_URL]: { body: yaml, type: "text/yaml" } }), now: () => NOW, costSince: () => 0 };
  const first = await runWatch(store, ws, watches[0]!, deps);
  expect(first).toMatchObject({ found: 1, fresh: 1, surfaced: 1, modelCalls: 0 });
  expect(store.listOpportunities(ws)[0]).toMatchObject({ title: "NeurIPS 2027", needId: "need:research:venue", deadlines: [{ day: "2027-05-15" }] });
  expect(readWatchList(store, ws)[0]?.stats).toMatchObject({ runs: 1, found: 1, surfaced: 1, outcomes: { surfaced: 1 } });
  expect(watchesToRun(store, ws, NOW)).toEqual([]);
  const again = await runWatch(store, ws, readWatchList(store, ws)[0]!, deps);
  expect(again).toMatchObject({ found: 1, fresh: 0, surfaced: 0 });
});

test("a page that has not changed is not read again; a changed one is", async () => {
  let body = "<p>Spring School 2027. Applications close on December 1, 2026.</p>";
  const http = { isPublicHost: async () => true, fetchImpl: (async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch };
  const answer = JSON.stringify({ items: [{ pageId: "p1", url: "https://school.example.org/", title: "Spring School 2027", organizer: "Example", kind: "application",
    deadlines: [{ day: "2026-12-01", quote: "Applications close on December 1, 2026" }], startsAt: { day: "", quote: "" },
    cost: { known: false, amount: 0, currency: "", quote: "" }, location: "", eligibility: [], needsAccount: false, materials: [], consents: [], registrationUrl: "" }], blocked: "" });
  const runtime = fakeRuntime([answer, answer], OPPORTUNITY_READER);
  const page = watch({ tools: ["web_fetch"], targets: [{ tool: "web_fetch", url: "https://school.example.org/" }] });
  saveWatchList(store, ws, [page]);
  const deps = { client: () => runtime.rpc, cwd: ".", http, now: () => NOW, costSince: () => 120 };
  expect(await runWatch(store, ws, page, deps)).toMatchObject({ fresh: 1, modelCalls: 1 });
  expect(await runWatch(store, ws, page, deps)).toMatchObject({ fresh: 0, modelCalls: 0 });
  body = "<p>Spring School 2027. Applications close on December 1, 2026. Now with travel grants.</p>";
  expect(await runWatch(store, ws, page, deps)).toMatchObject({ modelCalls: 1 });
  expect(readWatchList(store, ws)[0]?.stats).toMatchObject({ runs: 3, cost: 360 });
});

test("today is the person's own: a deadline that is today in Chicago is still open after midnight UTC", async () => {
  const lateNight = new Date("2026-11-02T03:00:00.000Z");
  expect(todayFor(store, ws, lateNight)).toBe("2026-11-01");
  store.setSetting(ws, MAIL_CANDIDATES_SETTING, JSON.stringify([{ key: "m1", lineId: "research", subject: "Call for Workshop Papers",
    from: "chair@example.org", text: "Submissions are due November 1, 2026.", url: "https://example.org/workshop", at: NOW.toISOString() }]));
  const answer = JSON.stringify({ items: [{ pageId: "p1", url: "https://example.org/workshop", title: "Workshop", organizer: "Example", kind: "application",
    deadlines: [{ day: "2026-11-01", quote: "Submissions are due November 1, 2026" }], startsAt: { day: "", quote: "" },
    cost: { known: false, amount: 0, currency: "", quote: "" }, location: "", eligibility: [], needsAccount: false, materials: [], consents: [], registrationUrl: "" }], blocked: "" });
  const runtime = fakeRuntime([answer], OPPORTUNITY_READER);
  const result = await runWatch(store, ws, watch({ tools: [], targets: [] }), { client: () => runtime.rpc, cwd: ".", http: routes({}), now: () => lateNight, costSince: () => 0 });
  expect(result.fresh).toBe(1);
  expect(store.listOpportunities(ws)[0]?.foundVia).toBe("mail");
  expect(store.getSetting(ws, MAIL_CANDIDATES_SETTING)).toBe("[]");
});

test("an infeasible find is kept but never surfaced", async () => {
  const yaml = `- title: ICML
  description: Machine Learning
  confs:
    - year: 2027
      link: https://icml.cc
      timezone: AoE
      place: Seoul
      timeline:
        - deadline: '2027-01-30 23:59:59'
`;
  const result = await runWatch(store, ws, watch({ query: "ICML", targets: [{ tool: "deadline_list", list: "ccfddl", query: "ICML" }] }), {
    client: () => undefined, cwd: ".", http: routes({ [CCFDDL_URL]: { body: yaml, type: "text/yaml" } }), now: () => NOW, costSince: () => 0,
    feasibility: async () => ({ state: "infeasible", reasons: [{ code: "visa_too_late", detail: "签证来不及" }] })
  });
  expect(result).toMatchObject({ fresh: 1, surfaced: 0 });
  expect(store.listOpportunities(ws)[0]?.feasibility).toMatchObject({ state: "infeasible" });
  expect(store.listEvents(ws, { type: "opportunity.outcome" })).toEqual([]);
});

test("exploration waits once it has had its 20% of the week", () => {
  saveWatchList(store, ws, [watch(), watch({ id: "explore:research:x", explore: true, origin: "scout" })]);
  expect(watchesToRun(store, ws, NOW).map((item) => item.id)).toEqual(["need:research:venue", "explore:research:x"]);
  usage("opportunity:watch:need:research:venue", 1000);
  usage(SCOUT_PURPOSE, 400);
  expect(watchesToRun(store, ws, NOW).map((item) => item.id)).toEqual(["need:research:venue"]);
  store.setSetting(ws, SCOUT_STATS_SETTING, JSON.stringify({ runs: 0, cost: 0, outcomes: {} }));
  setUp();
  expect(opportunityScoutDue(store, ws, NOW)).toBe(false);
});

test("deriving proposes watches and never one for work already done", async () => {
  setUp();
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "", slot: "stage", value: "PhD 二年级", status: "confirmed", sourceRef: "reply-1",
    sourceQuote: "PhD 二年级", updatedAt: NOW.toISOString() });
  const proposal = (key: string, title: string) => ({ key, title, why: "研究线需要暑期实习", factIds: ["research//stage"], milestoneIds: [], query: "暑期研究实习",
    judge: "研究型岗位", tools: ["ats_board"], targets: [{ tool: "ats_board", provider: "greenhouse", board: "lab", query: "intern" }], everyDays: 3, horizonDays: 200,
    leadDays: 30, cycle: { opensMonth: 0, closesMonth: 0, basis: "", sourceUrl: "" }, prescreen: [] });
  const runtime = fakeRuntime([JSON.stringify({ watches: [proposal("intern", "暑期研究实习"), proposal("other", "顶会 workshop")], blocked: "" })], OPPORTUNITY_NEEDS);
  saveWatchList(store, ws, [watch({ id: "need:research:old", title: "顶会 workshop 投稿", state: "retired", retiredBy: "person" })]);
  const result = await deriveWatches(store, ws, "research", { client: () => runtime.rpc, cwd: ".", http: routes({}), now: () => NOW, webBlocker: () => undefined });
  expect(result).toEqual({ proposed: 1 });
  expect(readWatchList(store, ws).find((item) => item.id === "need:research:intern")).toMatchObject({ state: "proposed", origin: "derived", everyDays: 3 });
  expect(JSON.parse(store.getSetting(ws, WATCHES_SETTING)!)).toHaveLength(2);
});

test("the scout's file is checked like any find; its watches wait in 视野外 as proposals", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scout-"));
  writeFileSync(path.join(dir, "scout.json"), JSON.stringify({
    opportunities: [
      { url: "https://lab.example.org/day", title: "Open Day", organizer: "Lab", kind: "event", lineId: "research",
        deadlines: [{ day: "2026-11-10", quote: "Register by November 10, 2026" }], eligibility: [], why: "近" },
      { url: "https://made.example.org/", title: "Invented", organizer: "Nobody", kind: "event", lineId: "research",
        deadlines: [{ day: "2026-11-20", quote: "Due November 20, 2026" }], eligibility: [] }
    ],
    watches: [{ lineId: "research", key: "open-days", title: "实验室开放日", why: "相邻方向", query: "实验室 开放日", judge: "同方向", tools: ["web_search"] }],
    notes: ["试了两条线的交叉"]
  }));
  const http = routes({ "https://lab.example.org/": { body: "<h1>Open Day</h1><p>Register by November 10, 2026.</p>", type: "text/html" } });
  const result = await afterScout(store, ws, { state: "done", taskId: "scout-1", directory: dir } as never, NOW, { http, now: () => NOW, costSince: () => 900 });
  rmSync(dir, { recursive: true, force: true });
  expect(result).toEqual({ kept: 1, surfaced: 1, watches: 1 });
  expect(store.listOpportunities(ws)[0]).toMatchObject({ title: "Open Day", needId: "scout:2026-11-01" });
  expect(readWatchList(store, ws)[0]).toMatchObject({ id: "explore:research:open-days", state: "proposed", origin: "scout", explore: true });
  expect(readScoutStats(store.getSetting(ws, SCOUT_STATS_SETTING))).toMatchObject({ runs: 1, cost: 900, outcomes: { surfaced: 1 } });
});
