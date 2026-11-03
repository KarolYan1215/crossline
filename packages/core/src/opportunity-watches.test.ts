import { expect, test } from "vitest";
import {
  OPPORTUNITY_WATCHES_SCHEMA, SCOUT_PURPOSE, applyLess, dayInZone, emptyStats, emptyTuning, exploreAccount, holdBack, mergeWatches, readScoutFile,
  retireCandidates, scoutDirections, undoLess, validateWatchProposals, watchFromNeed, watchFromProposal, watchYield, withOutcome,
  type ProposedWatch, type StoredWatch
} from "./opportunity-watches";
import { structuredOutputProblems } from "./structured-output";

const NOW = "2026-11-01T12:00:00.000Z";
const t = (key: string, values: Record<string, unknown> = {}) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""));
const watch = (over: Partial<StoredWatch> = {}): StoredWatch => ({
  id: "need:research:intern", lineId: "research", title: "暑期研究实习", why: "需要工业界研究经历", origin: "derived",
  basis: { factIds: ["research//stage"], milestoneIds: [], opportunityIds: [] }, query: "研究实习", tools: ["web_search"], targets: [], judge: "研究型", explore: false,
  everyDays: 3, horizonDays: 200, state: "active", stats: emptyStats(), createdAt: NOW, updatedAt: NOW, leadDays: 30, prescreen: [], weight: 1, strictness: 0, ...over
});
const proposal = (over: Partial<ProposedWatch> = {}): ProposedWatch => ({
  key: "intern", title: "暑期研究实习", why: "需要工业界研究经历", factIds: ["research//stage"], milestoneIds: [], query: "硬件公司的暑期研究实习",
  judge: "面向在读博士的研究型实习", tools: ["ats_board"], targets: [{ tool: "ats_board", provider: "greenhouse", board: "anthropic", query: "" }],
  everyDays: 3, horizonDays: 300, leadDays: 30, cycle: { opensMonth: 0, closesMonth: 0, basis: "", sourceUrl: "" }, prescreen: [], ...over
});

test("the watches schema meets the strict structured-output rules", () => {
  expect(structuredOutputProblems(OPPORTUNITY_WATCHES_SCHEMA)).toEqual([]);
});

test("today is the person's day, not UTC's", () => {
  expect(dayInZone(new Date("2026-11-02T03:00:00Z"), "America/Chicago")).toBe("2026-11-01");
  expect(dayInZone(new Date("2026-11-02T03:00:00Z"), "Not/AZone")).toBe("2026-11-02");
});

test("a need becomes a watch one to one: the id stays, the decision is kept, sources become targets", () => {
  const migrated = watchFromNeed({ id: "need:research:intern", lineId: "research", kind: "stream", title: "暑期研究实习", why: "w", factIds: ["research//stage"],
    milestoneIds: [], leadDays: 30, eligibility: [], state: "declined", sources: [{ kind: "ats", provider: "lever", board: "groq", query: "" }] }, NOW, "2026-10-30T00:00:00Z");
  expect(migrated).toMatchObject({ id: "need:research:intern", origin: "migrated", state: "retired", targets: [{ tool: "ats_board", provider: "lever", board: "groq" }] });
  expect(migrated.stats.lastRunAt).toBe("2026-10-30T00:00:00Z");
});

test("proposals are checked against the line's own facts, and the scout's watches are explorations under their own prefix", () => {
  const context = { lineId: "research", factIds: ["research//stage"], milestoneIds: [] };
  expect(validateWatchProposals({ watches: [proposal()], blocked: "" }, context).watches).toHaveLength(1);
  expect(() => validateWatchProposals({ watches: [proposal({ factIds: ["investment//stage"] })], blocked: "" }, context)).toThrow("OPPORTUNITY_WATCHES_INVALID");
  const scouted = watchFromProposal("research", proposal({ key: "Lab Days" }), "2026-11-01", NOW, "scout", true);
  expect(scouted).toMatchObject({ id: "explore:research:lab-days", explore: true, state: "proposed" });
});

test("a derivation keeps the person's decisions and stats, and does not propose again what was turned down or finished", () => {
  const kept = [watch({ stats: { ...emptyStats(), runs: 4 } }), watch({ id: "need:research:old", title: "开放日活动", state: "retired" }),
    watch({ id: "person:research:x", origin: "person", title: "本人的", query: "a" })];
  const fresh = [watchFromProposal("research", proposal({ everyDays: 2 }), "2026-11-01", NOW),
    watchFromProposal("research", proposal({ key: "open-day", title: "开放日活动！" }), "2026-11-01", NOW),
    watchFromProposal("research", proposal({ key: "done", title: "ISCA 投稿" }), "2026-11-01", NOW)];
  const merged = mergeWatches(kept, "research", fresh, ["ISCA 投稿"]);
  expect(merged.find((item) => item.id === "need:research:intern")).toMatchObject({ state: "active", everyDays: 3, stats: { runs: 4 } });
  expect(merged.map((item) => item.id).sort()).toEqual(["need:research:intern", "need:research:old", "person:research:x"]);
});

