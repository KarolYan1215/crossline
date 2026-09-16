import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const previousSupervisorUrl = process.env.CROSSLINE_CODEX_SUPERVISOR_URL;

afterEach(() => {
  if (previousSupervisorUrl === undefined) delete process.env.CROSSLINE_CODEX_SUPERVISOR_URL;
  else process.env.CROSSLINE_CODEX_SUPERVISOR_URL = previousSupervisorUrl;
  delete (globalThis as { crosslineCodexSidecar?: unknown }).crosslineCodexSidecar;
});

describe("Codex account route", () => {
  test("returns a typed blocker when the durable supervisor is unavailable", async () => {
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
    const response = await GET();

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
