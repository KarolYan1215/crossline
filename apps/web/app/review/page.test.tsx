import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));

// A real in-memory store rather than a hand-written double: the previous stub only implemented
// `listWorkOrders` and silently went stale the moment the page read anything else.
const WORKSPACE = "personal-crossline";
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const seed = () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const base = {
    ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m1", riskTier: "milestone" as const,
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const }
  };
  store.saveMilestone({ id: "m1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
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
    const html = renderToStaticMarkup(<ReviewPage />);
    expect(html).toContain("1 / 2");
    for (const fake of ["≥ 5 小时 / 周", "$100 / 月", "0 越权", "70%", "85%"]) expect(html).not.toContain(fake);
    expect(html).toContain("未标定");
  });

  test("lists every automatic acceptance individually, with a way to revoke it", async () => {
    const store = seed();
    store.appendEvent({ ownerId: "local-owner", workspaceId: WORKSPACE, idempotencyKey: "a1",
      type: "milestone_gate.auto_accepted", entityId: "w1", payload: { milestoneId: "m1", relationIds: [] } });
    const { default: ReviewPage } = await import("./page");
    const html = renderToStaticMarkup(<ReviewPage />);
    // Folding these into a count would make the automation unauditable, which is the whole reason
    // automatic acceptance was allowed at all.
    expect(html).toContain("整理三组实验异常");
    expect(html).toContain("撤销验收");
  });

  test("says plainly when a section has nothing, instead of inventing content", async () => {
    seed();
    const { default: ReviewPage } = await import("./page");
    const html = renderToStaticMarkup(<ReviewPage />);
    expect(html).toContain("本周没有自动验收记录");
    expect(html).toContain("本周没有扩展记录");
    expect(html).toContain("目前没有待回答的问题");
  });
});
