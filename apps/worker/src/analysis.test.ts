import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import * as analysis from "./analysis";
import { fakeRuntime as sharedRuntime, recordedAnswer } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, "crossline:crossline-automation-stripper");

let store: CrosslineStore;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.capture({ id: "c", ownerId: "local-owner", workspaceId: "personal-crossline", title: "Decide", context: "" }, "capture:c");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: "personal-crossline", identityId: "research", projectId: "p", title: "Decide", version: 1, status: "approved" });
});
afterEach(() => store.close());

const proposal = { identityId: "research", projectId: "p", milestoneId: "m", intent: "Decide", family: "deep_work", automationParts: [], humanCore: [{ id: "h", intent: "Decide", energy: "medium", interruptible: true, quote: "Decide", rationale: "Judgment" }], materialContract: [], evidenceContract: [{ kind: "record", description: "Decision", why: "The decision is the deliverable", required: true }], estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: [] };

test("duplicate Analyze requests share one durable run and publish only a proposal", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\\repo");
  const [first, duplicate] = await Promise.all([analyze(rpc, "c"), analyze(rpc, "c")]);
  expect(first).toMatchObject({ state: "awaiting_plan_approval", audit: { threadId: "thread-1", turnId: "turn-1" } });
  // The duplicate observes the claimed run rather than starting a second turn.
  expect(duplicate.state).toBe("analyzing");
  await analyze(rpc, "c");
  expect(turns()).toBe(1);
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
  expect(store.listEvents("personal-crossline").map((e) => (e.payload as { to?: string }).to).filter(Boolean)).toEqual(["analyzing", "awaiting_plan_approval"]);
});

test("a blocked analysis can be retried instead of stranding the capture forever", async () => {
  const { rpc, turns } = fakeRuntime(["this is not the agreed JSON", JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\\repo");
  const blocked = await analyze(rpc, "c");
  expect(blocked.state).toBe("blocked");
  expect(blocked.audit.blocker?.code).toMatch(/^ANALYSIS_[A-Z_]+$/);
  expect(store.listWorkOrders("personal-crossline")).toEqual([]);
  const recovered = await analyze(rpc, "c");
  expect(turns()).toBe(2);
  expect(recovered).toMatchObject({ state: "awaiting_plan_approval", attempt: 1 });
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
});

test("approved milestones spanning several identities reach the Skill instead of blocking", async () => {
  // The real seed creates one approved milestone per identity; requiring a single identity made every
  // analysis on a real database end in ANALYSIS_IDENTITY_CONTEXT_REQUIRED without ever sending a turn.
  for (const identityId of ["startup", "media", "investment"]) {
    store.saveMilestone({ id: `${identityId}-m`, ownerId: "local-owner", workspaceId: "personal-crossline",
      identityId, projectId: `${identityId}-default`, title: `${identityId} milestone`, version: 1, status: "approved" });
  }
  const { rpc, turns } = fakeRuntime([JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\\repo");
  const result = await analyze(rpc, "c");
  expect(turns()).toBe(1);
  expect(result).toMatchObject({ state: "awaiting_plan_approval" });
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
});

/**
 * Degenerate model answers, recorded from real runs, driven through the whole path.
 *
 * Until these existed, every fake answer in the repo was clean JSON somebody typed, and each of these
 * four shapes had to be found by hand during an acceptance run. Two of them are repaired in place and
 * two are refused, and which is which is the point of the table: a reason with junk on the end still
 * has its sentence, but a label cut off at the cap tells the person nothing.
 */
const degenerate = [
  { fixture: "analysis-degenerate-scratch-leak", outcome: "refused", code: "ANALYSIS_CONTRACT_NOT_PROSE", why: "" },
  { fixture: "analysis-degenerate-truncated-description", outcome: "refused", code: "ANALYSIS_CONTRACT_TRUNCATED", why: "" },
  { fixture: "analysis-degenerate-combining-mark-padding", outcome: "normalised", code: "",
    why: "这是本次清单的主要输入，已由用户提供。" },
  { fixture: "analysis-degenerate-phrase-echo", outcome: "normalised", code: "",
    why: "工作应围绕这些摘录推进，不因缺少原文而停止。" }
] as const;

test.each(degenerate)("a $fixture answer is $outcome all the way through to the ledger", async ({ fixture, outcome, code, why: expectedWhy }) => {
  const { rpc, turns } = fakeRuntime([recordedAnswer(fixture)]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");

  if (outcome === "refused") {
    expect(result.state).toBe("blocked");
    expect(result.audit.blocker?.code).toBe(code);
    // The person is shown this. A bare code gives them nothing to act on, so the offending text has
    // to survive the trip from the validator through the worker's error mapping.
    expect(result.audit.blocker?.message ?? "").not.toBe("运行未完成；请检查阻塞原因。");
    expect(store.listWorkOrders("personal-crossline")).toEqual([]);
    // Asked to fix it twice before giving up, rather than failing on the first rejection.
    expect(turns()).toBe(3);
    return;
  }

  expect(result.state).toBe("awaiting_plan_approval");
  const stored = store.listWorkOrders("personal-crossline")[0]!.payload as
    { materialContract: Array<{ why: string }>; evidenceContract: Array<{ description: string }> };
  // What actually landed in the row the approvals page renders — no padding, no echo, sentence intact.
  expect(stored.materialContract[0]!.why).toBe(expectedWhy);
  expect(turns()).toBe(1);
});

test("a rejected answer is sent back with the reason, and the corrected one is accepted", async () => {
  const { rpc, turns, prompts } = fakeRuntime([
    recordedAnswer("analysis-degenerate-truncated-description"),
    recordedAnswer("analysis-clean")
  ]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");

  expect(result).toMatchObject({ state: "awaiting_plan_approval" });
  expect(turns()).toBe(2);
  // The repair turn has to carry what was wrong; without it the model is being asked to guess.
  expect(prompts()[1]).toContain("ANALYSIS_CONTRACT_TRUNCATED");
  expect(prompts()[1]).toContain("契约条目被截断");
  // Recorded so a schema that needs repairing every time reads as a schema problem, not a cost.
  expect(result.audit.repairs).toBe(1);
});
