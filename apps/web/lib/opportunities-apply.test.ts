import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, readFormRuns, type StoredEvidenceClaim, type StoredWorkOrder } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "./test-support";
import { answerOpportunityApplyReady, opportunityApplyReadyAsks } from "./opportunities";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const NOW = new Date("2026-11-02T15:00:00Z");
const ws = TEST_CTX.workspaceId;

const order = (id: string, intent: string, state: StoredWorkOrder["state"]): StoredWorkOrder => ({ id, ownerId: TEST_CTX.principalId, workspaceId: ws,
  identityId: "research", projectId: "p", milestoneId: "m-apply", intent, state, riskTier: "milestone",
  estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });

function seed(statementState: StoredWorkOrder["state"]) {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveOpportunity(ws, { opportunity: { id: "opp-1", key: "k", lineId: "research", kind: "application", title: "Summer Research Internship", organizer: "Example Lab",
    url: "https://jobs.example.org/intern", registrationHost: "jobs.example.org", deadlines: [{ day: "2026-12-01", quote: "Applications close on December 1, 2026" }],
    cost: null, eligibility: [], needsAccount: true, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00.000Z" }, terms: [], verdict: { state: "eligible", basis: [] } });
  store.decideOpportunity(ws, "opp-1", "apply", "2026-11-01T01:00:00.000Z");
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "opportunity.milestone:opp-1", type: "opportunity.milestone_written",
    entityId: "opp-1", payload: { milestoneId: "m-apply", deadline: "2026-12-01", rolling: false } });
  store.saveWorkOrder(order("w-statement", "写研究陈述", statementState));
  store.saveWorkOrder(order("w-submit", "在官网提交申请", "approved"));
  const dir = mkdtempSync(path.join(tmpdir(), "opp-draft-"));
  const file = path.join(dir, "statement.md");
  writeFileSync(file, "My research on neuromorphic hardware…");
  const claims: StoredEvidenceClaim[] = [{ id: "c1", workspaceId: ws, workOrderId: "w-statement", kind: "file", uri: pathToFileURL(file).href, description: "陈述",
    reviewStatus: "accepted", createdAt: "2026-11-01T02:00:00.000Z" } as StoredEvidenceClaim];
  vi.spyOn(store, "listEvidenceClaims").mockReturnValue(claims);
  return store;
}

test("an application is offered to the form filler only once every preparation task is accepted; 代填 queues an apply run with the drafts", () => {
  const store = seed("accepted");
  const [ask] = opportunityApplyReadyAsks(TEST_CTX, NOW);
  expect(ask).toMatchObject({ kind: "opportunity_apply_ready", entityId: "opp-1", dueDay: "2026-12-01" });
  expect(ask!.why).toContain("写研究陈述");
  expect(answerOpportunityApplyReady(TEST_CTX, ask!, "fill", NOW)).toEqual({ ok: true });
  const [run] = readFormRuns(store, ws);
  expect(run).toMatchObject({ opportunityId: "opp-1", decision: { choice: "apply" }, state: "queued" });
  expect(Object.values(run!.drafts ?? {})[0]).toMatchObject({ text: expect.stringContaining("neuromorphic") });
  // A run exists now: not asked again.
  expect(opportunityApplyReadyAsks(TEST_CTX, NOW)).toEqual([]);
});

test("unfinished preparation is not asked about, and 我自己去交 ends the question", () => {
  seed("active");
  expect(opportunityApplyReadyAsks(TEST_CTX, NOW)).toEqual([]);
  globalThis.crosslineStore?.close();
  const store = seed("accepted");
  const [ask] = opportunityApplyReadyAsks(TEST_CTX, NOW);
  expect(answerOpportunityApplyReady(TEST_CTX, ask!, "self", NOW)).toEqual({ ok: true });
  expect(opportunityApplyReadyAsks(TEST_CTX, NOW)).toEqual([]);
  expect(readFormRuns(store, ws)).toEqual([]);
});
