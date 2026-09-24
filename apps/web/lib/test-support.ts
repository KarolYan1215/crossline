import type { AccessContext } from "@crossline/core";

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
