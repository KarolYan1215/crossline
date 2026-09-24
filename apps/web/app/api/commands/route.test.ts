import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
vi.mock("../../../lib/crossline", () => ({
  addCapturedTaskWithId: vi.fn()
}));

test("the offline boundary rejects the removed completion shortcut", async () => {
  const { POST } = await import("./route");
  const response = await POST(new Request("http://local/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ownerId: "local-owner", workspaceId: "personal-crossline", clientCommandId: "c1",
      clientSequence: 1, type: "task.complete", payload: { taskId: "missing" }, createdAt: "2026-09-15T00:00:00.000Z"
    })
  }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ code: "COMMAND_TYPE_NOT_ALLOWED" });
});
