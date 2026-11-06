import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore, SPONSOR_SETTING } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

let mailbox = "";
beforeEach(() => {
  // What makes invites work on a server (lib/invites.ts `invitesAvailable`).
  mailbox = mkdtempSync(path.join(tmpdir(), "connect-mail-"));
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  vi.stubEnv("CROSSLINE_AUTH_TEST_MAILBOX_DIR", mailbox);
  vi.stubEnv("CROSSLINE_INVITE_APPROVER", "owner@example.com");
  vi.stubEnv("CROSSLINE_SPONSOR_API_KEY", "sk-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; rmSync(mailbox, { recursive: true, force: true }); });

const render = async (searchParams: { next?: string } = {}) => {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) }));
};

// W-233: an account that redeemed an invite code stood before every way to connect until a client read caught up, and the person
// had to open the site again. It now never sees the page.
test("an account on the developer's model is sent on by the server, to the interview while it is not ready", async () => {
  globalThis.crosslineStore!.setSetting(TEST_CTX.workspaceId, SPONSOR_SETTING, JSON.stringify({ inviteId: "inv-1", since: "2026-11-05T00:00:00.000Z" }));
  await expect(render()).rejects.toMatchObject({ digest: expect.stringContaining("/onboarding") });
}, 30000);

test("an account with no model sees the page, starting on the waiting line instead of the choices", async () => {
  const html = await render();
  expect(html).toContain("正在检查这个账号的模型连接…");
  expect(html).toContain('class="connect-options" hidden=""');
}, 30000);

test("a code saved while the server cannot serve invites does not skip the page (the interview would only send the person back)", async () => {
  vi.stubEnv("CROSSLINE_SPONSOR_API_KEY", "");
  globalThis.crosslineStore!.setSetting(TEST_CTX.workspaceId, SPONSOR_SETTING, JSON.stringify({ inviteId: "inv-1", since: "2026-11-05T00:00:00.000Z" }));
  expect(await render()).toContain("开始之前：连接模型");
}, 30000);
