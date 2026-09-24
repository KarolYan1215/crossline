import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

describe("connectors page", () => {
  // A generous timeout, not a flaky-test workaround: this is the first test in the suite whose module
  // graph pulls in `dexie` (via the new `DeviceLeases` card's import of `offline-queue.ts`), and a cold
  // transform of that dependency under full-suite load can run past the 5s default — isolated, this test
  // finishes in under 2s.
  test("does not claim measured connector health", async () => {
    globalThis.crosslineStore = new CrosslineStore(":memory:");
    const { default: ConnectorsPage } = await import("./page");
    const html = renderToStaticMarkup(await ConnectorsPage());
    expect(html).not.toContain("连接器健康");
    expect(html).not.toContain("待授权");
    expect(html).toContain("CONNECTOR_NOT_CONFIGURED");
    globalThis.crosslineStore.close();
    globalThis.crosslineStore = undefined;
  }, 20000);
});
