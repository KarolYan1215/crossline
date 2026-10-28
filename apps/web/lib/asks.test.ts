import { afterEach, describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { askQuadrant } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { answerAsk, collectAsks, explainRisk, openAsks, snoozeAsk, writeAttentionSnapshot } from "./asks";
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

test("missing inputs are not asked about: the split makes getting each one a step, and nothing waits for a decision", () => {
  const store = setup();
  refusedWithMissing(store);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input")).toEqual([]);
  expect(countPending(TEST_CTX).asks).toBe(0);
  // The step that gets the first input is there, and the step after it waits for it.
  expect(store.listWorkOrders(ws).find((order) => order.id === "map")!.payload).toMatchObject({ dependsOn: ["get-data"] });
});

/** A waiting item the person already had, for the same thing a milestone's split now needs. */
function alreadyWaiting(store: CrosslineStore) {
  store.saveMilestone({ id: "chart", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "真实数据仿真图表已获合作师兄接收",
    status: "approved", version: 2 });
  store.saveWorkOrder({ id: "sim", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "chart",
    intent: "处理西湖 MoS₂ 实测数据", state: "awaiting_plan_approval", riskTier: "routine", estimate, payload: {} });
  store.saveWaitingItem({ id: "wait-sim-0", ownerId: owner, workspaceId: ws, title: "西湖 MoS2 真实测量数据", who: "师兄", expectedAt: "2026-10-08",
    approximate: true, followUpAt: "2026-10-08", state: "open", blocks: ["sim"], source: "manual" });
}

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

/** A backplan that stopped with nothing split at all: the one backplan question still asked. */
function refusedOutright(store: CrosslineStore) {
  return store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "blocked-all", type: "goal.backplan_blocked", entityId: "mos2",
    payload: { milestoneVersion: 2, code: "BACKPLAN_SCHEMA_INVALID", message: "答案不完整" } }).eventId;
}

test("a backplan that split nothing is asked about; 「先不拆」 withdraws the milestone's unstarted steps and closes this version to the timer", async () => {
  const store = setup();
  refusedWithMissing(store);
  const eventId = refusedOutright(store);
  const [ask] = collectAsks(TEST_CTX, NOW).filter((item) => item.kind === "backplan_input");
  expect(ask).toMatchObject({ id: `bp:${eventId}:all`, urgency: "now" });
  expect(ask!.options.map((option) => option.id)).toEqual(["retry", "own", "skip"]);
  expect(await answerAsk(TEST_CTX, ask!.id, "skip", {}, NOW)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "get-data")!.state).toBe("archived");
  expect(store.listEvents(ws, { type: "goal.backplan_declined" })[0]!.payload).toEqual({ milestoneVersion: 2 });
  expect(collectAsks(TEST_CTX, NOW).filter((item) => item.kind === "backplan_input")).toEqual([]);
});

test("a snooze hides an ask until its day and lets it back early when the thing changes", () => {
  const store = setup();
  const eventId = refusedOutright(store);
  expect(snoozeAsk(TEST_CTX, `bp:${eventId}:all`, "tomorrow", NOW)).toMatchObject({ ok: true });
  expect(openAsks(TEST_CTX, NOW).map((ask) => ask.id)).not.toContain(`bp:${eventId}:all`);
  expect(openAsks(TEST_CTX, new Date("2026-10-08T15:00:00.000Z")).map((ask) => ask.id)).toContain(`bp:${eventId}:all`);
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

test("a gate's 「部分」 (contract covered, the person's play not followed) says which rules of the line skill were broken", () => {
  const store = setup();
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "p", milestoneId: "m", intent: "小红书首篇笔记提纲",
    state: "blocked", riskTier: "milestone", estimate, payload: { gateReview: { verdict: "partial", gaps: [], criteriaVerdict: [],
      fit: { fits: false, violated: ["先制造冲突、点出焦虑，再给出 solution"], why: "提纲按科研报告写成" } } } });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "gate_insufficient")!;
  expect(ask.title).toBe("「小红书首篇笔记提纲」不符合本人的打法");
  expect(ask.why).toContain("违背了主线 skill：先制造冲突、点出焦虑，再给出 solution。提纲按科研报告写成。");
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

test("work that runs past eight weeks but finishes before a deadline months away is not called at risk (the forecast reaches the deadline)", () => {
  const store = setup();
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mos2", stage: 1, deadline: "2027-01-29", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  store.saveWorkOrder({ id: "long", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "长期仿真",
    state: "approved", riskTier: "milestone", estimate: { ...estimate, p50Minutes: 15000, p85Minutes: 22000 }, payload: {} });
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "milestone_risk")).toBe(false);
});

