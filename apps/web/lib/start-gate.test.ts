import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));

const { gateUntilReady, startReadiness } = await import("./start-gate");
const { seedReadyToStart, TEST_CTX } = await import("./test-support");

afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

function seedOneWorkOrder(store: CrosslineStore, workspaceId: string): void {
  store.saveWorkOrder({ id: "wo-1", ownerId: TEST_CTX.principalId, workspaceId, identityId: "research", projectId: "research-default", milestoneId: "research-unassigned",
    intent: "整理文献", state: "ready_for_human", riskTier: "routine", estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45, source: "manual", observationCount: 0, confidence: "low" },
    payload: { materialContract: [], evidenceContract: [] } });
}

test("未达可开始标准的账号被带回访谈，已有工作也不豁免", async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  seedOneWorkOrder(store, TEST_CTX.workspaceId);
  expect(() => gateUntilReady(TEST_CTX)).toThrow(expect.objectContaining({ digest: expect.stringContaining("/onboarding") }));
  expect(startReadiness(TEST_CTX).missing.map((item) => item.id)).toContain("availability");
  seedReadyToStart(store, TEST_CTX.workspaceId);
  expect(() => gateUntilReady(TEST_CTX)).not.toThrow();
  expect(startReadiness(TEST_CTX)).toMatchObject({ ready: true, missing: [] });
});

test("达到开始标准后还要本人核对一次才放行；核对页列出主线、项目截止和每周时段；在用的账号不需要", async () => {
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { START_CONFIRMED_SETTING } = await import("@crossline/core");
  const { confirmStart, startSummary } = await import("./start-confirm");
  seedReadyToStart(store, TEST_CTX.workspaceId);
  store.deleteSetting(TEST_CTX.workspaceId, START_CONFIRMED_SETTING);
  expect(startReadiness(TEST_CTX)).toMatchObject({ standard: true, confirmed: false, ready: false });
  expect(() => gateUntilReady(TEST_CTX)).toThrow(expect.objectContaining({ digest: expect.stringContaining("/onboarding") }));
  const summary = startSummary(TEST_CTX);
  expect(summary.lines.find((line) => line.id === "research")).toMatchObject({ goal: expect.stringContaining("研究"), projects: [{ deadline: "没有截止" }] });
  expect(summary.hours.weekly).toBeGreaterThan(0);
  expect(summary.hours.windows[0]).toMatch(/^周.+ \d\d:\d\d–\d\d:\d\d（精力.）$/);
  // While the extraction still owes the conversation a reply, the summary would be stale: not confirmed yet.
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s", workspaceId: TEST_CTX.workspaceId, role: "user", content: { text: "论文 12 月中投稿" }, createdAt: now });
  expect(confirmStart(TEST_CTX)).toEqual({ ok: false, code: "START_STILL_ORGANIZING" });
  store.setSetting(TEST_CTX.workspaceId, "onboarding.extract:s", JSON.stringify({ upTo: 1, failures: 0 }));
  expect(confirmStart(TEST_CTX)).toEqual({ ok: true });
  expect(() => gateUntilReady(TEST_CTX)).not.toThrow();
  // An account with work on its board when the confirmation came in is not asked for it.
  store.deleteSetting(TEST_CTX.workspaceId, START_CONFIRMED_SETTING);
  seedOneWorkOrder(store, TEST_CTX.workspaceId);
  expect(startReadiness(TEST_CTX).ready).toBe(true);
});
