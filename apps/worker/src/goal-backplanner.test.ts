import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { validateBackplan } from "@crossline/core";
import { createGoalBackplanner } from "./goal-backplanner";
import { fakeRuntime } from "./testing/fake-runtime";

const workspaceId = "personal-crossline";
const ownerId = "local-owner";
const step = (over: Record<string, unknown> = {}) => ({ id: "s1", intent: "整理实验方案", sourceQuote: "稳定推进实验",
  rationale: "先列可执行步骤", dependsOn: [],
  estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 75 },
  energy: "high", interruptible: false, family: "preparation", riskTier: "routine", evidence: "实验方案记录", acquires: "", ...over });

test("backplanner refuses invented quotes, unknown dependencies and implausible estimates", () => {
  expect(() => validateBackplan({ steps: [step({ sourceQuote: "虚构原话" })], dateCandidates: [], blockers: [] }, ["稳定推进实验"]))
    .toThrow("BACKPLAN_SOURCE_INVALID");
  expect(() => validateBackplan({ steps: [step({ dependsOn: ["missing"] })], dateCandidates: [], blockers: [] }, ["稳定推进实验"]))
    .toThrow("BACKPLAN_DEPENDENCY_INVALID");
  expect(() => validateBackplan({ steps: [step({ estimate: { p25Minutes: 90, p50Minutes: 45, p85Minutes: 75 } })],
    dateCandidates: [], blockers: [] }, ["稳定推进实验"])).toThrow("BACKPLAN_ESTIMATE_INVALID");
});

test("approved goal expands into sourced, bound drafts once and remains awaiting approval", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p",
    title: "稳定推进实验", status: "approved", version: 1 });
  // Deep work: not something that takes effect by itself, so it stays a proposal.
  const runtime = fakeRuntime([JSON.stringify({ steps: [step({ family: "deep_work" })], dateCandidates: [], blockers: [] })],
    "crossline:crossline-goal-backplanner");
  const backplan = createGoalBackplanner(store, workspaceId, "C:\\repo", () => runtime.rpc);
  const first = await backplan("m");
  expect(first.state).toBe("proposed");
  const draft = store.listWorkOrders(workspaceId)[0];
  expect(draft).toMatchObject({ identityId: "research", projectId: "p", milestoneId: "m",
    state: "awaiting_plan_approval", riskTier: "routine",
    payload: { backplan: { sourceQuote: "稳定推进实验" } } });
  expect(await backplan("m")).toEqual(first);
  expect(runtime.turns()).toBe(1);
  expect(store.listWorkOrders(workspaceId)).toHaveLength(1);
  expect(store.listEvents(workspaceId, { type: "goal.backplan_proposed" })).toHaveLength(1);
  store.close();
});

// A real account's milestones are owned by a principal UUID. The backplanner used to filter on the
// pre-accounts owner constant, so on every real account the button answered BACKPLAN_GOAL_NOT_APPROVED.
test("a real account's approved milestone (UUID owner) is backplanned, drafts owned by that principal and tagged with a family", async () => {
  const store = new CrosslineStore(":memory:");
  const { principal, workspace } = store.createPrincipalWithWorkspace("auth-user-1", "个人 workspace");
  const ctx = { principalId: principal.id, workspaceId: workspace.id };
  store.saveMilestone({ id: "m", ownerId: ctx.principalId, workspaceId: ctx.workspaceId, identityId: "research", projectId: "p",
    title: "稳定推进实验", status: "approved", version: 1 });
  const runtime = fakeRuntime([JSON.stringify({ steps: [step()], dateCandidates: [], blockers: [] })],
    "crossline:crossline-goal-backplanner");
  const result = await createGoalBackplanner(store, ctx.workspaceId, "C:\repo", () => runtime.rpc)("m");
  expect(result.state).toBe("proposed");
  const draft = store.listWorkOrders(ctx.workspaceId)[0]!;
  expect(draft.ownerId).toBe(ctx.principalId);
  expect((draft.payload as { family?: string }).family).toBe("preparation");
  store.close();
});

test("unapproved goal is blocked before any AI call", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p",
    title: "稳定推进实验", status: "draft", version: 1 });
  const backplan = createGoalBackplanner(store, workspaceId, "C:\\repo", () => undefined);
  expect(await backplan("m")).toMatchObject({ state: "blocked", code: "BACKPLAN_GOAL_NOT_APPROVED" });
  store.close();
});

