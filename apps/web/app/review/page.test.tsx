import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

// A real in-memory store rather than a hand-written double: the previous stub only implemented
// `listWorkOrders` and silently went stale the moment the page read anything else.
const WORKSPACE = TEST_CTX.workspaceId;
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const seed = () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const base = {
    ownerId: TEST_CTX.principalId, workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m1", riskTier: "milestone" as const,
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const }
  };
  store.saveMilestone({ id: "m1", ownerId: TEST_CTX.principalId, workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "稳定推进实验", version: 1, status: "approved",
    successCriteria: [{ id: "c1", statement: "三组实验归因到同一机制", required: true, measure: { kind: "count", unit: "组", atLeast: 3 } }] });
  store.saveWorkOrder({ ...base, id: "w1", intent: "整理三组实验异常", state: "accepted",
    payload: { autoAcceptance: { acceptedAt: "2026-09-20T03:00:00.000Z", relationIds: [] } } });
  store.saveWorkOrder({ ...base, id: "w2", intent: "另一件事", state: "ready_for_human", payload: {} });
  return store;
};

describe("review page", () => {
  test("shows the real completion count and no simulated KPI targets", async () => {
    seed();
    const { default: ReviewPage } = await import("./page");
    const html = renderToStaticMarkup(await ReviewPage());
    expect(html).toContain("1 / 2");
    for (const fake of ["≥ 5 小时 / 周", "$100 / 月", "0 越权", "70%", "85%"]) expect(html).not.toContain(fake);
    expect(html).toContain("未标定");
  }, 20000);

  test("lists every automatic acceptance individually, with a way to revoke it", async () => {
    const store = seed();
    store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: WORKSPACE, idempotencyKey: "a1",
      type: "milestone_gate.auto_accepted", entityId: "w1", payload: { milestoneId: "m1", relationIds: [] } });
    const { default: ReviewPage } = await import("./page");
    const html = renderToStaticMarkup(await ReviewPage());
    // Folding these into a count would make the automation unauditable, which is the whole reason
    // automatic acceptance was allowed at all.
    expect(html).toContain("整理三组实验异常");
    expect(html).toContain("撤销验收");
  });

  test("lists how tiring each finished task was by the person's own word, beside the energy it was planned to need", async () => {
    const store = seed();
    store.saveWorkOrder({ ...store.listWorkOrders(WORKSPACE).find((order) => order.id === "w2")!, payload: { humanCore: [{ energy: "low" }] } });
    const observed = (key: string, workOrderId: string, actualLoad: string) => store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: WORKSPACE,
      idempotencyKey: key, type: "energy.observed", entityId: key, payload: { source: "self_report", level: "low", confidence: "high", context: "after_task", workOrderId, actualLoad } });
    observed("e1", "w2", "medium");
    observed("e2", "w2", "high");
    const { default: ReviewPage } = await import("./page");
    const html = renderToStaticMarkup(await ReviewPage());
    expect(html).toContain("本周做完后的累不累");
    expect(html).toContain("本人说：高 · 原估精力需求：低");
    expect(html).toContain("比预想累");
    expect(html).not.toContain("本人说：中");
  });

  test("says plainly when a section has nothing, instead of inventing content", async () => {
    seed();
    const { default: ReviewPage } = await import("./page");
    const html = renderToStaticMarkup(await ReviewPage());
    expect(html).toContain("本周没有自动验收记录");
    expect(html).toContain("本周无扩展记录");
    expect(html).toContain("暂无待判断的问题");
    expect(html).not.toContain("本周做完后的累不累");
  });
});
