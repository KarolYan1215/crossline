import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { POST } from "./route";

let mailbox = "";
beforeEach(() => {
  mailbox = mkdtempSync(path.join(tmpdir(), "invite-request-"));
  vi.stubEnv("CROSSLINE_AUTH_TEST_MAILBOX_DIR", mailbox);
  vi.stubEnv("CROSSLINE_INVITE_APPROVER", "owner@example.com");
  vi.stubEnv("CROSSLINE_SPONSOR_API_KEY", "sk-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
  vi.stubEnv("ASSESS_LINK_SECRET", "link-secret");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); rmSync(mailbox, { recursive: true, force: true }); });

const mails = () => readdirSync(mailbox).map((file) => JSON.parse(readFileSync(path.join(mailbox, file), "utf8")) as { to: string; text: string });
const ask = (body: unknown, headers: Record<string, string> = {}) => POST(new Request("http://app.test/api/invites/request", {
  method: "POST", headers: { "content-type": "application/json", host: "app.test", ...headers }, body: JSON.stringify(body) }));

test("a visitor applies with an email; the owner is mailed; a bad address, a filled trap and another site are not", async () => {
  expect((await ask({ email: "not-an-email" }, { "x-forwarded-for": "203.0.113.1" })).status).toBe(400);
  expect((await ask({ email: "a@example.com" }, { origin: "https://evil.example", "x-forwarded-for": "203.0.113.1" })).status).toBe(403);
  // The trap answers like a success and sends nothing.
  expect(await (await ask({ email: "bot@example.com", website: "x" }, { "x-forwarded-for": "203.0.113.1" })).json()).toEqual({ ok: true });
  expect(mails()).toEqual([]);
  const answer = await ask({ email: "visitor@example.com", reason: "想试试" }, { origin: "http://app.test", "x-forwarded-for": "203.0.113.1" });
  expect(await answer.json()).toEqual({ ok: true });
  expect(mails()).toMatchObject([{ to: "owner@example.com" }]);
  expect(mails()[0]!.text).toContain("来源：登录页（还没有账号）");
});

test("one address is held to ten an hour; the public test, with the shared secret, is not, and may say where it came from", async () => {
  for (let index = 0; index < 10; index += 1) expect((await ask({ email: `v${index}@example.com` }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(200);
  expect((await ask({ email: "v10@example.com" }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
  const assess = { "x-forwarded-for": "203.0.113.9", authorization: "Bearer link-secret" };
  expect((await ask({ email: "from-test@example.com", source: "assess", detail: "速测类型 BP" }, assess)).status).toBe(200);
  expect(mails().find((mail) => mail.text.includes("from-test@example.com"))!.text).toContain("来源：公开测评（还没有账号） · 速测类型 BP");
  // A wrong secret is an ordinary visitor: limited, and its source is not believed.
  expect((await ask({ email: "x@example.com", source: "assess" }, { ...assess, authorization: "Bearer wrong" })).status).toBe(429);
});

test("without invites on this server the route says so", async () => {
  vi.stubEnv("CROSSLINE_INVITE_APPROVER", "");
  expect((await ask({ email: "a@example.com" }, { "x-forwarded-for": "203.0.113.2" })).status).toBe(404);
});
