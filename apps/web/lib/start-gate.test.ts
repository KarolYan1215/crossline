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
