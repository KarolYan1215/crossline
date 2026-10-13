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
  expect(asks[0]!.why).toContain("已排为第一步");
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
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m1`, "have", { text: "D:/lab/mos2/iv.csv，字段 Vg, Id" }, NOW)).toMatchObject({ ok: true });
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
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m1`, "waiting", { who: "师兄", date: "2026-10-08" }, NOW)).toMatchObject({ ok: true });
  const item = store.listWaitingItems(ws)[0]!;
  expect(item).toMatchObject({ who: "师兄", title: "MoS₂ 实测参数数据", expectedAt: "2026-10-08", blocks: ["map"], source: "backplan" });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "waiting_due")).toBe(false);
  const dayOf = new Date("2026-10-08T15:00:00.000Z");
  const waiting = collectAsks(TEST_CTX, dayOf).find((ask) => ask.kind === "waiting_due")!;
  expect(waiting).toMatchObject({ urgency: "now", title: "师兄的「MoS₂ 实测参数数据」到了吗？" });
  expect(waiting.options[0]!.fields?.[0]?.id).toBe("note");
  vi.stubEnv("CROSSLINE_FIXED_NOW", dayOf.toISOString());
  expect(await answerAsk(TEST_CTX, waiting.id, "arrived", { note: "在组里网盘 /mos2" }, dayOf)).toMatchObject({ ok: true });
  expect(store.listWaitingItems(ws)[0]!.state).toBe("arrived");
  expect(store.listEvents(ws, { type: "goal.backplan_input_supplied" })[0]!.payload).toMatchObject({ text: "在组里网盘 /mos2" });
  expect(store.listEvents(ws, { type: "goal.backplan_rerun_requested" })).toHaveLength(1);
});

/**
 * The real account: 师兄's data was already a waiting item (recorded by hand on the next milestone's task, 「西湖 MoS2 真实
 *测量数据」), and answering the backplan's 「在等」 opened a second one for the same thing on the same day.
 */
function alreadyWaiting(store: CrosslineStore) {
  store.saveMilestone({ id: "chart", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "真实数据仿真图表已获合作师兄接收",
    status: "approved", version: 2 });
  store.saveWorkOrder({ id: "sim", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "chart",
    intent: "处理西湖 MoS₂ 实测数据", state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: {} });
  store.saveWaitingItem({ id: "wait-sim-0", ownerId: owner, workspaceId: ws, title: "西湖 MoS2 真实测量数据", who: "师兄", expectedAt: "2026-10-08",
    approximate: true, followUpAt: "2026-10-08", state: "open", blocks: ["sim"], source: "manual" });
}

test("「在等」 for something already waited on (same person, same day, same project) reuses that item; 「到了」 on it re-splits", async () => {
  const store = setup();
  alreadyWaiting(store);
  const eventId = refusedWithMissing(store);
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m1`, "waiting", { who: " 师兄", date: "2026-10-08" }, NOW)).toMatchObject({ ok: true });
  expect(store.listWaitingItems(ws)).toEqual([expect.objectContaining({ id: "wait-sim-0", blocks: ["sim", "map"] })]);
  const dayOf = new Date("2026-10-08T15:00:00.000Z");
  const waiting = collectAsks(TEST_CTX, dayOf).filter((ask) => ask.kind === "waiting_due");
  expect(waiting.map((ask) => ask.id)).toEqual(["wait:wait-sim-0"]);
  expect(waiting[0]!.why).toContain("重新拆");
  vi.stubEnv("CROSSLINE_FIXED_NOW", dayOf.toISOString());
  expect(await answerAsk(TEST_CTX, waiting[0]!.id, "arrived", {}, dayOf)).toMatchObject({ ok: true });
  expect(store.listEvents(ws, { type: "goal.backplan_input_supplied" }).map((event) => event.entityId)).toEqual(["mos2"]);
  expect(store.listEvents(ws, { type: "goal.backplan_rerun_requested" }).map((event) => event.entityId)).toEqual(["mos2"]);
  // A different person, or a different day, is a different wait.
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m2`, "waiting", { who: "导师", date: "2026-10-09" }, dayOf)).toMatchObject({ ok: true });
  expect(store.listWaitingItems(ws, { state: "open" }).map((item) => item.id)).toEqual([`wait-bp-mos2-${eventId.slice(0, 8)}-m2`]);
});

