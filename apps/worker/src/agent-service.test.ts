import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CostSignal } from "@crossline/core";
import { approveCategory, CrosslineStore, listAgentTasks, pendingCategoryRequests, reviewAgentTask, setAutoHandoff, setCategoryMode } from "@crossline/db";
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
const order = (id: string, ai: string[], state = "approved") => {
  store.saveWorkOrder({ id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: `任务 ${id}`, state, riskTier: "routine", estimate,
    payload: { automationParts: ai.map((intent, i) => ({ id: `a${i}`, intent })), humanCore: [{ id: "h", intent: "自己决定" }], materialContract: [] } });
  // Its work starts within the hour: the worker's pass prepares only for work starting within two days.
  const starts = JSON.parse(store.getSetting(ws, "schedule.orderStarts") ?? "{}") as Record<string, string>;
  store.setSetting(ws, "schedule.orderStarts", JSON.stringify({ ...starts, [id]: new Date(Date.now() + 3_600_000).toISOString() }));
};
const healthy: CostSignal = { available: true, limitReached: false, short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } };
const summary = JSON.stringify({ summary: "整理了笔记。", artifacts: [{ path: "n.md", purpose: "笔记" }], verification: [{ check: "文件存在", result: "pass", evidence: "Get-Item 看到 n.md" }], needsHuman: [], notDone: [], assumptions: [] });
const service = (over: { cost?: CostSignal; script?: boolean; answer?: string } = {}) => {
  const { rpc, turns, prompts } = fakeRuntime([over.answer ?? summary], AGENT_SKILL, { script: over.script === false ? undefined : async () => {
    const dir = path.join(root, "out", listAgentTasks(store, ws)[0]!.taskId);
    writeFileSync(path.join(dir, "n.md"), "笔记");
  } } as never);
  return { turns, prompts, svc: createAgentService({ store, repoRoot: "C:\\repo", getClient: () => rpc, readCost: async () => over.cost ?? healthy, outputRoot: path.join(root, "out") }) };
};
const settled = async (svc: ReturnType<typeof service>["svc"]) => { for (let i = 0; i < 200 && svc.runningTasks(ws).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };

test("handing over an order of a kind that is not approved asks about the kind and starts nothing", async () => {
  store.setSetting(ws, "agent.categories", "{}");
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
  // Nothing for the person to do, allow or judge, and its checks passed: taken as accepted, and the person is told what and where.
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ workOrderId: "wo-1", status: "accepted", artifacts: [{ path: "n.md" }] });
  // Said at the next pass, once for everything accepted since the last one.
  expect(store.listRecentNudges(ws, "2000-01-01T00:00:00Z")).toHaveLength(0);
  await svc.pass(ws);
  const said = store.listRecentNudges(ws, "2000-01-01T00:00:00Z").at(-1)!;
  expect((said.payload.card as { clarify: { question: string } }).clarify.question).toMatch(/「任务 wo-1」：n\.md，放在 .*agent-wo1-1。.*已直接采纳/);
});

test("results accepted between two passes are told in one message, each with what it made and where it is", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  order("wo-2", ["整理并摘要另外三篇文献"]);
  const { svc } = service();
  svc.dispatch(ws, "wo-1");
  await settled(svc);
  svc.dispatch(ws, "wo-2");
  await settled(svc);
  await svc.pass(ws);
  const said = store.listRecentNudges(ws, "2000-01-01T00:00:00Z");
  expect(said).toHaveLength(1);
  const text = (said[0]!.payload.card as { clarify: { question: string } }).clarify.question;
  expect(text).toContain("助手做好了 2 件事");
  expect(text).toMatch(/1\. 「任务 wo-1」：n\.md，放在 .*agent-wo1-1/);
  expect(text).toMatch(/2\. 「任务 wo-2」：n\.md，放在 .*agent-wo2-1/);
  // Nothing new since: the next pass says nothing.
  await svc.pass(ws);
  expect(store.listRecentNudges(ws, "2000-01-01T00:00:00Z")).toHaveLength(1);
});

