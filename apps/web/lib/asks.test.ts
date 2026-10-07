import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { answerAsk, collectAsks, explainRisk, openAsks, snoozeAsk } from "./asks";
import { countPending } from "./pending";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); });

const NOW = new Date("2026-10-07T15:00:00.000Z");
const ws = TEST_CTX.workspaceId;
const owner = TEST_CTX.principalId;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "mos2", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "实测 MoS₂ 参数已可直接驱动 NeuroSim",
    status: "approved", version: 2 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mos2", stage: 1, deadline: "2026-10-09", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  return store;
}

/** The real refusal, as the worker now records it: two missing inputs, and the milestone split anyway with getting them first. */
function refusedWithMissing(store: CrosslineStore) {
  const { eventId } = store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "blocked-1", type: "goal.backplan_blocked", entityId: "mos2",
    payload: { milestoneVersion: 2, code: "BACKPLAN_INPUT_BLOCKED", message: "…", missing: [
      { id: "m1", what: "MoS₂ 实测参数数据", whoHas: "师兄", message: "未提供实测 MoS₂ 参数数据。" },
      { id: "m2", what: "NeuroSim 输入规范", whoHas: "", message: "未提供目标 NeuroSim 版本或输入规范。" }] } });
  const draft = (id: string, payload: Record<string, unknown>) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research",
    projectId: "p", milestoneId: "mos2", intent: id, state: "awaiting_plan_approval", riskTier: "routine", estimate, payload });
  draft("get-data", { backplan: { inputsFrom: eventId, acquires: "m1" } });
  draft("map", { backplan: {}, dependsOn: ["get-data"] });
  return eventId;
}

test("a refused backplan becomes one ask per missing input, explained, urgent when the deadline is two days out", () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input");
  expect(asks.map((ask) => ask.id)).toEqual([`bp:${eventId}:m1`, `bp:${eventId}:m2`]);
  expect(asks[0]).toMatchObject({ urgency: "now", dueDay: "2026-10-09", line: "research" });
  expect(asks[0]!.title).toContain("MoS₂ 实测参数数据");
  expect(asks[0]!.why).toContain("排成了第一步");
  expect(asks[0]!.options.map((option) => option.id)).toEqual(["have", "waiting", "ask_first", "skip"]);
  // The person's own 「谁给」 is prefilled from what the model said.
  expect(asks[0]!.options[1]!.fields![0]).toMatchObject({ id: "who", initial: "师兄" });
  expect(countPending(TEST_CTX).asks).toBe(2);
});

test("an older refusal with only the joined message is still asked about, sentence by sentence", () => {
  const store = setup();
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "legacy", type: "goal.backplan_blocked", entityId: "mos2",
    payload: { milestoneVersion: 2, code: "BACKPLAN_INPUT_BLOCKED", message: "未提供实测数据。；未提供 NeuroSim 输入规范。" } });
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input").map((ask) => ask.title))
    .toEqual(["「实测 MoS₂ 参数已可直接驱动 NeuroSim」还缺：未提供实测数据。", "「实测 MoS₂ 参数已可直接驱动 NeuroSim」还缺：未提供 NeuroSim 输入规范。"]);
});

test("「我有」 hands the input over: the step that was getting it goes, the next step stands alone, and the milestone is split again", async () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m1`, "have", { text: "D:/lab/mos2/iv.csv，字段 Vg, Id" }, NOW)).toEqual({ ok: true });
  const orders = new Map(store.listWorkOrders(ws).map((order) => [order.id, order]));
  expect(orders.get("get-data")!.state).toBe("archived");
  expect((orders.get("map")!.payload as { dependsOn: string[] }).dependsOn).toEqual([]);
  expect(store.listEvents(ws, { type: "goal.backplan_input_supplied" })[0]!.payload).toMatchObject({ what: "MoS₂ 实测参数数据", text: "D:/lab/mos2/iv.csv，字段 Vg, Id" });
  expect(store.listEvents(ws, { type: "goal.backplan_rerun_requested" })).toHaveLength(1);
  expect(requestCodexSupervisor).toHaveBeenCalledWith(TEST_CTX, "/v1/goals/auto-backplan", expect.objectContaining({ method: "POST" }));
  expect(collectAsks(TEST_CTX, NOW).map((ask) => ask.id)).not.toContain(`bp:${eventId}:m1`);
  expect(store.listEvents(ws, { type: "ask.answered" })).toHaveLength(1);
  // A required field left empty is refused without changing anything.
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m2`, "have", { text: " " }, NOW)).toEqual({ ok: false, code: "ASK_FIELD_REQUIRED" });
});