test("while the reviewer's risk question on a milestone waits, the forecast's question on it does not stand beside it", async () => {
  const store = setup();
  const { MILESTONE_RISKS_SETTING, milestoneRiskFingerprint } = await import("@crossline/core");
  store.saveWorkOrder({ id: "big", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "完整仿真",
    state: "approved", riskTier: "milestone", estimate: { ...estimate, p50Minutes: 3000, p85Minutes: 6000 }, payload: {} });
  const fingerprint = milestoneRiskFingerprint({ title: "实测 MoS₂ 参数已可直接驱动 NeuroSim", deadline: "2026-10-09", criteria: [], dependsOn: [] });
  store.setSetting(ws, MILESTONE_RISKS_SETTING, JSON.stringify({ mos2: { fingerprint, at: "2026-10-06T00:00:00Z", source: "model",
    risks: [{ level: "medium", kind: "time", note: "只剩两天" }] } }));
  const kinds = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.entityId === "mos2").map((ask) => ask.kind);
  expect(kinds()).toEqual(["milestone_risk_review"]);
  expect(await answerAsk(TEST_CTX, "riskreview:mos2", "ignore", {}, NOW)).toMatchObject({ ok: true });
  expect(kinds()).toEqual(["milestone_risk"]);
});

test("a reviewed medium or high risk is put to the person first: only 「接受」 lets the schedule aim the work early, and an answer is not asked again", async () => {
  const store = setup();
  const { MILESTONE_RISKS_SETTING, milestoneRiskFingerprint } = await import("@crossline/core");
  const { planningInputFor, readRiskDecisions } = await import("./crossline");
  store.saveWorkOrder({ id: "sim", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "跑一轮仿真",
    state: "approved", riskTier: "milestone", estimate, payload: {} });
  const fingerprint = milestoneRiskFingerprint({ title: "实测 MoS₂ 参数已可直接驱动 NeuroSim", deadline: "2026-10-09", criteria: [], dependsOn: [] });
  store.setSetting(ws, MILESTONE_RISKS_SETTING, JSON.stringify({ mos2: { fingerprint, at: "2026-10-06T00:00:00Z", source: "model",
    risks: [{ level: "high", kind: "time", note: "只剩两天且数据未到" }, { level: "low", kind: "unclear", note: "标准偏主观" }] } }));
  const buffer = () => planningInputFor(TEST_CTX, "2026-10-07", []).input.tasks.find((task) => task.id === "sim")?.riskBufferDays;
  // Reviewed but not answered: the schedule does not move.
  expect(buffer()).toBeUndefined();
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "milestone_risk_review")!;
  expect(ask.title).toBe("「实测 MoS₂ 参数已可直接驱动 NeuroSim」有高风险：时间紧");
  expect(ask.risks).toEqual([{ level: "high", kind: "time", note: "只剩两天且数据未到" }]);
  expect(ask.options.map((option) => option.id)).toEqual(["accept", "extend", "lower", "ignore"]);
  expect(ask.options.find((option) => option.id === "lower")?.href).toBe("/milestones?open=mos2");
  expect(await answerAsk(TEST_CTX, ask.id, "accept", {}, NOW)).toMatchObject({ ok: true });
  expect(readRiskDecisions(TEST_CTX).mos2).toMatchObject({ how: "accept", fingerprint });
  expect(buffer()).toBe(2);
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "milestone_risk_review")).toBe(false);
  // 「不用管」 on a later review: answered, and no buffer.
  store.setSetting(ws, MILESTONE_RISKS_SETTING, JSON.stringify({ mos2: { fingerprint, at: "2026-10-07T00:00:00Z", source: "model",
    risks: [{ level: "medium", kind: "capacity", note: "同周还有三个截止" }] } }));
  store.setSetting(ws, "schedule.riskDecisions", "{}");
  const again = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "milestone_risk_review")!;
  expect(await answerAsk(TEST_CTX, again.id, "ignore", {}, NOW)).toMatchObject({ ok: true });
  expect(buffer()).toBeUndefined();
});

