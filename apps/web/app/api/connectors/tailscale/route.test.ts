import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "p1", workspaceId: "w1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "p1" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

const saveTailscaleBinding = vi.fn();
const listTailscaleBindings = vi.fn((..._args: unknown[]) => [] as unknown[]);
const revokeTailscaleBinding = vi.fn();
vi.mock("../../../../lib/crossline", () => ({
  getStore: () => ({
    saveTailscaleBinding: (...args: unknown[]) => saveTailscaleBinding(...args),
    listTailscaleBindings: (...args: unknown[]) => listTailscaleBindings(...args),
    revokeTailscaleBinding: (...args: unknown[]) => revokeTailscaleBinding(...args)
  })
}));

test("GET reports no current identity when the request carries no Tailscale headers (plain loopback access)", async () => {
  const { GET } = await import("./route");
  const response = await GET(new Request("http://local/api/connectors/tailscale"));
  const body = await response.json() as { current: unknown };
  expect(body.current).toBeNull();
});

test("GET reports the current identity when tailscale serve headers are present", async () => {
  const { GET } = await import("./route");
  const response = await GET(new Request("http://local/api/connectors/tailscale", {
    headers: { "tailscale-user-login": "karolyan1215@gmail.com", "tailscale-user-name": "Karol" }
  }));
  const body = await response.json() as { current: { login: string; name: string } };
  expect(body.current).toEqual({ login: "karolyan1215@gmail.com", name: "Karol" });
});

test("POST refuses to bind when no Tailscale identity header is present", async () => {
  const { POST } = await import("./route");
  const response = await POST(new Request("http://local/api/connectors/tailscale", { method: "POST" }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ code: "TAILSCALE_IDENTITY_NOT_PRESENT" });
  expect(saveTailscaleBinding).not.toHaveBeenCalled();
});

test("POST binds the caller's own principal to the login the request actually carried", async () => {
  saveTailscaleBinding.mockImplementationOnce((binding) => binding);
  const { POST } = await import("./route");
  const response = await POST(new Request("http://local/api/connectors/tailscale", {
    method: "POST", headers: { "tailscale-user-login": "karolyan1215@gmail.com" }
  }));
  expect(response.status).toBe(200);
  expect(saveTailscaleBinding).toHaveBeenCalledWith(expect.objectContaining({
    principalId: "p1", workspaceId: "w1", tailscaleLogin: "karolyan1215@gmail.com"
  }));
});

test("POST is refused for a forged cross-site Origin before touching the store", async () => {
  const { POST } = await import("./route");
  const response = await POST(new Request("http://local/api/connectors/tailscale", {
    method: "POST", headers: { origin: "https://evil.example", "tailscale-user-login": "karolyan1215@gmail.com" }
  }));
  expect(response.status).toBe(403);
  expect(saveTailscaleBinding).not.toHaveBeenCalled();
});

test("DELETE requires a tailscaleLogin in the body", async () => {
  const { DELETE } = await import("./route");
  const response = await DELETE(new Request("http://local/api/connectors/tailscale", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({})
  }));
  expect(response.status).toBe(400);
  expect(revokeTailscaleBinding).not.toHaveBeenCalled();
});
