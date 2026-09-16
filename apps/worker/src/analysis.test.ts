import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { JsonLineRpcClient } from "@crossline/codex";
import * as analysis from "./analysis";

let store: CrosslineStore;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.capture({ id: "c", ownerId: "local-owner", workspaceId: "personal-crossline", title: "Decide", context: "" }, "capture:c");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: "personal-crossline", identityId: "research", projectId: "p", title: "Decide", version: 1, status: "approved" });
});
afterEach(() => store.close());

const proposal = { identityId: "research", projectId: "p", milestoneId: "m", intent: "Decide", automationParts: [], humanCore: [{ id: "h", intent: "Decide", energy: "medium", interruptible: true, quote: "Decide", rationale: "Judgment" }], materialContract: [], evidenceContract: [{ kind: "record", description: "Decision", why: "The decision is the deliverable", required: true }], estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: [] };

// Answers each turn with `answers[turn - 1]`, so a test can make one attempt fail and the next succeed.
function fakeRuntime(answers: string[]): { rpc: JsonLineRpcClient; turns: () => number } {
  let turns = 0;
  const rpc = new JsonLineRpcClient((line) => {
    const request = JSON.parse(line);
    const result = request.method === "skills/list" ? { data: [{ cwd: "C:\\repo", errors: [], skills: [{ name: "crossline:crossline-automation-stripper", path: "C:\\skill\\SKILL.md", enabled: true }] }] }
      : request.method === "account/read" ? { account: { type: "chatgpt" } }
      : request.method === "config/read" ? { config: {} }
      : request.method === "thread/start" ? { thread: { id: `thread-${turns + 1}` }, approvalPolicy: "untrusted", sandbox: { type: "readOnly" }, instructionSources: [] }
      : { turn: { id: `turn-${turns + 1}`, status: "inProgress" } };
    queueMicrotask(() => rpc.receiveLine(JSON.stringify({ id: request.id, result })));
    if (request.method === "turn/start") {
      turns++;
      const threadId = `thread-${turns}`;
      const turnId = `turn-${turns}`;
      const text = answers[turns - 1] ?? answers[answers.length - 1]!;
      setTimeout(() => {
        rpc.receiveLine(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", phase: "final_answer", text } } }));
        rpc.receiveLine(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }));
      }, 1);
    }
  });
  return { rpc, turns: () => turns };
}

test("duplicate Analyze requests share one durable run and publish only a proposal", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "C:\\repo");
  const [first, duplicate] = await Promise.all([analyze(rpc, "c"), analyze(rpc, "c")]);
  expect(first).toMatchObject({ state: "awaiting_plan_approval", audit: { threadId: "thread-1", turnId: "turn-1" } });
  // The duplicate observes the claimed run rather than starting a second turn.
  expect(duplicate.state).toBe("analyzing");
  await analyze(rpc, "c");
  expect(turns()).toBe(1);
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
  expect(store.listEvents().map((e) => (e.payload as { to?: string }).to).filter(Boolean)).toEqual(["analyzing", "awaiting_plan_approval"]);
});

test("a blocked analysis can be retried instead of stranding the capture forever", async () => {
  const { rpc, turns } = fakeRuntime(["this is not the agreed JSON", JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "C:\\repo");
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
  const analyze = analysis.createCaptureAnalyzer(store, "C:\\repo");
  const result = await analyze(rpc, "c");
  expect(turns()).toBe(1);
  expect(result).toMatchObject({ state: "awaiting_plan_approval" });
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
});