test("several reviewed risks are one card, as pressing as its nearest deadline and heaviest milestone; 「逐个决定」 splits it back (W-29)", async () => {
  const store = setup();
  const { MILESTONE_RISKS_SETTING, milestoneRiskFingerprint } = await import("@crossline/core");
  const { readRiskDecisions, saveGoalSettings } = await import("./crossline");
  store.saveMilestone({ id: "pitch", ownerId: owner, workspaceId: ws, identityId: "startup", projectId: "q", title: "首批 5 家门店签试用", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "pitch", stage: 1, deadline: "2026-10-13", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  // Not the 2-day mos2 deadline this time: only the 6-day one, weighted 65 by the person (the walkthrough's case).
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mos2", stage: 1, deadline: "2026-11-30", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  saveGoalSettings(TEST_CTX, "pitch", { importance: "ordinary", weight: 65 });
  const review = (title: string, deadline: string) => milestoneRiskFingerprint({ title, deadline, criteria: [], dependsOn: [] });
  store.setSetting(ws, MILESTONE_RISKS_SETTING, JSON.stringify({
    mos2: { fingerprint: review("实测 MoS₂ 参数已可直接驱动 NeuroSim", "2026-11-30"), at: "2026-10-06T00:00:00Z", source: "model", risks: [{ level: "medium", kind: "capacity", note: "同月还有三个截止" }] },
    pitch: { fingerprint: review("首批 5 家门店签试用", "2026-10-13"), at: "2026-10-06T00:00:00Z", source: "model", risks: [{ level: "medium", kind: "time", note: "只剩一周" }] } }));
  const risky = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "milestone_risk_review");
  const [batch, ...rest] = risky();
  expect(rest).toEqual([]);
  expect(batch).toMatchObject({ id: "riskreview:batch", title: "2 个里程碑有风险待过目", urgency: "soon", dueDay: "2026-10-13", important: true });
  expect(askQuadrant(batch!)).toBe("important");
  // The members are rows the card draws (2026-10-21: 25 milestones in one sentence), nearest deadline first at equal level; the
  // sentence keeps only the count.
  expect(batch!.items).toEqual([
    { id: "pitch", title: "首批 5 家门店签试用", dueDay: "2026-10-13", line: "startup", href: "/milestones?open=pitch", risks: [{ level: "medium", kind: "time", note: "只剩一周" }] },
    expect.objectContaining({ id: "mos2", title: "实测 MoS₂ 参数已可直接驱动 NeuroSim", dueDay: "2026-11-30" })
  ]);
  expect(batch!.why).toContain("2 个里程碑上找出风险");
  expect(batch!.why).not.toContain("首批");
  expect(batch!.options.map((option) => option.id)).toEqual(["accept", "split", "ignore"]);
  // 逐个决定: one card each, the 65-weighted one no longer filed as unimportant by an explicit `important: false`.
  expect(await answerAsk(TEST_CTX, batch!.id, "split", {}, NOW)).toMatchObject({ ok: true });
  expect(risky().map((ask) => ask.entityId).sort()).toEqual(["mos2", "pitch"]);
  expect(risky().find((ask) => ask.entityId === "pitch")!.important).toBeUndefined();
  // A new review changes the set, so it folds again; 「全部接受」 answers every member.
  store.setSetting(ws, "asks.riskReview.split", "");
  expect(await answerAsk(TEST_CTX, "riskreview:batch", "accept", {}, NOW)).toMatchObject({ ok: true });
  expect(Object.keys(readRiskDecisions(TEST_CTX)).sort()).toEqual(["mos2", "pitch"]);
  expect(risky()).toEqual([]);
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

test("two or more blocks not started yesterday are one card: 都顺延 settles them all, 逐个处理 splits them", async () => {
  const store = setup();
  for (const id of ["a", "b"]) store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p",
    milestoneId: "", intent: `任务 ${id}`, state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-10-09" } });
  store.setSetting(ws, "schedule.day:2026-10-06", JSON.stringify({ a: "09:00", b: "14:00" }));
  const missed = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "missed_block");
  expect(missed().map((ask) => ask.entityId)).toEqual(["batch"]);
  expect(missed()[0]!.items!.map((item) => item.id).sort()).toEqual(["a", "b"]);
  expect(await answerAsk(TEST_CTX, missed()[0]!.id, "split", {}, NOW)).toMatchObject({ ok: true });
  expect(missed().map((ask) => ask.entityId).sort()).toEqual(["a", "b"]);
  store.setSetting(ws, "asks.missed.split", "");
  expect(await answerAsk(TEST_CTX, missed()[0]!.id, "roll", {}, NOW)).toMatchObject({ ok: true });
  expect(missed()).toEqual([]);
});

test("a block whose completion check was answered yesterday is not asked about again the next day", () => {
  const store = setup();
  const save = (id: string) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p",
    milestoneId: "", intent: `任务 ${id}`, state: "approved", riskTier: "routine", estimate, payload: { dueDate: "2026-10-10" } });
  save("answered");
  save("silent");
  store.setSetting(ws, "schedule.day:2026-10-06", JSON.stringify({ answered: "09:00", silent: "14:00" }));
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "block-confirmed:m1", type: "block.confirmed", entityId: "m1",
    payload: { blockId: "scheduled:answered", workOrderId: "answered", day: "2026-10-06", outcome: "not_done" } });
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "missed_block").map((ask) => ask.entityId)).toEqual(["silent"]);
});