test("「在等」 becomes a waiting item that holds the next step; on its day 「到了」 splits the milestone again with what arrived", async () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m1`, "waiting", { who: "师兄", date: "2026-10-08" }, NOW)).toEqual({ ok: true });
  const item = store.listWaitingItems(ws)[0]!;
  expect(item).toMatchObject({ who: "师兄", title: "MoS₂ 实测参数数据", expectedAt: "2026-10-08", blocks: ["map"], source: "backplan" });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "waiting_due")).toBe(false);
  const dayOf = new Date("2026-10-08T15:00:00.000Z");
  const waiting = collectAsks(TEST_CTX, dayOf).find((ask) => ask.kind === "waiting_due")!;
  expect(waiting).toMatchObject({ urgency: "now", title: "师兄的「MoS₂ 实测参数数据」到了吗？" });
  expect(waiting.options[0]!.fields?.[0]?.id).toBe("note");
  vi.stubEnv("CROSSLINE_FIXED_NOW", dayOf.toISOString());
  expect(await answerAsk(TEST_CTX, waiting.id, "arrived", { note: "在组里网盘 /mos2" }, dayOf)).toEqual({ ok: true });
  expect(store.listWaitingItems(ws)[0]!.state).toBe("arrived");
  expect(store.listEvents(ws, { type: "goal.backplan_input_supplied" })[0]!.payload).toMatchObject({ text: "在组里网盘 /mos2" });
  expect(store.listEvents(ws, { type: "goal.backplan_rerun_requested" })).toHaveLength(1);
});

test("「先不拆」 withdraws the milestone's unstarted steps and closes this version to the timer", async () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m2`, "skip", {}, NOW)).toEqual({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "get-data")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: "goal.backplan_declined" })[0]!.payload).toEqual({ milestoneVersion: 2 });
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input")).toEqual([]);
});

test("a snooze hides an ask until its day and lets it back early when the thing changes", () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  expect(snoozeAsk(TEST_CTX, `bp:${eventId}:m1`, "tomorrow", NOW)).toEqual({ ok: true });
  expect(openAsks(TEST_CTX, NOW).map((ask) => ask.id)).toEqual([`bp:${eventId}:m2`]);
  expect(openAsks(TEST_CTX, new Date("2026-10-08T15:00:00.000Z")).map((ask) => ask.id)).toContain(`bp:${eventId}:m1`);
});

test("a refused capture is asked about; the person's note is added to it and the analysis asked for again", async () => {
  const store = setup();
  store.capture({ id: "cap", ownerId: owner, workspaceId: ws, title: "整理组会意见", context: "组会上的三个质疑" }, "cap-1");
  store.transitionWorkOrder(ws, "cap", { type: "analysis.proposed", proposalId: "cap" }, "a1");
  store.transitionWorkOrder(ws, "cap", { type: "blocked", reason: "ANALYSIS_POLICY_BLOCKED" }, "a2",
    { audit: { blocker: { code: "ANALYSIS_POLICY_BLOCKED", message: "不清楚要交付什么" } } });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "capture_blocked")!;
  expect(ask.why).toContain("不清楚要交付什么");
  expect(await answerAsk(TEST_CTX, ask.id, "context", { note: "交付一页回应清单，周五组会前" }, NOW)).toEqual({ ok: true });
  expect(store.listCaptures(ws)[0]!.context).toContain("交付一页回应清单");
  expect(requestCodexSupervisor).toHaveBeenCalledWith(TEST_CTX, "/v1/captures/cap/analyze", expect.objectContaining({ method: "POST" }));
});

test("a gate's real 「not enough」 is asked with what would satisfy it; 「重新排上」 puts the work back", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "跑一轮仿真",
    state: "blocked", riskTier: "milestone", estimate, payload: { gateReview: { verdict: "insufficient", gaps: [{ code: "G1", whatWouldSatisfyIt: "附上仿真输出的图和数据文件" }],
      criteriaVerdict: [] } } });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "gate_insufficient")!;
  expect(ask.why).toContain("附上仿真输出的图和数据文件");
  expect(await answerAsk(TEST_CTX, ask.id, "redo", {}, NOW)).toEqual({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "wo")!.state).toBe("approved");
});

test("the risk explanation says when, how much, and by how much it misses — and that it is a forecast", () => {
  const text = explainRisk({ deadline: "2026-10-12", today: "2026-10-07", p50Day: "2026-10-10", p85Day: "2026-10-13", slackDays: -1,
    steps: 2, p50Minutes: 180, p85Minutes: 300, moreToSplit: true });
  expect(text).toContain("截止 10/12（还剩 5 天）");
  expect(text).toContain("3–5 小时");
  expect(text).toContain("顺利的话 10/10 做完");
  expect(text).toContain("要到 10/13，比截止晚 1 天");
  expect(text).toContain("后面还有没拆的");
  expect(text).toContain("不是判决");
});

test("a milestone whose known work cannot finish by its deadline is asked about; 「接受这个风险」 quiets it for a week", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "big", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "完整仿真",
    state: "approved", riskTier: "milestone", estimate: { ...estimate, p50Minutes: 3000, p85Minutes: 6000 }, payload: {} });
  const risk = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "milestone_risk")!;
  expect(risk.title).toBe("「实测 MoS₂ 参数已可直接驱动 NeuroSim」可能赶不上 10/9");
  expect(risk.options.map((option) => option.id)).toEqual(["time", "extend", "lower", "accept"]);
  expect(await answerAsk(TEST_CTX, risk.id, "accept", {}, NOW)).toEqual({ ok: true });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "milestone_risk")).toBe(false);
});