test("only approved, unrevoked insight enters the next backplanning context", async () => {
  const store = new CrosslineStore(":memory:");
  const milestone = (version: number) => store.saveMilestone({ id: "m", ownerId, workspaceId,
    identityId: "research", projectId: "p", title: "稳定推进实验", status: "approved", version });
  milestone(1);
  const finding = store.appendEvent({ ownerId, workspaceId, idempotencyKey: "finding-1",
    type: "flywheel.finding", entityId: "m", payload: { milestoneId: "m",
      summary: "可复用的实验记录模板", sourceUrl: "https://example.org/source", staleWhen: "方法变更" } });
  const runtime = fakeRuntime([JSON.stringify({ steps: [step()], dateCandidates: [], blockers: [] })],
    "crossline:crossline-goal-backplanner");
  const backplan = createGoalBackplanner(store, workspaceId, "C:\\repo", () => runtime.rpc);
  await backplan("m");
  expect(runtime.prompts()[0]).not.toContain("可复用的实验记录模板");
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "insight-1",
    type: "insight.approved", entityId: finding.eventId, payload: {} });
  milestone(2);
  await backplan("m");
  expect(runtime.prompts()[1]).toContain("可复用的实验记录模板");
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "revoke-1",
    type: "insight.revoked", entityId: finding.eventId, payload: {} });
  milestone(3);
  await backplan("m");
  expect(runtime.prompts()[2]).not.toContain("可复用的实验记录模板");
  store.close();
});