describe("work that is not the person's own (docs/work-split.md)", () => {
  const save = (store: CrosslineStore, id: string, intent: string, state: string, payload: Record<string, unknown>) => store.saveWorkOrder({ id, ownerId: owner,
    workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent, state: state as never, riskTier: "routine", estimate, payload: { title: intent, ...payload } });

  test("a question for the assistant is one ask, never a task: answered, the work is the assistant's and takes effect; undone, it is a question again", async () => {
    const store = setup();
    save(store, "core", "根据已汇集的规则规划期中复习", "approved", { owner: "person", dueDate: "2026-10-08" });
    save(store, "q", "整理本学期已出成绩", "awaiting_plan_approval", { owner: "ask", prepares: "core", question: "已出的作业和小测成绩各是多少？Gradescope 能导出吗？还有别的吗？" });
    const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "prep_question")!;
    expect(ask).toMatchObject({ id: "prepq:q", entityId: "q", urgency: "now", dueDay: "2026-10-08", important: true, preview: { href: "/workbench/core" } });
    // At most two questions on a card.
    expect(ask.title).toContain("已出的作业和小测成绩各是多少？");
    expect(ask.title).not.toContain("还有别的吗");
    expect(countPending(TEST_CTX)).toMatchObject({ workOrders: 0, asks: 1 });
    const result = await answerAsk(TEST_CTX, ask.id, { optionIds: ["answer"], note: "作业 2 次各 95，小测 1 次 88" }, {}, NOW);
    expect(result).toMatchObject({ ok: true });
    const order = () => store.listWorkOrders(ws).find((item) => item.id === "q")!;
    expect(order()).toMatchObject({ state: "approved", payload: { owner: "assistant", prepares: "core", answer: "作业 2 次各 95，小测 1 次 88" } });
    expect(store.listEvents(ws, { type: "prep.question_answered", entityId: "q" })).toHaveLength(1);
    expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "prep_question")).toBe(false);
    const { undoOp } = await import("./undo");
    expect(undoOp(TEST_CTX, (result as { op?: { id: string } }).op!.id)).toMatchObject({ ok: true });
    expect(order()).toMatchObject({ state: "awaiting_plan_approval", payload: { owner: "ask" } });
  });

  test("撤销 on the work-split reorganisation puts the payloads back, and a proposal that took effect since is a proposal again", async () => {
    const store = setup();
    save(store, "prep", "汇集期中规则", "approved", { owner: "assistant", prepares: "", reorganized: "repair.work-split.v1" });
    save(store, "kept", "汇集讲义", "approved", { owner: "assistant" });
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "op.applied:op-split", type: "op.applied", entityId: "op-split",
      payload: { bySystem: true, label: "任务分工整理", inverse: { kind: "work_order.payload", entries: [
        { id: "prep", payload: { title: "汇集期中规则" }, state: "awaiting_plan_approval" }, { id: "kept", payload: { title: "汇集讲义" }, state: "approved" }] } } });
    const { undoOp } = await import("./undo");
    expect(undoOp(TEST_CTX, "op-split")).toMatchObject({ ok: true });
    const get = (id: string) => store.listWorkOrders(ws).find((item) => item.id === id)!;
    expect(get("prep")).toMatchObject({ state: "awaiting_plan_approval", payload: { title: "汇集期中规则" } });
    expect((get("prep").payload as { owner?: string }).owner).toBeUndefined();
    expect(get("kept")).toMatchObject({ state: "approved", payload: { title: "汇集讲义" } });
  });

  test("撤销 on the reorganisation also gives a task its open steps back", async () => {
    const store = setup();
    save(store, "core", "规划期中复习", "approved", { owner: "person" });
    const plan = (executor: "human" | "agent") => ({ archetypeId: "problem_set", quantity: { basis: "", amount: 0, unit: "" }, rationale: "", units: [], questions: [],
      steps: [{ id: "s1", role: "do", title: "下载往年卷", deliverable: "", doneCriterion: "", share: 1, estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60 },
        dependsOn: [], notBefore: "", dueBy: "", schedulable: executor === "human", executor, tickOutcome: "" }] });
    store.saveStepPlan(ws, "core", plan("agent"), owner, "work-split");
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "op.applied:op-steps", type: "op.applied", entityId: "op-steps",
      payload: { bySystem: true, label: "任务分工整理", inverse: { kind: "step_plan.restore", plans: [{ workOrderId: "core", plan: plan("human") }] } } });
    const { undoOp } = await import("./undo");
    expect(undoOp(TEST_CTX, "op-steps")).toMatchObject({ ok: true });
    expect(store.getStepPlan(ws, "core")!.steps.map((step) => [step.title, step.executor, step.schedulable])).toEqual([["下载往年卷", "human", true]]);
  });

  test("「不需要」 archives the question by the system; an answer with no words is refused", async () => {
    const store = setup();
    save(store, "q", "确认期中复习范围", "awaiting_plan_approval", { owner: "ask", question: "期中考到第几讲？" });
    expect(await answerAsk(TEST_CTX, "prepq:q", "answer", {}, NOW)).toMatchObject({ ok: false });
    expect(await answerAsk(TEST_CTX, "prepq:q", "skip", {}, NOW)).toMatchObject({ ok: true });
    expect(store.listWorkOrders(ws).find((item) => item.id === "q")!.state).toBe("archived");
  });

  test("no reminder or question about the assistant's work: not missed yesterday, not at risk, not a gate verdict", () => {
    const store = setup();
    save(store, "prep", "形成 ECE 548 各计分组成的当前成绩与待定状态清单", "approved", { owner: "assistant", dueDate: "2026-10-09" });
    store.setSetting(ws, "schedule.day:2026-10-06", JSON.stringify({ prep: "09:00" }));
    const kinds = collectAsks(TEST_CTX, NOW).filter((ask) => ask.entityId === "prep" || ask.entityId === "mos2").map((ask) => ask.kind);
    expect(kinds).not.toContain("missed_block");
    expect(kinds).not.toContain("milestone_risk");
  });

  test("a milestone that is only preparation carries no risk card of its own", () => {
    const store = setup();
    store.saveMilestone({ id: "mos2", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", title: "考核缺口已可按 A- 分数线识别", status: "approved", version: 3,
      successCriteria: [{ id: "c1", statement: "ECE 548 与 ECE 555 考核缺口已可按 A- 分数线识别", measure: { kind: "artifact" } }] as never });
    save(store, "work", "推导第 3 章的状态方程", "approved", { owner: "person", dueDate: "2026-10-09" });
    save(store, "work2", "完成第 4 章习题", "approved", { owner: "person", dueDate: "2026-10-09" });
    for (const id of ["work", "work2"]) store.saveWorkOrder({ ...store.listWorkOrders(ws).find((item) => item.id === id)!, estimate: { ...estimate, p50Minutes: 6000, p85Minutes: 9000 } });
    expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "milestone_risk" && ask.entityId === "mos2")).toBe(false);
  });
});

