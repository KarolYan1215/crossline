import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("@crossline/codex", () => { throw new Error("Web must not spawn Codex"); });
import { TEST_CTX } from "../../../../../lib/test-support";
vi.mock("../../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
import * as route from "./route";
import { addCapturedTaskWithId } from "../../../../../lib/crossline";

afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined;
});
test("Web Analyze calls only the supervisor and preserves a manual Capture when unavailable", async () => {
  vi.stubEnv("CROSSLINE_SUPERVISOR_CAPABILITY_SECRET", "test-secret");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  addCapturedTaskWithId(TEST_CTX, { title: "Decide" }, "c", "c");
  const fetcher = vi.fn().mockRejectedValue(new Error("raw runtime secret"));
  vi.stubGlobal("fetch", fetcher);
  const response = await route.POST(new Request("http://localhost/api/captures/c/analyze", { method: "POST" }), { params: Promise.resolve({ id: "c" }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ blocker: { code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex supervisor is unavailable" } });
  // The capability's own boot id has to come from the supervisor first (`/v1/codex/status`, the one
  // route left uncapability-gated) — that call fails here before the analyze endpoint is ever reached,
  // which is the correct behaviour: no valid capability, no forwarded request.
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3211/v1/codex/status");
  expect(store.listCaptures(TEST_CTX.workspaceId)[0]?.state).toBe("captured");
  expect(store.listWorkOrders(TEST_CTX.workspaceId)).toEqual([]);
});