test("a result that leaves something for the person waits for their review instead", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  const { svc } = service({ answer: JSON.stringify({ ...JSON.parse(summary), needsHuman: [{ what: "确认用哪三篇", why: "只有本人知道" }] }) });
  svc.dispatch(ws, "wo-1");
  await settled(svc);
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ status: "needs_review", needsHuman: 1 });
});

test("wording that points at no kind needs the person to choose one; choosing one is enough", () => {
  store.setSetting(ws, "agent.categories", "{}");
  order("wo-1", ["推进这件事"]);
  const { svc } = service({ script: false });
  expect(svc.dispatch(ws, "wo-1")).toMatchObject({ state: "blocked", code: "CATEGORY_REQUIRED" });
  expect(svc.dispatch(ws, "wo-1", "draft_text")).toMatchObject({ state: "needs_category_approval", category: "draft_text" });
});

test("the tick starts approved orders by itself, two at a time, but not at 95% of either window or with the quota unreadable", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  order("wo-2", ["整理并摘要另外三篇文献"]);
  order("wo-3", ["整理并摘要第三组文献"]);
  for (const cost of [{ ...healthy, short: { usedPercent: 97, windowDurationMins: 300, resetsAt: null } },
    { ...healthy, long: { usedPercent: 95, windowDurationMins: 10080, resetsAt: null } }, { available: false as const, reason: "apiKey" }]) {
    await service({ cost }).svc.pass(ws);
    expect(listAgentTasks(store, ws)).toHaveLength(0);
  }
  const { svc } = service({ script: false });
  await svc.pass(ws);
  // Two runs on two different orders, and nothing more while both are going.
  expect(svc.runningTasks(ws)).toHaveLength(2);
  await svc.pass(ws);
  expect(svc.runningTasks(ws)).toHaveLength(2);
  expect(svc.runFree(ws, { taskId: "free-1", title: "x", what: "x", category: "read_research_organize", humanPart: "" })).toMatchObject({ state: "blocked", code: "AGENT_BUSY" });
  await settled(svc);
  expect(listAgentTasks(store, ws).map((task) => task.workOrderId).sort()).toEqual(["wo-1", "wo-2"]);
});

test("a new account has organizing, drafting and file preparation on without choosing; its first choice is kept", async () => {
  const { readCategories, categoryMode } = await import("@crossline/db");
  expect(Object.keys(readCategories(store, ws)).sort()).toEqual(["draft_text", "files_calendar_prep", "read_research_organize"]);
  expect(categoryMode(readCategories(store, ws).draft_text)).toBe("auto");
  // Nothing that sends, signs in or pays; code and media stay off until asked.
  expect(readCategories(store, ws).data_code_sim).toBeUndefined();
  order("wo-1", ["整理并摘要这三篇文献"]);
  const { svc } = service({ script: false });
  await svc.pass(ws);
  expect(svc.runningTasks(ws)).toHaveLength(1);
  await settled(svc);
  // Turning one off writes the set: the other two stay on, the one turned off stays off.
  setCategoryMode(store, ws, "draft_text", "off");
  expect(Object.keys(readCategories(store, ws)).sort()).toEqual(["files_calendar_prep", "read_research_organize"]);
});

test("two runs never take the same order, nor the same deliverable of one project", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  // A second task of the same project whose single errand has the same name as wo-1's: made once.
  store.saveWorkOrder({ id: "wo-2", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "任务 wo-1", state: "approved",
    riskTier: "routine", estimate, payload: { automationParts: [{ id: "a0", intent: "整理并摘要这三篇文献" }], humanCore: [{ id: "h", intent: "自己决定" }], materialContract: [] } });
  const starts = JSON.parse(store.getSetting(ws, "schedule.orderStarts") ?? "{}") as Record<string, string>;
  store.setSetting(ws, "schedule.orderStarts", JSON.stringify({ ...starts, "wo-2": new Date(Date.now() + 3_600_000).toISOString() }));
  const { svc } = service({ script: false });
  await svc.pass(ws);
  expect(svc.runningTasks(ws)).toHaveLength(1);
  await settled(svc);
});