test("a backplan question about a milestone still in the task library waits until its window opens", () => {
  const store = setup();
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mos2", stage: 1, deadline: "2026-12-17", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  refusedOutright(store);
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "backplan_input")).toEqual([]);
  // Three weeks before the deadline it comes up.
  expect(collectAsks(TEST_CTX, new Date("2026-11-26T15:00:00.000Z")).filter((ask) => ask.kind === "backplan_input")).toHaveLength(1);
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
  // A proposal counts once its steps are planned (`proposalReady`).
  for (const id of ["get-data", "map", "far-task"]) store.saveStepPlan(ws, id, { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" },
    rationale: "", steps: [{ id: "s", role: "solve", title: "做", deliverable: "产出", doneCriterion: "完成", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 },
      dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "" }] }, owner, "planned");
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
  // Everything waits on it: 待确认 and Today's opener agree it is urgent and important (W-22).
  expect(askQuadrant(paused!)).toBe("urgent_important");
  store.setSetting(ws, "background.blocker", JSON.stringify({ code: "COST_SIGNAL_UNAVAILABLE", reason: "CODEX_SUPERVISOR_UNAVAILABLE", message: "读不到模型额度", at: NOW.toISOString() }));
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "background_paused")).toBe(false);
  store.setSetting(ws, "background.blocker", "");
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "background_paused")).toBe(false);
});


test("a spent quota says what still works, what waits and when it comes back, not just 「已暂停」", () => {
  const store = setup();
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago" }));
  store.setSetting(ws, "background.blocker", JSON.stringify({ code: "BUDGET_EXHAUSTED", message: "模型额度已用 97%，后台自动工作暂停到额度恢复。",
    resetsAt: "2026-10-18T20:00:00.000Z", at: NOW.toISOString() }));
  const paused = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "background_paused")!;
  expect(paused.title).toBe("模型额度用完了：排程照常，AI 生成暂停");
  expect(paused.why).toContain("照常可用：排程与日历");
  expect(paused.why).toContain("暂停到恢复：新收集事项的分析与拆分");
  expect(paused.why).toContain("预计");
  // A spent quota stops the person's own turns too, and says so.
  expect(paused.why).toContain("暂停到恢复：新收集事项的分析与拆分；拆步骤与按回答重排；教程与调研；助手代办；输入框的对话回复与访谈");
  // An unreadable quota does not claim the input box is stopped.
  store.setSetting(ws, "background.blocker", JSON.stringify({ code: "COST_SIGNAL_UNAVAILABLE", message: "读不到模型额度，后台自动工作已暂停。", at: NOW.toISOString() }));
  const unread = collectAsks(TEST_CTX, NOW).find((ask) => ask.kind === "background_paused")!;
  expect(unread.title).toBe("后台自动工作已暂停");
  expect(unread.why).toContain("照常可用：");
  expect(unread.why).toContain("输入框对话与访谈。暂停到恢复");
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

test("a locked block is also asked about when the person's own event or another locked block takes its time", async () => {
  const store = setup();
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago", mode: "buffered" }));
  for (const id of ["hw3", "hw4"]) store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: id === "hw3" ? "作业 3" : "作业 4",
    state: "ready_for_human", riskTier: "routine", estimate, payload: {} });
  store.savePlanVersion({ id: "plan-1", ownerId: owner, workspaceId: ws, version: 1, status: "current", payload: { blocks: [] } });
  const slot = { start: "2026-10-08T16:00:00.000Z", end: "2026-10-08T17:00:00.000Z" };
  store.setSetting(ws, "schedule.frozen", JSON.stringify([{ blockId: "scheduled:hw3", reason: "locked", ...slot }]));
  store.setSetting(ws, "schedule.events", JSON.stringify([{ id: "dentist", title: "看牙", lineId: "", repeat: null, date: "2026-10-08", start: "11:30", end: "12:00",
    location: "", source: "input" }]));
  expect(collectAsks(TEST_CTX, NOW).find((item) => item.kind === "locked_conflict")?.title).toContain("看牙");
  store.setSetting(ws, "schedule.events", "[]");
  store.setSetting(ws, "schedule.frozen", JSON.stringify([{ blockId: "scheduled:hw3", reason: "locked", ...slot }, { blockId: "scheduled:hw4", reason: "pinned", ...slot }]));
  const asks = collectAsks(TEST_CTX, NOW).filter((item) => item.kind === "locked_conflict");
  expect(asks).toHaveLength(1);
  expect(asks[0]!.title).toContain("作业 4");
});