test("exploration may start under 20% of the week's opportunity spend, or when nothing was explored yet", () => {
  expect(exploreAccount([{ purpose: "opportunity:watch:a", weighted: 1000 }]).allows).toBe(true);
  expect(exploreAccount([{ purpose: "opportunity:watch:a", weighted: 1000 }, { purpose: SCOUT_PURPOSE, weighted: 500 }])).toMatchObject({ allows: false, share: 1 / 3 });
  expect(exploreAccount([{ purpose: "opportunity:watch:a", weighted: 900 }, { purpose: "opportunity:explore:b", weighted: 100 }, { purpose: "planner", weighted: 1e6 }]))
    .toMatchObject({ allows: true, share: 0.1 });
});

test("outcomes drive yield; a quiet watch below its line's mean retires, never the person's own", () => {
  const good = withOutcome(withOutcome({ ...emptyStats(), runs: 6 }, "planned", NOW), "submitted", NOW);
  expect(watchYield(good)).toBe(3);
  expect(good.lastYieldAt).toBe(NOW);
  const quiet = { ...emptyStats(), runs: 6, cost: 20_000 };
  const old = "2026-08-01T00:00:00.000Z";
  const list = [watch({ id: "good", stats: good }), watch({ id: "quiet", stats: quiet, createdAt: old }), watch({ id: "mine", origin: "person", stats: quiet, createdAt: old })];
  expect(retireCandidates(list, new Date(NOW)).map((item) => item.id)).toEqual(["quiet"]);
  expect(scoutDirections([watch({ id: "e", explore: true, stats: { ...emptyStats(), runs: 3 } }), watch({ id: "f", explore: true, stats: good })]).map((item) => item.runs)).toEqual([6]);
});

test("what passed the gates is still held back for what the person said: a known host, a bad time, a stricter watch", () => {
  const opportunity = { url: "https://www.lab.example.org/day", startsAt: { day: "2026-11-07", quote: "Saturday, 7 PM" } };
  expect(holdBack({ opportunity, verdict: { state: "eligible" }, tuning: emptyTuning() })).toBeUndefined();
  expect(holdBack({ opportunity, verdict: { state: "ineligible" }, tuning: emptyTuning() })).toBe("ineligible");
  expect(holdBack({ opportunity, verdict: { state: "eligible" }, feasibility: { state: "infeasible" } as never, tuning: emptyTuning() })).toBe("infeasible");
  expect(holdBack({ opportunity, verdict: { state: "eligible" }, tuning: { ...emptyTuning(), knownHosts: ["lab.example.org"] } })).toBe("known_source");
  expect(holdBack({ opportunity, verdict: { state: "eligible" }, tuning: { ...emptyTuning(), badTimes: [{ id: "x", weekday: 6, part: "evening" }] } })).toBe("bad_time");
  expect(holdBack({ opportunity, verdict: { state: "unknown" }, watch: { weight: 1, strictness: 1, state: "active" }, tuning: emptyTuning() })).toBe("strict");
});

test("少来 for a kind halves how often the watch runs and raises its bar; undo puts back exactly that", () => {
  const before = watch();
  const opportunity = { id: "opp-1", url: "https://lab.example.org/day", title: "Lab Open Day", lineId: "research", startsAt: { day: "2026-11-07", quote: "7 PM" } };
  const applied = applyLess({ feedback: { opportunityId: "opp-1", scope: "kind" }, watch: before, tuning: emptyTuning(), opportunity, failedRules: [], id: "less-1", at: NOW, t });
  expect(applied.watch).toMatchObject({ everyDays: 6, strictness: 1 });
  expect(applied.entry.changes.length).toBeGreaterThan(0);
  const undone = undoLess(applied.entry, applied.watch, applied.tuning, NOW);
  expect(undone.watch).toMatchObject({ everyDays: 3, strictness: 0 });
});

test("the scout's file is read leniently: a bad item is left out, not the whole week", () => {
  const read = readScoutFile({ opportunities: [{ url: "http://insecure.example", lineId: "research", title: "x" },
    { url: "https://lab.example.org/day", lineId: "research", title: "Lab Open Day", deadlines: [{ day: "2026-11-20", quote: "by Nov 20" }, { day: "soon" }] },
    { url: "https://elsewhere.example", lineId: "nope", title: "y" }], watches: [{ lineId: "research", title: "Lab days", query: "city lab open days", tools: ["teleport"] }] }, ["research"]);
  expect(read.opportunities.map((item) => item.title)).toEqual(["Lab Open Day"]);
  expect(read.opportunities[0]?.deadlines).toHaveLength(1);
  expect(read.watches[0]).toMatchObject({ tools: ["web_search"], everyDays: 7 });
});