test("milestones due within three weeks with nothing open are picked for backplanning, soonest first", async () => {
  const { milestonesAwaitingBackplan } = await import("./goal-backplanner");
  const store = new CrosslineStore(":memory:");
  const save = (id: string, status: "approved" | "draft" = "approved") => store.saveMilestone({ id, ownerId, workspaceId,
    identityId: "research", projectId: "p", title: id, status, version: 1 });
  const anchor = (milestoneId: string, deadline: string) => store.saveMilestoneAnchor({ workspaceId, milestoneId, stage: 1, deadline,
    baseline: "b", target: "t", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  save("soon"); anchor("soon", "2026-10-12");
  save("sooner"); anchor("sooner", "2026-10-09");
  save("far"); anchor("far", "2026-12-17");
  save("draft", "draft"); anchor("draft", "2026-10-10");
  save("served"); anchor("served", "2026-10-11");
  store.saveWorkOrder({ id: "wo", ownerId, workspaceId, identityId: "research", projectId: "p", milestoneId: "served", intent: "x",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 1, p50Minutes: 2, p85Minutes: 3, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  expect(milestonesAwaitingBackplan(store, workspaceId, new Date("2026-10-06T12:00:00Z"))).toEqual(["sooner", "soon"]);
  store.close();
});

const missingData = { code: "DATA_MISSING", message: "实测数据还没有到", what: "MoS₂ 实测数据", whoHas: "师兄" };

// The real refusal (「未提供实测 MoS₂ 参数数据…」) left the milestone with no work and told nobody. Now the missing input is
// recorded with who has it, and the milestone is split anyway with getting it as the first step.
test("a missing input is recorded with who has it, and the milestone is split anyway with obtaining it first", async () => {
  const { milestonesAwaitingBackplan } = await import("./goal-backplanner");
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p", title: "稳定推进实验", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "m", stage: 1, deadline: "2026-10-12", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  expect(milestonesAwaitingBackplan(store, workspaceId, new Date("2026-10-06T12:00:00Z"))).toEqual(["m"]);
  const runtime = fakeRuntime([
    JSON.stringify({ steps: [], dateCandidates: [], blockers: [missingData] }),
    JSON.stringify({ steps: [step({ id: "get", intent: "向师兄确认实测数据的位置和字段", sourceQuote: "实测数据还没有到", acquires: "m1", family: "deep_work" }),
      step({ id: "map", dependsOn: ["get"], family: "deep_work" })], dateCandidates: [], blockers: [] })
  ], "crossline:crossline-goal-backplanner");
  const result = await createGoalBackplanner(store, workspaceId, "C:\\repo", () => runtime.rpc, { rolling: true })("m");
  expect(result.state).toBe("proposed");
  expect(runtime.prompts()[1]).toContain("missingInputs");
  expect(runtime.prompts()[1]).toContain("MoS₂ 实测数据");
  const blocked = store.listEvents(workspaceId, { type: "goal.backplan_blocked" });
  expect(blocked).toHaveLength(1);
  expect((blocked[0]!.payload as { missing: unknown[] }).missing).toEqual([{ id: "m1", what: "MoS₂ 实测数据", whoHas: "师兄", message: "实测数据还没有到" }]);
  const drafts = store.listWorkOrders(workspaceId);
  expect(drafts.map((order) => (order.payload as { backplan: { acquires?: string } }).backplan.acquires).sort()).toEqual(["m1", undefined]);
  // Open work now serves it, so the timer leaves it alone.
  expect(milestonesAwaitingBackplan(store, workspaceId, new Date("2026-10-06T12:00:00Z"))).toEqual([]);
  store.close();
});

test("a step may only claim to acquire an input it was told is missing", () => {
  expect(() => validateBackplan({ steps: [step({ acquires: "m9" })], dateCandidates: [], blockers: [] }, ["稳定推进实验"], undefined, ["m1"]))
    .toThrow("BACKPLAN_ACQUIRES_INVALID");
  expect(() => validateBackplan({ steps: [step({ acquires: "m1" })], dateCandidates: [], blockers: [] }, ["稳定推进实验"]))
    .toThrow("BACKPLAN_ACQUIRES_INVALID");
  expect(() => validateBackplan({ steps: [], dateCandidates: [], blockers: [{ code: "X", message: "缺", what: "", whoHas: "" }] }, []))
    .toThrow("BACKPLAN_BLOCKER_INVALID");
});

test("a refusal with nothing to split is recorded and not retried on a timer; a runtime failure is not recorded", async () => {
  const { milestonesAwaitingBackplan } = await import("./goal-backplanner");
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p", title: "稳定推进实验", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "m", stage: 1, deadline: "2026-10-12", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  const now = new Date("2026-10-06T12:00:00Z");
  // No runtime at all: says nothing about the milestone, so nothing is recorded and the next tick tries again.
  expect(await createGoalBackplanner(store, workspaceId, "C:\\repo", () => undefined)("m")).toMatchObject({ state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE" });
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual(["m"]);
  const runtime = fakeRuntime([JSON.stringify({ steps: [], dateCandidates: [], blockers: [missingData] }),
    JSON.stringify({ steps: [], dateCandidates: [], blockers: [missingData] })], "crossline:crossline-goal-backplanner");
  const result = await createGoalBackplanner(store, workspaceId, "C:\\repo", () => runtime.rpc)("m");
  expect(result.state).toBe("blocked");
  expect(store.listEvents(workspaceId, { type: "goal.backplan_blocked" })).toHaveLength(1);
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual([]);
  // The person's answer asks for it again, past the closed timer.
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "rerun-1", type: "goal.backplan_rerun_requested", entityId: "m", payload: {} });
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual(["m"]);
  // Saying 「先不拆」 closes it for this version.
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "declined-1", type: "goal.backplan_declined", entityId: "m", payload: { milestoneVersion: 1 } });
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual([]);
  store.close();
});

test("an older refusal that carries only the joined message becomes one missing input per sentence", async () => {
  const { missingInputsOf } = await import("@crossline/core");
  expect(missingInputsOf({ code: "BACKPLAN_INPUT_BLOCKED", message: "未提供实测数据。；未提供 NeuroSim 输入规范。" }).map((item) => item.what))
    .toEqual(["未提供实测数据。", "未提供 NeuroSim 输入规范。"]);
});

// The first real automatic run turned one milestone into a ten-step chain at once (pending went from 11 to 20).
test("rolling mode keeps the next two steps, proposes the next round once they are done, and stops when a round is discarded", async () => {
  const { milestonesAwaitingBackplan } = await import("./goal-backplanner");
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p", title: "稳定推进实验", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "m", stage: 1, deadline: "2026-10-12", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  const chain = [step({ id: "s1", family: "deep_work" }), step({ id: "s2", dependsOn: ["s1"], family: "deep_work" }), step({ id: "s3", dependsOn: ["s2"], family: "deep_work" })];
  const runtime = fakeRuntime([JSON.stringify({ steps: chain, dateCandidates: [], blockers: [] })], "crossline:crossline-goal-backplanner");
  const backplan = createGoalBackplanner(store, workspaceId, "C:\repo", () => runtime.rpc, { rolling: true });
  const first = await backplan("m");
  expect(first.state).toBe("proposed");
  expect(store.listWorkOrders(workspaceId)).toHaveLength(2);
  const now = new Date("2026-10-06T12:00:00Z");
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual([]);
  // Both done: the next round may be proposed.
  for (const order of store.listWorkOrders(workspaceId)) store.saveWorkOrder({ ...order, state: "accepted" });
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual(["m"]);
  await backplan("m");
  expect(store.listWorkOrders(workspaceId)).toHaveLength(4);
  // The person discards the whole second round: no third round on a timer.
  for (const order of store.listWorkOrders(workspaceId).filter((item) => item.state !== "accepted")) store.saveWorkOrder({ ...order, state: "archived" });
  expect(milestonesAwaitingBackplan(store, workspaceId, now)).toEqual([]);
  store.close();
});

test("a refusal recorded before missing inputs were itemised gets one more automatic try", async () => {
  const { milestonesAwaitingBackplan } = await import("./goal-backplanner");
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p", title: "稳定推进实验", status: "approved", version: 1 });
  store.saveMilestoneAnchor({ workspaceId, milestoneId: "m", stage: 1, deadline: "2026-10-12", baseline: "", target: "", stakeholders: [],
    sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "legacy", type: "goal.backplan_blocked", entityId: "m",
    payload: { milestoneVersion: 1, code: "BACKPLAN_INPUT_BLOCKED", message: "未提供实测数据。" } });
  expect(milestonesAwaitingBackplan(store, workspaceId, new Date("2026-10-06T12:00:00Z"))).toEqual(["m"]);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "itemised", type: "goal.backplan_blocked", entityId: "m",
    payload: { milestoneVersion: 1, code: "BACKPLAN_INPUT_BLOCKED", message: "未提供实测数据。", missing: [] } });
  expect(milestonesAwaitingBackplan(store, workspaceId, new Date("2026-10-06T12:00:00Z"))).toEqual([]);
  store.close();
});