test("a refused capture is answered in the person's own words straight into the card, and carries its contract fields", async () => {
  const store = setup();
  store.capture({ id: "cap", ownerId: owner, workspaceId: ws, title: "整理组会意见", context: "组会上的三个质疑" }, "cap-1");
  store.transitionWorkOrder(ws, "cap", { type: "analysis.proposed", proposalId: "cap" }, "a1");
  store.transitionWorkOrder(ws, "cap", { type: "blocked", reason: "ANALYSIS_POLICY_BLOCKED" }, "a2",
    { audit: { blocker: { code: "ANALYSIS_POLICY_BLOCKED", message: "不清楚要交付什么" } } });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "capture_blocked")!;
  expect(ask).toMatchObject({ important: true, preview: { kind: "task" }, freeText: { placeholder: expect.stringMatching(/^例如/) } });
  // Two options on a single-choice ask are refused; the words alone are the context.
  expect(await answerAsk(TEST_CTX, ask.id, { optionIds: ["context", "discard"] }, {}, NOW)).toMatchObject({ ok: false, code: "ASK_SINGLE_CHOICE" });
  expect(await answerAsk(TEST_CTX, ask.id, { optionIds: [], note: "交付一页回应清单，周五组会前" }, {}, NOW)).toMatchObject({ ok: true });
  expect(store.listCaptures(ws)[0]!.context).toContain("交付一页回应清单");
  expect(store.listEvents(ws, { type: "ask.answered" }).at(-1)!.payload).toMatchObject({ askId: ask.id, note: "交付一页回应清单，周五组会前" });
});

test("a note beside an option fills the field that option asks for, and is kept on the answer where nothing reads it", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "跑一轮仿真",
    state: "blocked", riskTier: "milestone", estimate, payload: { gateReview: { verdict: "insufficient", gaps: [], criteriaVerdict: [] } } });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "gate_insufficient")!;
  expect(ask.preview).toMatchObject({ kind: "task", href: "/workbench/wo" });
  expect(await answerAsk(TEST_CTX, ask.id, { optionIds: ["drop"], note: "导师说这轮不用做了" }, {}, NOW)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "wo")!.state).toBe("archived");
});

test("a step question the task's own files answer is not asked; the same question from two tasks of one project is one card", () => {
  const store = setup();
  for (const id of ["hw3", "hw4"]) store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "", intent: id,
    state: "approved", riskTier: "routine", estimate, payload: {} });
  const plan = { archetypeId: "problem_set", quantity: { basis: "题目数", amount: 1, unit: "题" }, rationale: "", steps: [],
    questions: [{ id: "q1", text: "作业提交方式？", why: "", options: ["Canvas"] }, { id: "q2", text: "当前完成状态？", why: "", options: ["未开始", "一半"] }] };
  for (const id of ["hw3", "hw4"]) store.saveStepPlan(ws, id, plan as never, owner, "t");
  const cards = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "step_question");
  // Two questions of one project are one card, each a line of 「逐条改」.
  expect(cards().map((ask) => ask.id)).toEqual(["stepq:p:ece555"]);
  expect(cards()[0]!.options.find((option) => option.id === "edit")!.fields!.map((field) => field.label)).toEqual(["1. 作业提交方式？", "2. 当前完成状态？"]);
  store.saveSourceDocument({ id: "syl", ownerId: owner, workspaceId: ws, kind: "text", fileName: "syllabus.pdf", mediaType: "text/plain", sha256: "s", uri: "file://s",
    extractedText: "…", extractionStatus: "done", projectId: "ece555", createdAt: "2026-10-01T00:00:00Z" } as never);
  expect(cards().map((ask) => ask.title.split("：")[1])).toEqual(["当前完成状态？"]);
});

test("a project's questions are settled on one card: 都按建议 in one tap, or 逐条改 where an empty line keeps the suggestion", async () => {
  const store = setup();
  for (const id of ["a", "b"]) store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "startup", projectId: "mvp", milestoneId: "", intent: `任务 ${id}`,
    state: "approved", riskTier: "routine", estimate, payload: {} });
  const plan = (texts: string[]) => ({ archetypeId: "problem_set", quantity: { basis: "x", amount: 1, unit: "个" }, rationale: "", steps: [],
    questions: texts.map((text, index) => ({ id: `q${index}`, text, why: "", options: [`${text}-建议`, "其他"] })) });
  store.saveStepPlan(ws, "a", plan(["用户怎么联系？", "定价多少？"]) as never, owner, "t");
  store.saveStepPlan(ws, "b", plan(["首批几家店？"]) as never, owner, "t");
  const card = collectAsks(TEST_CTX, NOW).find((ask) => ask.id === "stepq:p:mvp")!;
  expect(card.title).toContain("有 3 个问题");
  expect(await answerAsk(TEST_CTX, card.id, { optionIds: ["edit"] }, { q1: "199 元/月" }, NOW)).toMatchObject({ ok: true });
  const facts = store.listProfileFacts(ws).filter((fact) => fact.slot.startsWith("step_answer_")).map((fact) => fact.value).sort();
  expect(facts).toEqual(["【定价多少？】199 元/月", "【用户怎么联系？】用户怎么联系？-建议", "【首批几家店？】首批几家店？-建议"]);
  // One replan per task, carrying all its answers.
  const replans = store.listEvents(ws, { type: "task.steps_replan_requested" });
  expect(replans.map((event) => event.entityId).sort()).toEqual(["a", "b"]);
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "step_question")).toBe(false);
});