test("a pair recorded before this fix is one card, and 「到了」 on it closes both and re-splits the milestone", async () => {
  const store = setup();
  alreadyWaiting(store);
  store.saveWaitingItem({ id: "wait-bp-mos2-abcdef12-m1", ownerId: owner, workspaceId: ws, title: "实测 MoS₂ 参数数据及元数据", who: "师兄",
    expectedAt: "2026-10-08", approximate: true, followUpAt: "2026-10-08", state: "open", blocks: [], source: "backplan" });
  const dayOf = new Date("2026-10-08T15:00:00.000Z");
  vi.stubEnv("CROSSLINE_FIXED_NOW", dayOf.toISOString());
  const waiting = collectAsks(TEST_CTX, dayOf).filter((ask) => ask.kind === "waiting_due");
  expect(waiting).toHaveLength(1);
  expect(await answerAsk(TEST_CTX, waiting[0]!.id, "arrived", { note: "在组里网盘 /mos2" }, dayOf)).toMatchObject({ ok: true });
  expect(store.listWaitingItems(ws).map((item) => item.state)).toEqual(["arrived", "arrived"]);
  expect(store.listEvents(ws, { type: "goal.backplan_input_supplied" })[0]).toMatchObject({ entityId: "mos2", payload: { text: "在组里网盘 /mos2" } });
  expect(store.listEvents(ws, { type: "goal.backplan_rerun_requested" })).toHaveLength(1);
  expect(collectAsks(TEST_CTX, dayOf).some((ask) => ask.kind === "waiting_due")).toBe(false);
});

test("「先不拆」 withdraws the milestone's unstarted steps and closes this version to the timer", async () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  expect(await answerAsk(TEST_CTX, `bp:${eventId}:m2`, "skip", {}, NOW)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "get-data")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: "goal.backplan_declined" })[0]!.payload).toEqual({ milestoneVersion: 2 });
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input")).toEqual([]);
});

test("a snooze hides an ask until its day and lets it back early when the thing changes", () => {
  const store = setup();
  const eventId = refusedWithMissing(store);
  expect(snoozeAsk(TEST_CTX, `bp:${eventId}:m1`, "tomorrow", NOW)).toMatchObject({ ok: true });
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
  expect(await answerAsk(TEST_CTX, ask.id, "context", { note: "交付一页回应清单，周五组会前" }, NOW)).toMatchObject({ ok: true });
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
  expect(await answerAsk(TEST_CTX, ask.id, "redo", {}, NOW)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "wo")!.state).toBe("approved");
});

test("the risk explanation says when, how much, and by how much it misses — and that it is a forecast", () => {
  const text = explainRisk({ deadline: "2026-10-12", today: "2026-10-07", p50Day: "2026-10-10", p85Day: "2026-10-13", slackDays: -1,
    steps: 2, p50Minutes: 180, p85Minutes: 300, moreToSplit: true });
  expect(text).toContain("截止 10/12（剩 5 天）");
  expect(text).toContain("3–5 小时");
  expect(text).toContain("通常 10/10 完成");
  expect(text).toContain("保守估计 10/13 完成，比截止晚 1 天");
  expect(text).toContain("尚有未拆分的工作");
  expect(text).toContain("基于已知工作的预测");
});

