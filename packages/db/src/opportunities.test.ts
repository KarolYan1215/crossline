import { afterEach, beforeEach, expect, test } from "vitest";
import { judgeEligibility, applicantFrom, type EligibilityTerm, type Opportunity } from "@crossline/core";
import { CrosslineStore, opportunityWeek, queueFormRun, readFormRuns, recordEligibilityAnswer } from "./index";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("owner", "o");
  ws = created.workspace.id;
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

test("migration 25: a row read with one line gets it as a migrated tag and a type; line filters see every line it serves", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-m24-"));
  const file = path.join(dir, "ledger.db");
  try {
    let disk = new CrosslineStore(file);
    const space = disk.createPrincipalWithWorkspace("owner", "o").workspace.id;
    disk.saveOpportunity(space, { opportunity: opportunity({ title: "Google Research Internship 2027" }), terms: [], verdict: { state: "eligible", basis: [] } });
    disk.close();
    // Back to the schema before tags: the row as track ① wrote it, without `lines` in its JSON.
    const raw = new Database(file);
    const row = raw.prepare("SELECT data_json FROM opportunities").get() as { data_json: string };
    expect(JSON.parse(row.data_json).lines).toBeUndefined();
    raw.pragma("user_version = 23");
    raw.close();
    disk = new CrosslineStore(file);
    const [migrated] = disk.listOpportunities(space);
    expect(migrated).toMatchObject({ lineId: "research", type: "internship", lines: [{ lineId: "research", relevance: 0.6, migrated: true }] });
    // Read again with tags: the judged tag replaces the migrated one, a second line joins, and the line filter sees it.
    disk.saveOpportunity(space, { opportunity: opportunity({ title: "Google Research Internship 2027", lines: [
      { lineId: "startup", confidence: 0.8, relevance: 0.82, reason: "做原型", anchors: ["goal"] },
      { lineId: "research", confidence: 0.7, relevance: 0.7, reason: "研究型", anchors: ["goal"] }] }), terms: [], verdict: { state: "eligible", basis: [] } });
    const [merged] = disk.listOpportunities(space);
    expect(merged!.lineId).toBe("startup");
    expect(merged!.lines!.map((tag) => [tag.lineId, tag.relevance, Boolean(tag.migrated)])).toEqual([["startup", 0.82, false], ["research", 0.7, false]]);
    expect(disk.listOpportunities(space, { lineId: "research" })).toHaveLength(1);
    expect(disk.listOpportunities(space, { lineId: "media" })).toHaveLength(0);
    disk.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