test("待决事项 are in the question ledger: listed on the timer, answered with the chosen option, dropped when their cause goes", async () => {
  const store = setup();
  refusedWithMissing(store);
  const eventId = refusedOutright(store);
  writeAttentionSnapshot(TEST_CTX, 0, NOW);
  const key = `ask:bp:${eventId}:all`;
  expect(store.questionByKey(ws, key)).toMatchObject({ kind: "ask", status: "open" });
  const id = store.questionByKey(ws, key)!.id;
  // Asked again on the next tick: the same number.
  writeAttentionSnapshot(TEST_CTX, 0, NOW);
  expect(store.questionByKey(ws, key)!.id).toBe(id);
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.id === `bp:${eventId}:all`)!;
  await answerAsk(TEST_CTX, ask.id, "skip", {}, NOW);
  expect(store.questionByKey(ws, key)).toMatchObject({ status: "answered", answer: ask.options.find((option) => option.id === "skip")!.label });
  writeAttentionSnapshot(TEST_CTX, 0, NOW);
  expect(store.questionByKey(ws, key)!.status).toBe("answered");
});

/** The real path of 「完成 ECE 555 作业 2」: marked done before 完成 became the acceptance, then refused by the gate. */
function completedThenRefused(store: CrosslineStore) {
  store.saveWorkOrder({ id: "hw2", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "完成 ECE 555 作业 2",
    state: "approved", riskTier: "milestone", estimate, payload: {} });
  for (const [index, event] of ([{ type: "materials.not_required" }, { type: "human.started" }, { type: "human.completed" },
    { type: "blocked", reason: "MILESTONE_GATE_INSUFFICIENT" }] as const).entries())
    store.transitionWorkOrder(ws, "hw2", event as never, `hw2:${index}`, {});
  const order = store.listWorkOrders(ws).find((item) => item.id === "hw2")!;
  store.saveWorkOrder({ ...order, payload: { gateReview: { verdict: "insufficient", gaps: [{ code: "G1", whatWouldSatisfyIt: "提交作业文件副本" }], criteriaVerdict: [] } } });
}

test("a refusal of work the person marked done themselves offers to end it, and ending it accepts it with no evidence", async () => {
  const store = setup();
  completedThenRefused(store);
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "gate_insufficient")!;
  expect(ask.options.map((option) => option.id)).toEqual(["done", "redo", "look", "drop"]);
  expect(ask.options.find((option) => option.recommended)?.id).toBe("done");
  expect(await answerAsk(TEST_CTX, ask.id, "done", {}, NOW)).toMatchObject({ ok: true });
  expect(store.listWorkOrders(ws).find((order) => order.id === "hw2")!.state).toBe("accepted");
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "gate_insufficient")).toBe(false);
});

test("work the assistant delivered and the gate refused is not the person's completion: no 「已经交了」, and a blocked order takes no other acceptance", async () => {
  const store = setup();
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "mos2", intent: "跑一轮仿真",
    state: "approved", riskTier: "milestone", estimate, payload: {} });
  store.transitionWorkOrder(ws, "wo", { type: "agent.delivered" } as never, "wo:0", {});
  store.transitionWorkOrder(ws, "wo", { type: "blocked", reason: "MILESTONE_GATE_INSUFFICIENT" } as never, "wo:1", {});
  const order = store.listWorkOrders(ws).find((item) => item.id === "wo")!;
  store.saveWorkOrder({ ...order, payload: { gateReview: { verdict: "insufficient", gaps: [], criteriaVerdict: [] } } });
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "gate_insufficient")!;
  expect(ask.options.map((option) => option.id)).toEqual(["redo", "look", "drop"]);
  expect(() => store.transitionWorkOrder(ws, "wo", { type: "evidence.accepted" }, "wo:2", {})).toThrow("INVALID_WORK_ORDER_TRANSITION");
});

