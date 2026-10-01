import { afterEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "../../../../lib/test-support";
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
const requestCodexSupervisor = vi.fn();
vi.mock("../../../../lib/codex-runtime", () => ({
  requestCodexSupervisor: (...args: unknown[]) => requestCodexSupervisor(...args),
  CodexSupervisorRequestError: class CodexSupervisorRequestError extends Error {
    constructor(readonly status: number, readonly blocker: { code: string; message: string }) { super(blocker.message); }
  }
}));
import * as route from "./route";

afterEach(() => { vi.clearAllMocks(); });

test("refuses a forged Origin before resolving access or calling the supervisor", async () => {
  const response = await route.POST(new Request("http://localhost/api/assistant/turn", {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }
  }));
  expect(response.status).toBe(403);
  expect(requestCodexSupervisor).not.toHaveBeenCalled();
});

test("rejects a turn with no threadId or an empty message before calling the supervisor", async () => {
  const response = await route.POST(new Request("http://localhost/api/assistant/turn", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "", message: "  " })
  }));
  expect(response.status).toBe(400);
  expect(requestCodexSupervisor).not.toHaveBeenCalled();
});

test("forwards a valid turn to the worker supervisor and returns its reply verbatim", async () => {
  requestCodexSupervisor.mockResolvedValueOnce({ state: "replied", reply: "你好", quickReplies: ["继续"] });
  const response = await route.POST(new Request("http://localhost/api/assistant/turn", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "t1", message: "帮我写个脚本", history: [], attachments: [], workOrderId: null })
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "replied", reply: "你好", quickReplies: ["继续"] });
  expect(requestCodexSupervisor).toHaveBeenCalledWith(TEST_CTX, "/v1/assistant/turn", expect.objectContaining({
    method: "POST", body: JSON.stringify({ threadId: "t1", message: "帮我写个脚本", history: [], attachments: [], workOrderId: null })
  }));
});

test("surfaces a supervisor blocker with its own status rather than a generic failure", async () => {
  const { CodexSupervisorRequestError } = await import("../../../../lib/codex-runtime");
  requestCodexSupervisor.mockRejectedValueOnce(new CodexSupervisorRequestError(503, { code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "不可用" }));
  const response = await route.POST(new Request("http://localhost/api/assistant/turn", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "t1", message: "你好" })
  }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, blocker: { code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "不可用" } });
});
