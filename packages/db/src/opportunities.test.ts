import { afterEach, beforeEach, expect, test } from "vitest";
import { SCOUT_NEEDS_SETTING, judgeEligibility, applicantFrom, type EligibilityTerm, type Opportunity, type StoredNeed } from "@crossline/core";
import { CrosslineStore, decideNeed, opportunityWeek, queueFormRun, readFormRuns, recordEligibilityAnswer, scoutNeeds, waitingIdForNeed } from "./index";

let store: CrosslineStore;
let ws: string;
let owner: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("owner", "o");
  ws = created.workspace.id;
  owner = created.principal.id;
});
afterEach(() => store.close());

const opportunity = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: "opp-1", key: "jobs.example.org|summer research internship|2026-12-01", lineId: "research", kind: "application", title: "Summer Research Internship",
  organizer: "Example Lab", url: "https://jobs.example.org/intern", registrationHost: "jobs.example.org",
  deadlines: [{ day: "2026-12-01", quote: "Applications close on December 1, 2026" }], cost: null, eligibility: [], needsAccount: true,
  materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00.000Z", ...over
});
const graduate: EligibilityTerm = { dim: "degree_stage", rule: "在读研究生", quote: "Open to current graduate students", accepts: { kind: "one_of", values: ["graduate"], min: -1, max: -1 } };

test("one row per opening across sources; a re-read keeps the person's decision", () => {
  const first = store.saveOpportunity(ws, { opportunity: opportunity(), terms: [], verdict: { state: "eligible", basis: [] } });
  expect(first.inserted).toBe(true);
  store.decideOpportunity(ws, "opp-1", "apply");
  const again = store.saveOpportunity(ws, { opportunity: opportunity({ id: "opp-other", title: "Summer Research Internship (updated)" }), terms: [], verdict: { state: "eligible", basis: [] } });
  expect(again.inserted).toBe(false);
  expect(again.row).toMatchObject({ id: "opp-1", decision: "apply", title: "Summer Research Internship (updated)" });
  expect(store.listOpportunities(ws)).toHaveLength(1);
  expect(store.exportSnapshot(ws).tables.opportunities).toHaveLength(1);
});

test("an eligibility answer is a confirmed fact of the person line and judges the waiting opportunities again", () => {
  const verdict = judgeEligibility([graduate], applicantFrom([]));
  expect(verdict.state).toBe("unknown");
  store.saveOpportunity(ws, { opportunity: opportunity(), terms: [graduate], verdict });
  expect(recordEligibilityAnswer(store, ws, "apply.degree_stage", "硕士在读", "opp-1")).toBe(1);
  expect(store.listOpportunities(ws, { id: "opp-1" })[0]?.verdict.state).toBe("eligible");
  expect(store.listProfileFacts(ws).find((fact) => fact.slot === "apply.degree_stage")).toMatchObject({ identityId: "person", status: "confirmed" });
});

const need = (over: Partial<StoredNeed> = {}): StoredNeed => ({
  id: "need:research:intern", lineId: "research", kind: "cycle", title: "暑期研究实习", why: "需要工业界研究经历", factIds: [], milestoneIds: [],
  window: { opens: "2027-09", closes: "2027-11", basis: "往年" }, leadDays: 30, eligibility: [], sources: [], state: "proposed", ...over
});

test("tracking a cycle need writes its 「预计开放」 waiting item; declining it is remembered and cancels the wait", () => {
  store.setSetting(ws, SCOUT_NEEDS_SETTING, JSON.stringify([need()]));
  decideNeed(store, ws, owner, "need:research:intern", "tracking");
  expect(scoutNeeds(store, ws)[0]?.state).toBe("tracking");
  const waiting = store.listWaitingItems(ws, { state: "open" }).find((item) => item.id === waitingIdForNeed("need:research:intern"));
  expect(waiting).toMatchObject({ expectedAt: "2027-09-01", approximate: true, source: "opportunity" });
  decideNeed(store, ws, owner, "need:research:intern", "declined", new Date(), "不想去大公司");
  expect(store.listWaitingItems(ws, { state: "open" }).some((item) => item.id === waiting!.id)).toBe(false);
  expect(store.listPreferences(ws).find((pref) => pref.source === "opportunity_declined")).toMatchObject({ scope: "research", refId: "need:research:intern" });
  decideNeed(store, ws, owner, "need:research:intern", "tracking");
  expect(store.listWaitingItems(ws, { state: "open" }).some((item) => item.id === waiting!.id)).toBe(true);
});

test("报名 queues one form run, however often it is pressed", () => {
  const { row } = store.saveOpportunity(ws, { opportunity: opportunity({ kind: "event" }), terms: [], verdict: { state: "eligible", basis: [] } });
  queueFormRun(store, ws, { opportunity: row, choice: "register" });
  queueFormRun(store, ws, { opportunity: row, choice: "register" });
  expect(readFormRuns(store, ws)).toEqual([expect.objectContaining({ opportunityId: "opp-1", state: "queued", host: "jobs.example.org" })]);
});

test("the week counts the ineligible apart", () => {
  store.saveOpportunity(ws, { opportunity: opportunity(), terms: [], verdict: { state: "eligible", basis: [] } });
  store.saveOpportunity(ws, { opportunity: opportunity({ id: "opp-2", key: "k2" }), terms: [graduate], verdict: { state: "ineligible", failed: [] } });
  expect(opportunityWeek(store, ws, "2026-10-25")).toMatchObject({ found: 2, eligible: 1, ineligible: 1 });
});
