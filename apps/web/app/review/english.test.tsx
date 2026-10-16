import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "local-owner", workspaceId: "personal-crossline", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "local-owner" },
  authMethod: "session" as const, requestId: "test-request", locale: "en" as const };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("the weekly review's own words are English for an English request; what the ledger holds is shown as written", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "p", title: "三组实验归因",
    version: 1, status: "approved", successCriteria: [{ id: "c1", statement: "三组实验归因到同一机制", required: true, measure: { kind: "count", unit: "组", atLeast: 3 } }] });
  const { default: ReviewPage } = await import("./page");
  const html = renderToStaticMarkup(await ReviewPage());
  for (const text of ["Accepted automatically this week", "Nothing was accepted automatically this week.", "Milestone criteria", "[Count] 三组实验归因到同一机制",
    "not judged by the gate yet", "Open questions", "Accepted tasks 0 / "]) expect(html).toContain(text);
  expect(html).not.toContain("本周自动验收");
}, 20000);
