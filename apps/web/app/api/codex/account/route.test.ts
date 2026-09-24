import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TEST_CTX } from "../../../../lib/test-support";

vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

const previousSupervisorUrl = process.env.CROSSLINE_CODEX_SUPERVISOR_URL;

afterEach(() => {
  if (previousSupervisorUrl === undefined) delete process.env.CROSSLINE_CODEX_SUPERVISOR_URL;
  else process.env.CROSSLINE_CODEX_SUPERVISOR_URL = previousSupervisorUrl;
  delete (globalThis as { crosslineCodexSidecar?: unknown }).crosslineCodexSidecar;
  vi.unstubAllEnvs();
});

describe("Codex account route", () => {
  test("returns a typed blocker when the durable supervisor is unavailable", async () => {
    // Exercising the "supervisor unreachable" path specifically, not the separate "capability secret
    // missing" short-circuit `requestCodexSupervisor` now checks first.
    vi.stubEnv("CROSSLINE_SUPERVISOR_CAPABILITY_SECRET", "test-secret");
    const unavailable = createServer();
    await new Promise<void>((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
    const address = unavailable.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    await new Promise<void>((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()));
    process.env.CROSSLINE_CODEX_SUPERVISOR_URL = `http://127.0.0.1:${address.port}`;
    const legacySidecar = Promise.reject<never>(new Error("legacy Next-owned sidecar must not be used"));
    void legacySidecar.catch(() => undefined);
    (globalThis as { crosslineCodexSidecar?: Promise<never> }).crosslineCodexSidecar = legacySidecar;

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/codex/account"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      account: null,
      requiresOpenaiAuth: true,
      blocker: {
        code: "CODEX_SUPERVISOR_UNAVAILABLE",
        message: "Codex supervisor is unavailable"
      }
    });
  });
});
