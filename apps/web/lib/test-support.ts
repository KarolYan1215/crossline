import type { AccessContext } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { seedExampleReadiness } from "./example-readiness";

/** A stable AccessContext fixture for tests that call lib/crossline.ts or lib/permission-mode.ts
 * directly against an in-memory store, standing in for the real session a route would resolve. */
export const TEST_CTX: AccessContext = {
  principalId: "test-owner",
  workspaceId: "test-workspace",
  role: "owner",
  identity: { provider: "credential", issuer: "test", subject: "test-owner" },
  authMethod: "session",
  requestId: "test-request"
};

/**
 * A workspace that meets the start standard (`readyToStart`): the example lines with descriptions and adopted goals, the weekly hours
 * and one project per line with no deadline — the same inputs the example board is seeded with.
 */
export function seedReadyToStart(store: CrosslineStore, workspaceId: string): void {
  seedExampleReadiness(store, { ...TEST_CTX, workspaceId });
}

/**
 * The plan once the background optimal solve has run (docs/loop-and-scout.md §2): a first read shows the greedy plan and asks for the
 * optimal one, which is solved here with HiGHS in this process, and the read after it gets the cached result. For tests of what only
 * the solver does — line-share library work, the current slot ordered by the self-reported energy.
 */
export async function settledPlan(ctx: AccessContext) {
  const { createRequire } = await import("node:module");
  const { loadCurrentPlan } = await import("./crossline");
  const { configureOptimal, optimalIdle } = await import("./optimal-schedule");
  const highs = await (createRequire(import.meta.url)("highs") as typeof import("highs").default)();
  configureOptimal({ enabled: true, solver: async (model, limit) => highs.solve(model, { output_flag: false, time_limit: limit }) });
  try {
    await loadCurrentPlan(ctx);
    await optimalIdle();
    return await loadCurrentPlan(ctx);
  } finally {
    configureOptimal({ enabled: false });
  }
}
