import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore, sponsorshipOf } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { applyInvite, decideFromLink, inviteForLink, inviteState, invitesAvailable, redeemCode, signDecisionToken, verifyDecisionToken } from "./invites";
import { TEST_CTX } from "./test-support";

let mailbox = "";
beforeEach(() => {
  mailbox = mkdtempSync(path.join(tmpdir(), "invite-mail-"));
  vi.stubEnv("CROSSLINE_AUTH_TEST_MAILBOX_DIR", mailbox);
  vi.stubEnv("CROSSLINE_INVITE_APPROVER", "owner@example.com");
  vi.stubEnv("CROSSLINE_SPONSOR_API_KEY", "sk-test");
  vi.stubEnv("CROSSLINE_SPONSOR_MODELS", "deepseek-ai/DeepSeek-V4.1=4:16:1024");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
  vi.stubEnv("CROSSLINE_WEB_BASE_URL", "https://app.example.com");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); rmSync(mailbox, { recursive: true, force: true }); });

const mails = () => readdirSync(mailbox).sort().map((file) => JSON.parse(readFileSync(path.join(mailbox, file), "utf8")) as { to: string; subject: string; text: string; url: string });

test("a decision link is signed, expires, and cannot be altered", () => {
  const token = signDecisionToken("inv-1", 0);
  expect(verifyDecisionToken(token, 1000)).toBe("inv-1");
  expect(verifyDecisionToken(token, 15 * 86_400_000)).toBeUndefined();
  const [body, signature] = token.split(".");
  expect(verifyDecisionToken(`${Buffer.from("inv-2.99999999999999").toString("base64url")}.${signature}`, 1000)).toBeUndefined();
  expect(verifyDecisionToken(`${body}.x`, 1000)).toBeUndefined();
});

test("apply mails the owner a link; approving from it mails the applicant a code; the code puts the account on the developer's model", async () => {
  expect(invitesAvailable()).toBe(true);
  expect(await applyInvite(TEST_CTX, "tester@example.com", "免费账号额度不够", { plan: "free" })).toEqual({ ok: true, status: "pending" });
  // Applying again sends nothing new.
  await applyInvite(TEST_CTX, "tester@example.com", "again");
  const [request] = mails();
  expect(mails()).toHaveLength(1);
  expect(request).toMatchObject({ to: "owner@example.com", subject: "Crossline 模型额度申请：tester@example.com" });
  expect(request!.text).toContain("ChatGPT 账号类型：free");
  const token = new URL(request!.url).searchParams.get("t")!;
  expect(inviteForLink(token)).toMatchObject({ email: "tester@example.com", status: "pending" });
  expect(inviteState(TEST_CTX)).toMatchObject({ available: true, sponsored: false, application: { status: "pending" } });

  expect(await decideFromLink(token, "approve")).toMatchObject({ ok: true, status: "approved", mailed: true });
  expect(await decideFromLink(token, "reject")).toEqual({ ok: false, code: "INVITE_ALREADY_DECIDED" });
  const codeMail = mails().find((mail) => mail.to === "tester@example.com")!;
  const code = /CL-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(codeMail.text)![0];
  expect(redeemCode(TEST_CTX, code)).toMatchObject({ ok: true });
  expect(sponsorshipOf(globalThis.crosslineStore!, TEST_CTX.workspaceId)).toBeTruthy();
  expect(inviteState(TEST_CTX)).toMatchObject({ sponsored: true, budget: { spent: 0, cap: 30 } });
  expect(await applyInvite(TEST_CTX, "tester@example.com", "")).toEqual({ ok: false, code: "INVITE_ALREADY_REDEEMED" });
});

test("without an approver or the developer's model there is nothing to apply for", async () => {
  vi.stubEnv("CROSSLINE_SPONSOR_API_KEY", "");
  expect(invitesAvailable()).toBe(false);
  expect(await applyInvite(TEST_CTX, "tester@example.com", "")).toEqual({ ok: false, code: "INVITES_UNAVAILABLE" });
  expect(mails()).toEqual([]);
});