test("a milestone whose known work cannot finish by its deadline is asked about; 「接受这个风险」 quiets it for a week", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "big", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "完整仿真",
    state: "approved", riskTier: "milestone", estimate: { ...estimate, p50Minutes: 3000, p85Minutes: 6000 }, payload: {} });
  const risk = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "milestone_risk")!;
  expect(risk.title).toBe("「实测 MoS₂ 参数已可直接驱动 NeuroSim」可能赶不上 10/9");
  expect(risk.options.map((option) => option.id)).toEqual(["time", "extend", "lower", "accept"]);
  expect(await answerAsk(TEST_CTX, risk.id, "accept", {}, NOW)).toMatchObject({ ok: true });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "milestone_risk")).toBe(false);
});

test("work given a time yesterday and never started is asked about when it bears on a deadline this week; the rest just rolls", async () => {
  const store = setup();
  const save = (id: string, dueDate: string) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p",
    milestoneId: "", intent: `任务 ${id}`, state: "approved", riskTier: "routine", estimate, payload: { dueDate } });
  save("soon", "2026-10-10");
  save("far", "2026-11-20");
  store.setSetting(ws, "schedule.day:2026-10-06", JSON.stringify({ soon: "09:00", far: "14:00" }));
  const missed = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "missed_block");
  expect(missed.map((ask) => ask.entityId)).toEqual(["soon"]);
  expect(missed[0]!.title).toBe("昨天 09:00 排的「任务 soon」没开始");
  expect(missed[0]!.options.map((option) => option.id)).toEqual(["roll", "later", "done", "drop"]);
  expect(await answerAsk(TEST_CTX, missed[0]!.id, "later", { date: "2026-10-09" }, NOW)).toMatchObject({ ok: true });
  expect((store.listWorkOrders(ws).find((order) => order.id === "soon")!.payload as { notBefore?: string }).notBefore).toBe("2026-10-09");
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "missed_block")).toBe(false);
});

test("missing inputs of a milestone still in the task library wait until its window opens", () => {
  const store = setup();
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mos2", stage: 1, deadline: "2026-12-17", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  refusedWithMissing(store);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input")).toEqual([]);
  // Three weeks before the deadline the questions come up.
  expect(collectAsks(TEST_CTX, new Date("2026-11-26T15:00:00.000Z")).filter((ask) => ask.kind === "backplan_input")).toHaveLength(2);
});

