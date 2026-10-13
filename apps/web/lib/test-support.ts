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
