import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createPlanExplainer, PLAN_EXPLAINER_SKILL, buildPlanExplainerContext } from "./plan-explainer-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, PLAN_EXPLAINER_SKILL);
const WORKSPACE = "workspace-a";
let store: CrosslineStore;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 1, status: "approved" });
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "写论文结果段", state: "ready_for_human", riskTier: "milestone",
    estimate: { p25Minutes: 45, p50Minutes: 60, p85Minutes: 90, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { humanCore: [{ id: "h", intent: "写论文结果段", energy: "high", interruptible: true }] }
  });
});
afterEach(() => store.close());

test("buildPlanExplainerContext reads the real ledger, not a hardcoded workspace", () => {
  const context = buildPlanExplainerContext(store, WORKSPACE, "2026-09-27");
  expect(context.activeWorkOrders.map((order) => order.id)).toEqual(["w1"]);
  expect(context.approvedMilestones).toHaveLength(1);
});

test("a well-formed explanation is written back as a plan.explained event", async () => {
  const explanation = { summary: "只有一个可执行项", nextActionReason: "唯一就绪的作业", alternatives: [], blockers: [] };
  const { rpc } = fakeRuntime([JSON.stringify(explanation)]);
  const explain = createPlanExplainer(store, WORKSPACE, "C:\\repo", () => rpc);
  const outcome = await explain("2026-09-27");
  expect(outcome).toMatchObject({ state: "ready" });
  expect(store.listEvents(WORKSPACE, { type: "plan.explained" })).toHaveLength(1);
});

test("nothing to explain is a blocker, not an empty success", async () => {
  const empty = new CrosslineStore(":memory:");
  const explain = createPlanExplainer(empty, WORKSPACE, "C:\\repo", () => fakeRuntime(["{}"]).rpc);
  const outcome = await explain("2026-09-27");
  expect(outcome).toMatchObject({ state: "blocked", code: "PLAN_EXPLAINER_NOTHING_TO_EXPLAIN" });
  empty.close();
});