test("a preparation step the runtime lost is not asked about while the worker will run it again; its last refusal on its own merits is", async () => {
  const store = setup();
  const run = (n: number, code: string) => {
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${n}`, type: "agent.task.requested", entityId: `t${n}`,
      payload: { taskId: `t${n}`, workOrderId: "wo", stepId: "v1s1", title: "汇编公式表", category: "read_research_organize" } });
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `blk-${n}`, type: "agent.task.blocked", entityId: `t${n}`,
      payload: { taskId: `t${n}`, code, message: "已取消" } });
  };
  const assistantAsks = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "agent_blocked").map((ask) => ask.entityId);
  run(1, "SKILL_CANCELED");
  expect(assistantAsks()).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  run(2, "AGENT_ARTIFACT_MISSING");
  expect(assistantAsks()).toEqual(["t2"]);
});

test("only this week's decisions are counted and listed; one whose work starts later waits under 「以后再定」 and comes back by itself", () => {
  const store = setup();
  refusedWithMissing(store);
  // A second milestone due in seven weeks, with a proposal under it and a draft milestone due as far out.
  store.saveMilestone({ id: "far", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "远期里程碑", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "far", stage: 1, deadline: "2026-11-25", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  store.saveWorkOrder({ id: "far-task", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "far", intent: "远期任务",
    state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: {} });
  store.saveMilestone({ id: "far-draft", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "远期草稿", status: "draft", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "far-draft", stage: 1, deadline: "2027-01-30", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  const counts = countPending(TEST_CTX);
  // The two drafts under the milestone due on 10-09 are this week's; the far task and the far draft are not.
  expect(counts.workOrders).toBe(2);
  expect(counts.milestoneDrafts).toBe(0);
  expect(counts.later).toMatchObject({ workOrders: 1, milestoneDrafts: 1 });
  expect(counts.total).toBe(counts.workOrders + counts.asks + counts.research + counts.dates + counts.targets
    + counts.assistantKinds + counts.assistantQuestions + counts.assistantReviews + counts.questions);
  // Asks about the near milestone are this week's and carry its importance; nothing about the far one is asked yet.
  const asks = openAsks(TEST_CTX, NOW);
  expect(asks.filter((ask) => ask.entityId === "mos2").every((ask) => !ask.entersOn && typeof ask.importance === "number")).toBe(true);
  // Five weeks on, the far task is this week's.
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-11-18T15:00:00.000Z");
  expect(countPending(TEST_CTX).later.workOrders).toBe(0);
});

test("background work the worker paused is told to the person, with where to look; a worker that is down is not asked twice", () => {
  const store = setup();
  store.setSetting(ws, "background.blocker", JSON.stringify({ code: "COST_SIGNAL_UNAVAILABLE",
    reason: "chatgpt authentication required", message: "读不到模型额度（还没有登录模型账号），后台自动工作已暂停。", at: NOW.toISOString() }));
  const paused = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "background_paused");
  expect(paused?.why).toContain("还没有登录模型账号");
  expect(paused?.why).not.toContain("chatgpt");
  expect(paused?.options[0]?.href).toBe("/settings#usage");
  store.setSetting(ws, "background.blocker", JSON.stringify({ code: "COST_SIGNAL_UNAVAILABLE", reason: "CODEX_SUPERVISOR_UNAVAILABLE", message: "读不到模型额度", at: NOW.toISOString() }));
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "background_paused")).toBe(false);
  store.setSetting(ws, "background.blocker", "");
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "background_paused")).toBe(false);
});


test("a locked block a calendar event lands on is asked about, and each answer does what it says", async () => {
  const store = setup();
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago", mode: "buffered" }));
  store.saveWorkOrder({ id: "hw3", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "作业 3",
    state: "ready_for_human", riskTier: "routine", estimate, payload: {} });
  store.savePlanVersion({ id: "plan-1", ownerId: owner, workspaceId: ws, version: 1, status: "current", payload: { blocks: [
    { id: "graph_calendar:sync", lane: "human", title: "Sync up", day: "2026-10-08", start: "11:30", end: "12:30", source: "日历", readOnly: true }] } });
  const lock = (overlapOk?: boolean) => store.setSetting(ws, "schedule.frozen", JSON.stringify([{ blockId: "scheduled:hw3", reason: "locked",
    start: "2026-10-08T16:00:00.000Z", end: "2026-10-08T17:00:00.000Z", ...(overlapOk ? { overlapOk } : {}) }]));
  lock();
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "locked_conflict");
  expect(ask).toMatchObject({ id: "locked:scheduled:hw3", entityId: "hw3", dueDay: "2026-10-08" });
  expect(ask!.title).toContain("Sync up");
  expect(ask!.options.map((option) => option.id)).toEqual(["move", "tomorrow", "keep"]);

  expect(await answerAsk(TEST_CTX, ask!.id, "keep", {}, NOW)).toMatchObject({ ok: true });
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!)[0]).toMatchObject({ blockId: "scheduled:hw3", overlapOk: true });
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "locked_conflict")).toBe(false);

  lock();
  expect(await answerAsk(TEST_CTX, ask!.id, "tomorrow", {}, NOW)).toMatchObject({ ok: true });
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!)).toEqual([]);
  expect((store.listWorkOrders(ws).find((item) => item.id === "hw3")!.payload as { notBefore?: string }).notBefore).toBe("2026-10-08");

  lock();
  expect(await answerAsk(TEST_CTX, ask!.id, "move", {}, NOW)).toMatchObject({ ok: true });
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!)).toEqual([]);
});
