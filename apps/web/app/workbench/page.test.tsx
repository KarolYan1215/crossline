import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

describe("workbench page", () => {
  // Found by hand while testing the feature end to end in a real browser: this page — the one place a
  // person decides whether to start a work order right now — kept showing the raw analysis-time guess
  // even once real personal-history calibration existed for the exact same (identityId, family) bucket.
  // `dashboard-view.tsx`/`plannerTaskOf` already went through `resolvedEstimate`; this page never did.
  test("shows the calibrated estimate, not the raw analysis-time guess, once real history exists", async () => {
    const store = new CrosslineStore(":memory:");
    globalThis.crosslineStore = store;
    const prior = { p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 };
    for (let i = 0; i < 10; i += 1) {
      store.recordDurationObservation({
        ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, workOrderId: `history-${i}`,
        executionId: `exec-${i}`, identityId: "research", family: "deep_work",
        observedMinutes: 180, wallClockMinutes: 180, pauseMinutes: 0, interruptionDominant: false,
        baseline: prior, observedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        // The analysis kept estimating 70 minutes for work that took 180: the correction has something real to learn.
        llm: { p50Minutes: 70, p85Minutes: 105 }, actualSource: "timer", contextVersion: "crossline.analysis.v2"
      });
    }
    store.saveWorkOrder({
      id: "wo-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
      projectId: "p", milestoneId: "", intent: "写一段分析", state: "ready_for_human", riskTier: "routine",
      estimate: { ...prior, source: "llm_prior", observationCount: 0, confidence: "low" },
      payload: { materialContract: [], evidenceContract: [{ kind: "record", description: "结论记录", required: true }], family: "deep_work" }
    });

    const { default: WorkbenchPage } = await import("./page");
    const html = renderToStaticMarkup(await WorkbenchPage({ searchParams: Promise.resolve({}) }));
    // The raw prior's p50/p85 (70/105) must not appear as this order's displayed window — it should
    // have moved toward the real 180-minute history instead.
    expect(html).toContain("ui-duration");
    expect(html).not.toContain(">1 时 10 分<");

    store.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