test("a course's or the person's own deadline that passed with work open is asked once: 补做 keeps it, 放弃 archives the milestone and its unstarted work, and both undo", async () => {
  const store = setup();
  const { undoOp, recentOps } = await import("./undo");
  for (const id of ["exam", "talk"]) {
    store.saveMilestone({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: id, title: id === "exam" ? "ECE 555 期中" : "组会报告", status: "approved", version: 1 });
    store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: id, stage: 1, deadline: "2026-10-05", baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
    store.saveWorkOrder({ id: `t-${id}`, ownerId: owner, workspaceId: ws, identityId: "research", projectId: id, milestoneId: id, intent: `t-${id}`,
      state: "approved", riskTier: "milestone", estimate, payload: {} });
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `milestone-overdue:${id}:2026-10-05`, type: "milestone.overdue", entityId: id,
      payload: { deadline: "2026-10-05", why: id === "exam" ? "course" : "person" } });
  }
  const overdue = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "milestone_overdue");
  expect(overdue().map((ask) => [ask.id, ask.title])).toEqual([["overdue:exam:2026-10-05", "「ECE 555 期中」的截止 10/5 已过，还有 1 个任务没完成"],
    ["overdue:talk:2026-10-05", "「组会报告」的截止 10/5 已过，还有 1 个任务没完成"]]);
  expect(overdue()[0]!.why).toContain("课程给定的日期");
  expect(await answerAsk(TEST_CTX, "overdue:exam:2026-10-05", "makeup", {}, NOW)).toMatchObject({ ok: true });
  expect(overdue().map((ask) => ask.entityId)).toEqual(["talk"]);
  expect(await answerAsk(TEST_CTX, "overdue:talk:2026-10-05", "drop", {}, NOW)).toMatchObject({ ok: true });
  expect(store.listMilestones(ws).find((item) => item.id === "talk")!.status).toBe("archived");
  expect(store.listWorkOrders(ws).find((item) => item.id === "t-talk")!.state).toBe("archived");
  expect(overdue()).toEqual([]);
  // Undone: the milestone and its work are back, and so is the question.
  const op = recentOps(TEST_CTX)[0]!;
  expect(undoOp(TEST_CTX, op.id)).toMatchObject({ ok: true });
  expect(store.listMilestones(ws).find((item) => item.id === "talk")!.status).toBe("approved");
  expect(store.listWorkOrders(ws).find((item) => item.id === "t-talk")!.state).toBe("approved");
  expect(overdue().map((ask) => ask.entityId)).toEqual(["talk"]);
  // A date moved elsewhere is no longer this question.
  store.setSetting(ws, "goal.settings:talk", JSON.stringify({ confirmedDeadline: "2026-10-20" }));
  expect(overdue()).toEqual([]);
});

test("an exam whose day passed asks how it went, even with its preparation put away; a score is the milestone's progress", async () => {
  const store = setup();
  store.saveMilestone({ id: "mid", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "ece548", title: "ECE 548 期中考试 1 达到 A− 支撑线", status: "approved", version: 1,
    successCriteria: [{ id: "score", statement: "期中分数不低于 85", evidenceOf: "outcome", required: true, measure: { kind: "threshold", comparator: "gte", value: 85, unit: "分" } }] });
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "mid", stage: 1, deadline: "2026-10-05", baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "milestone-overdue:sitting:mid:2026-10-05", type: "milestone.overdue", entityId: "mid",
    payload: { deadline: "2026-10-05", why: "sitting" } });
  const asks = () => collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "milestone_overdue");
  expect(asks().map((ask) => ask.title)).toEqual(["「ECE 548 期中考试 1 达到 A− 支撑线」10/5 已经考过了，结果怎样？"]);
  expect(asks()[0]!.options.map((option) => option.id)).toEqual(["taken", "pending", "extend", "drop"]);
  expect(await answerAsk(TEST_CTX, "overdue:mid:2026-10-05", "taken", { score: "88 分" }, NOW)).toMatchObject({ ok: true });
  expect(asks()).toEqual([]);
  const judged = store.listEvents(ws, { type: "milestone_gate.judged" }).map((event) => event.payload as { milestoneId: string; source: string; verdict: string });
  expect(judged).toEqual([expect.objectContaining({ milestoneId: "mid", source: "person_outcome" })]);
});

test("撤销 on the daily pass hands its assistant results back to the person", async () => {
  const store = setup();
  const { undoOp } = await import("./undo");
  const { listAgentTasks, reviewAgentTask, settleAgentResult } = await import("@crossline/db");
  for (const taskId of ["kept", "adopted"]) {
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req-${taskId}`, type: "agent.task.requested", entityId: taskId, payload: { title: `任务 · ${taskId}`, category: "read_research_organize", workOrderId: "" } });
    store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `done-${taskId}`, type: "agent.task.completed", entityId: taskId,
      payload: { directory: "", artifacts: [], needsHuman: 1, checksPassed: true, inputsModified: [], reviewRequired: true } });
  }
  settleAgentResult(store, ws, "kept", "expired", { day: "2026-10-07" });
  reviewAgentTask(store, ws, "adopted", "accepted", "", { by: "system" });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "op.applied:op-pass", type: "op.applied", entityId: "op-pass",
    payload: { bySystem: true, label: "到期整理", inverse: { kind: "agent.reopen", taskIds: ["kept", "adopted"] } } });
  expect(undoOp(TEST_CTX, "op-pass")).toMatchObject({ ok: true });
  expect(listAgentTasks(store, ws).map((row) => [row.taskId, row.status, row.settled ?? ""]).sort()).toEqual([["adopted", "needs_review", ""], ["kept", "needs_review", ""]]);
});
