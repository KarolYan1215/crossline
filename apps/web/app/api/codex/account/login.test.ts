import { afterEach, expect, test, vi } from "vitest";
import { TEST_CTX } from "../../../../lib/test-support";

const requestCodexSupervisor = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
vi.mock("../../../../lib/codex-runtime", () => ({ requestCodexSupervisor: (...args: unknown[]) => requestCodexSupervisor(...args),
  CodexSupervisorRequestError: class extends Error { status = 503; blocker = { code: "X", message: "x" }; } }));
const { POST } = await import("./route");
afterEach(() => requestCodexSupervisor.mockReset());

const post = (body: unknown) => POST(new Request("http://127.0.0.1:3210/api/codex/account", { method: "POST",
  headers: { "content-type": "application/json", origin: "http://127.0.0.1:3210", host: "127.0.0.1:3210" }, body: JSON.stringify(body) }));

test("an API key goes to the account's own runtime and nowhere else: not echoed, not kept", async () => {
  requestCodexSupervisor.mockResolvedValueOnce({ loginId: "apiKey-1", type: "apiKey", state: "completed" });
  const response = await post({ type: "apiKey", apiKey: "sk-test-SECRET-abcd" });
  expect(JSON.stringify(await response.json())).not.toContain("SECRET");
  const [, pathname, init] = requestCodexSupervisor.mock.calls[0]!;
  expect(pathname).toBe("/v1/codex/login");
  expect(JSON.parse(init.body)).toEqual({ type: "apiKey", apiKey: "sk-test-SECRET-abcd" });
  expect(globalThis.crosslineStore).toBeUndefined();
});

test("a device code, a sign-out, and an empty key are each what they say", async () => {
  requestCodexSupervisor.mockResolvedValue({ ok: true });
  await post({ type: "chatgptDeviceCode" });
  expect(JSON.parse(requestCodexSupervisor.mock.calls[0]![2].body)).toEqual({ type: "chatgptDeviceCode" });
  await post({ action: "logout" });
  expect(requestCodexSupervisor.mock.calls[1]![1]).toBe("/v1/codex/logout");
  expect((await post({ type: "apiKey", apiKey: " " })).status).toBe(400);
});
