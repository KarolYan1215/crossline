import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createGoalBackplanner, validateBackplan } from "./goal-backplanner";
import { fakeRuntime } from "./testing/fake-runtime";

const workspaceId = "personal-crossline";
const ownerId = "local-owner";
const step = (over: Record<string, unknown> = {}) => ({ id: "s1", intent: "整理实验方案", sourceQuote: "稳定推进实验",
  rationale: "先列可执行步骤", dependsOn: [],
  estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 75 },
  energy: "high", interruptible: false, riskTier: "routine", evidence: "实验方案记录", ...over });

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
  const runtime = fakeRuntime([JSON.stringify({ steps: [step()], dateCandidates: [], blockers: [] })],
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