test("the assistant keeps working while the quota is only tight (economy): 90% of the week used still starts a task", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  const cost: CostSignal = { ...healthy, short: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, long: { usedPercent: 90, windowDurationMins: 10080, resetsAt: null } };
  const { svc } = service({ cost });
  await svc.pass(ws);
  expect(svc.runningTasks(ws)).toHaveLength(1);
  await settled(svc);
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
  // A clean result that asks nothing of the person is taken as accepted by itself, and handed in at once.
  expect(task).toMatchObject({ delegated: true, status: "accepted" });
  expect(store.listWorkOrders(ws).find((o) => o.id === "wo-d")!.state).toBe("evidence_review");
  expect(reviewAgentTask(store, ws, task.taskId, "accepted")).toMatchObject({ ok: true });
  const claims = store.listEvidenceClaims(ws).filter((claim) => claim.workOrderId === "wo-d");
  expect(claims).toHaveLength(1);
  expect(claims[0]!.uri).toMatch(/^file:.*n\.md$/);
});

// 「自动交给 Agent」: a step the system can do whose block has come up goes before any other work the assistant would pick up, and its
// result follows the kind's mode — in 自动, a clean run is the step done without a review.
test("with 自动交给 Agent on, the tick starts a due step first, and a trusted kind's clean run marks it done", async () => {
  setCategoryMode(store, ws, "read_research_organize", "auto");
  order("wo-1", ["整理并摘要这三篇文献"]);
  store.saveWorkOrder({ id: "wo-s", ownerId: "o", workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "m", intent: "文献综述", state: "approved",
    riskTier: "routine", estimate, payload: {} });
  store.saveStepPlan(ws, "wo-s", { archetypeId: "literature_review", quantity: { basis: "篇", amount: 3, unit: "篇" }, rationale: "", steps: [
    { id: "a", role: "compare", title: "整理三篇文献的方法对照表", deliverable: "对照表.md", doneCriterion: "完成", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 },
      dependsOn: [], notBefore: "", dueBy: "", tickOutcome: "", schedulable: true, executor: "mixed" }] }, "o", "planned");
  const stepId = store.getStepPlan(ws, "wo-s")!.steps[0]!.id;
  const now = new Date("2026-10-12T15:00:00.000Z");
  store.setSetting(ws, "schedule.stepStarts", JSON.stringify({ [`wo-s#${stepId}`]: "2026-10-12T15:15:00.000Z" }));
  setAutoHandoff(store, ws, true);
  const { svc } = service();
  // The whole order wo-1 is also waiting; the step whose block comes up in fifteen minutes goes first.
  await svc.pass(ws, now);
  await settled(svc);
  expect(listAgentTasks(store, ws)).toHaveLength(1);
  expect(listAgentTasks(store, ws)[0]).toMatchObject({ workOrderId: "wo-s", stepId, status: "accepted" });
  expect(store.getStepPlan(ws, "wo-s")!.steps[0]!.status).toBe("done");
});

test("at startup a run with no outcome is recorded as lost, not shown as running for eight hours", () => {
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "req-old", type: "agent.task.requested", entityId: "old",
    payload: { taskId: "old", workOrderId: "a", title: "汇编公式表", category: "read_research_organize" } });
  const { svc } = service();
  expect(svc.recoverLost(ws)).toEqual(["old"]);
  expect(listAgentTasks(store, ws).find((task) => task.taskId === "old")).toMatchObject({ status: "blocked", blockerCode: "AGENT_RUN_LOST" });
  expect(svc.recoverLost(ws)).toEqual([]);
});

