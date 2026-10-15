import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, listAgentTasks } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ ok: true })), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { answerAsk, collectAsks } from "./asks";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); });

const NOW = new Date("2026-10-15T15:00:00.000Z");
const ws = TEST_CTX.workspaceId;
const owner = TEST_CTX.principalId;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const GROW = "把这类事固化成工作流：我希望能定期整理我的小红书收藏夹，并且重点关注一个叫“人类最强编导”的账号，按照";

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  vi.stubEnv("CROSSLINE_AI_OUTPUT_DIR", "Z:\\nowhere");
  return globalThis.crosslineStore = new CrosslineStore(":memory:");
}
function run(store: CrosslineStore, taskId: string, payload: Record<string, unknown>, stop?: { code: string; message: string }, done?: boolean) {
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId,
    payload: { taskId, category: "read_research_organize", workOrderId: "", ...payload } });
  if (stop) store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `blk-${taskId}`, type: "agent.task.blocked", entityId: taskId, payload: { taskId, ...stop } });
  if (done) store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `done-${taskId}`, type: "agent.task.completed", entityId: taskId,
    payload: { taskId, reviewRequired: false, artifacts: [] } });
}
const LOST = { code: "AGENT_RUN_LOST", message: "后台进程重启，这次运行中断" };
const agentAsks = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "agent_blocked");

test("the real 小红书 card: an interrupted growing run is not handed to the person; once grown again there is nothing to ask", () => {
  const store = setup();
  // 2026-10-14 21:11 started, lost to a restart at 21:24.
  run(store, "grow-2c465162", { title: GROW }, LOST);
  expect(agentAsks()).toEqual([]);
  // 21:44 grown again, and finished.
  run(store, "grow-66a58770", { title: GROW }, undefined, true);
  expect(agentAsks()).toEqual([]);
});

test("after three interruptions the card says how far it got and where it stopped, and offers the next steps with room for the person's words", () => {
  const store = setup();
  for (const id of ["grow-1", "grow-2", "grow-3"]) run(store, id, { title: GROW }, LOST);
  const [ask] = agentAsks();
  expect(ask).toMatchObject({ entityId: "grow-3", important: true, freeText: expect.any(Object),
    progress: { stuckAt: "后台进程重启，这次运行中断；已自动重试 2 次，仍没做完", external: false, retries: 2 }, preview: { href: "/settings#skills" } });
  expect(ask!.why).not.toContain("不会自动重试，该任务转为本人处理");
  expect(ask!.options.map((option) => option.id)).toEqual(["retry", "self", "drop", "look"]);
  expect(ask!.options.find((option) => option.recommended)?.id).toBe("retry");
});

test("a site's security check is not retried, and the card says why; the person's words go to the next run", async () => {
  const store = setup();
  run(store, "flow-x-1", { title: "整理小红书收藏夹" }, { code: "AGENT_LOOP_STOPPED", message: "读取网站被拒绝了 3 次仍在继续尝试，已自动停下" });
  const [ask] = agentAsks();
  expect(ask!.progress).toMatchObject({ external: true });
  expect(ask!.why).toContain("不会自动重试");
  expect(ask!.options.find((option) => option.recommended)?.id).toBe("self");
  expect(await answerAsk(TEST_CTX, ask!.id, { optionIds: ["retry"], note: "已在手机上完成验证，只读收藏页第一页" }, {})).toMatchObject({ ok: true });
  expect(vi.mocked(requestCodexSupervisor)).toHaveBeenCalledWith(expect.anything(), "/v1/agent/tasks/flow-x-1/retry",
    expect.objectContaining({ body: JSON.stringify({ note: "已在手机上完成验证，只读收藏页第一页" }) }));
});

test("「我自己做这一步」 makes the step the person's; 「不做了」 archives a whole order", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "期中复习", state: "approved",
    riskTier: "routine", estimate, payload: {} });
  store.saveStepPlan(ws, "wo", { archetypeId: "exam_prep", quantity: { basis: "讲", amount: 2, unit: "讲" }, rationale: "", steps: [
    { id: "a", role: "gather", title: "汇编公式表", deliverable: "公式表.md", doneCriterion: "完成", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 },
      dependsOn: [], notBefore: "", dueBy: "", tickOutcome: "", schedulable: false, executor: "agent" }] }, owner, "planned");
  const stepId = store.getStepPlan(ws, "wo")!.steps[0]!.id;
  run(store, "s1", { title: "期中复习 · 汇编公式表", workOrderId: "wo", stepId }, { code: "AGENT_CANCELLED", message: "本人中止了这次运行。" });
  const [stepAsk] = agentAsks();
  expect(stepAsk!.options.find((option) => option.id === "self")!.label).toBe("我自己做这一步");
  expect(await answerAsk(TEST_CTX, stepAsk!.id, { optionIds: ["self"] }, {})).toMatchObject({ ok: true });
  expect(store.getStepPlan(ws, "wo")!.steps[0]).toMatchObject({ executor: "human", schedulable: true });
  expect(agentAsks()).toEqual([]);

  run(store, "w1", { title: "期中复习", workOrderId: "wo" }, { code: "AGENT_ARTIFACT_MISSING", message: "你说做了「a.md」" });
  const [orderAsk] = agentAsks();
  expect(orderAsk!.options.map((option) => option.id)).toEqual(["alternative", "retry", "self", "drop", "look"]);
  expect(await answerAsk(TEST_CTX, orderAsk!.id, { optionIds: ["drop"] }, {})).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "wo")!.state).toBe("archived");
  expect(agentAsks()).toEqual([]);
  expect(listAgentTasks(store, ws)).toHaveLength(2);
});
