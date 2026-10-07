import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CostSignal } from "@crossline/core";
import { approveCategory, CrosslineStore, listAgentTasks, pendingCategoryRequests, reviewAgentTask } from "@crossline/db";
import { createAgentService } from "./agent-service";
import { AGENT_SKILL } from "./agent-task";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let ws: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-agent-service-"));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const estimate = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, ai: string[], state = "approved") => store.saveWorkOrder({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: `任务 ${id}`, state, riskTier: "routine", estimate,
  payload: { automationParts: ai.map((intent, i) => ({ id: `a${i}`, intent })), humanCore: [{ id: "h", intent: "自己决定" }], materialContract: [] } });
const healthy: CostSignal = { available: true, limitReached: false, short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } };
const summary = JSON.stringify({ summary: "整理了笔记。", artifacts: [{ path: "n.md", purpose: "笔记" }], verification: [{ check: "文件存在", result: "pass", evidence: "Get-Item 看到 n.md" }], needsHuman: [], notDone: [], assumptions: [] });
const service = (over: { cost?: CostSignal; script?: boolean } = {}) => {
  const { rpc, turns } = fakeRuntime([summary], AGENT_SKILL, { script: over.script === false ? undefined : async () => {
    const dir = path.join(root, "out", listAgentTasks(store, ws)[0]!.taskId);
    writeFileSync(path.join(dir, "n.md"), "笔记");
  } } as never);
  return { turns, svc: createAgentService({ store, repoRoot: "C:\\repo", getClient: () => rpc, readCost: async () => over.cost ?? healthy, outputRoot: path.join(root, "out") }) };
};
const settled = async (svc: ReturnType<typeof service>["svc"]) => { for (let i = 0; i < 200 && svc.runningTasks(ws).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };

test("handing over an order of a kind that is not approved asks about the kind and starts nothing", async () => {
  order("wo-1", ["整理并摘要这三篇文献"]);
  const { svc, turns } = service();
  expect(svc.dispatch(ws, "wo-1")).toMatchObject({ state: "needs_category_approval", category: "read_research_organize" });
  expect(pendingCategoryRequests(store, ws)).toHaveLength(1);
  expect(turns()).toBe(0);
});

test("an approved kind starts at once, the answer does not wait for the run, and the outcome lands in the ledger", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  const { svc } = service();
  const started = svc.dispatch(ws, "wo-1");
  expect(started).toMatchObject({ state: "started" });
  expect(svc.runningTasks(ws)).toHaveLength(1);
  await settled(svc);
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ workOrderId: "wo-1", status: "needs_review", artifacts: [{ path: "n.md" }] });
});

test("wording that points at no kind needs the person to choose one; choosing one is enough", () => {
  order("wo-1", ["推进这件事"]);
  const { svc } = service({ script: false });
  expect(svc.dispatch(ws, "wo-1")).toMatchObject({ state: "blocked", code: "CATEGORY_REQUIRED" });
  expect(svc.dispatch(ws, "wo-1", "draft_text")).toMatchObject({ state: "needs_category_approval", category: "draft_text" });
});

test("the tick starts one approved order by itself, but not when the quota is nearly spent or a task is already going", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  order("wo-2", ["整理并摘要另外三篇文献"]);
  const spent = service({ cost: { ...healthy, short: { usedPercent: 97, windowDurationMins: 300, resetsAt: null } } });
  await spent.svc.pass(ws);
  expect(listAgentTasks(store, ws)).toHaveLength(0);
  const { svc } = service();
  await svc.pass(ws);
  expect(svc.runningTasks(ws)).toHaveLength(1);
  await svc.pass(ws);
  await settled(svc);
  expect(listAgentTasks(store, ws).map((task) => task.workOrderId)).toEqual(["wo-1"]);
});


// Whole-task delegation: the assistant does the errand, the person accepts the result, and the files go in as the order's evidence —
// which puts the order in front of the milestone gate.
test("a delegated errand's accepted result is handed in as the order's evidence", async () => {
  store.saveWorkOrder({ id: "wo-d", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "m", intent: "整理 NeuroSim 输入规范笔记",
    state: "approved", riskTier: "routine", estimate,
    payload: { automationParts: [], humanCore: [{ id: "h", intent: "整理 NeuroSim 输入规范笔记" }], family: "preparation", materialContract: [],
      evidenceContract: [{ kind: "file", description: "一份输入规范笔记", required: true }] } });
  approveCategory(store, ws, "read_research_organize");
  const { svc } = service();
  expect(svc.dispatch(ws, "wo-d")).toMatchObject({ state: "started" });
  await settled(svc);
  const task = listAgentTasks(store, ws)[0]!;
  expect(task).toMatchObject({ delegated: true, status: "needs_review" });
  // Needs review while the kind is new: nothing is handed in until the person accepts.
  expect(store.listWorkOrders(ws).find((o) => o.id === "wo-d")!.state).toBe("approved");
  expect(reviewAgentTask(store, ws, task.taskId, "accepted")).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((o) => o.id === "wo-d")!.state).toBe("evidence_review");
  const claims = store.listEvidenceClaims(ws).filter((claim) => claim.workOrderId === "wo-d");
  expect(claims).toHaveLength(1);
  expect(claims[0]!.uri).toMatch(/^file:.*n\.md$/);
});