test("on a machine shared by several accounts, the assistant works only for the owner's", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  const svc = createAgentService({ store, repoRoot: "C:\\repo", getClient: () => undefined, readCost: async () => healthy, isOwner: () => false });
  expect(svc.dispatch(ws, "wo-1")).toMatchObject({ state: "blocked", code: "AGENT_OWNER_ONLY" });
  await svc.pass(ws);
  expect(listAgentTasks(store, ws)).toHaveLength(0);
});

test("the worker's own pass leaves work starting later than two days alone", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-far", ["整理并摘要这三篇文献"]);
  store.setSetting(ws, "schedule.orderStarts", JSON.stringify({ "wo-far": new Date(Date.now() + 5 * 86_400_000).toISOString() }));
  const { svc } = service();
  await svc.pass(ws);
  expect(listAgentTasks(store, ws)).toHaveLength(0);
});

// The owner's item 10 (2026-10-15): work the assistant lost to an interruption is run again by itself — after a wait, carrying on from what
// the lost run wrote — and the person's own words for a retry reach the next run, under the same pause and quota rules.
const lostRun = (taskId: string, by: "person" | "system" = "system") => {
  const dir = path.join(root, "out", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "half.md"), "前半部分");
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
    payload: { taskId, workOrderId: "wo-1", title: "任务 wo-1", category: "read_research_organize", ...(by === "person" ? { by } : {}) } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: `blk-${taskId}`, type: "agent.task.blocked", entityId: taskId,
    payload: { taskId, code: "AGENT_RUN_LOST", message: "后台进程重启，这次运行中断", directory: dir } });
};

test("a whole order lost to a restart is run again after its backoff, handed the lost run's files and told where it stopped", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  lostRun("agent-wo1-1");
  const { svc, prompts } = service();
  await svc.pass(ws);
  expect(svc.runningTasks(ws)).toEqual([]);
  await svc.pass(ws, new Date(Date.now() + 6 * 60_000));
  expect(svc.runningTasks(ws)).toEqual(["agent-wo1-2"]);
  await settled(svc);
  const requested = store.listEvents(ws, { type: "agent.task.requested", entityId: "agent-wo1-2" })[0]!.payload as { inputs: string[] };
  expect(requested.inputs).toContain(path.join(root, "out", "agent-wo1-1"));
  expect(prompts().join(" ")).toContain("上一次停在：后台进程重启，这次运行中断");
});

test("the person's retry records their words and starts now — unless the assistant is paused or the quota is tight, when it waits", async () => {
  approveCategory(store, ws, "read_research_organize");
  order("wo-1", ["整理并摘要这三篇文献"]);
  lostRun("agent-wo1-1");
  lostRun("agent-wo1-2");
  lostRun("agent-wo1-3");
  store.setSetting(ws, "agent.paused", "1");
  expect(await service().svc.retry(ws, "agent-wo1-3", { note: "只摘要第一篇" })).toMatchObject({ ok: true, state: "queued" });
  store.setSetting(ws, "agent.paused", "0");
  const tight = service({ cost: { ...healthy, short: { usedPercent: 97, windowDurationMins: 300, resetsAt: null } } });
  expect(await tight.svc.retry(ws, "agent-wo1-3", { note: "只摘要第一篇", only: ["摘要包含结论"] })).toMatchObject({ ok: true, state: "queued" });
  expect(listAgentTasks(store, ws)).toHaveLength(3);
  const { svc, prompts } = service();
  expect(await svc.retry(ws, "agent-wo1-3", { note: "只摘要第一篇" })).toMatchObject({ ok: true, state: "started" });
  await settled(svc);
  expect(prompts().join(" ")).toContain("只摘要第一篇");
  expect(prompts().join(" ")).toContain("只重做这些：摘要包含结论");
  const next = listAgentTasks(store, ws)[0]!;
  expect(next).toMatchObject({ taskId: "agent-wo1-4", by: "person" });
  expect(await svc.retry(ws, "missing", {})).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
});