// A real step, 「从素材库选出四个首轮选题…」, came out high-risk because its evidence said 「首轮发布清单草稿」: only what the
// step *is* says whether it reaches outside the machine, not its reason or what it leaves behind.
test("a step is high-risk for what it does, not for a publishing word in its rationale or evidence", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "media", projectId: "p", title: "稳定推进实验", status: "approved", version: 1 });
  const runtime = fakeRuntime([JSON.stringify({ steps: [
    step({ id: "pick", intent: "从素材库选出四个首轮选题", rationale: "为首轮发布做准备", evidence: "首轮发布清单草稿" }),
    step({ id: "post", intent: "发布第一条视频", dependsOn: ["pick"], evidence: "视频链接" })], dateCandidates: [], blockers: [] })],
  "crossline:crossline-goal-backplanner");
  expect((await createGoalBackplanner(store, workspaceId, "C:\repo", () => runtime.rpc)("m")).state).toBe("proposed");
  const tiers = Object.fromEntries(store.listWorkOrders(workspaceId).map((order) => [order.intent, order.riskTier]));
  expect(tiers).toEqual({ "从素材库选出四个首轮选题": "routine", "发布第一条视频": "high_risk" });
  store.close();
});

// 「在等」 for something the person was already waiting for links that item instead of opening a `wait-bp-` copy, so the
// re-split has to find it through the link, under the name the milestone asked for it by.
test("an existing waiting item linked to a milestone's missing input is passed on as on its way", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId, workspaceId, identityId: "research", projectId: "p", title: "稳定推进实验", status: "approved", version: 1 });
  store.saveWaitingItem({ id: "wait-sim-0", ownerId, workspaceId, title: "西湖 MoS2 真实测量数据", who: "师兄", expectedAt: "2026-10-08",
    approximate: true, followUpAt: "2026-10-08", state: "open", blocks: [], source: "manual" });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "link", type: "goal.backplan_input_waiting", entityId: "m",
    payload: { waitingId: "wait-sim-0", askId: "bp:e:m1", what: "实测 MoS₂ 参数数据" } });
  const runtime = fakeRuntime([JSON.stringify({ steps: [step()], dateCandidates: [], blockers: [] })], "crossline:crossline-goal-backplanner");
  await createGoalBackplanner(store, workspaceId, "C:\repo", () => runtime.rpc)("m");
  expect(runtime.prompts()[0]).toContain('"waitingInputs":[{"what":"实测 MoS₂ 参数数据","who":"师兄","expectedAt":"2026-10-08"}]');
  store.close();
});
