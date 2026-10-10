import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createCrosslineAuth, migrateCrosslineAuth, type CrosslineAuthOptions } from "./index";

let dir: string;
let options: CrosslineAuthOptions;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-auth-mail-"));
  // Port 1 refuses the connection at once: the same answer a provider's test mode gives every address but its owner (a 550).
  options = { authDbPath: path.join(dir, "auth.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210", trustedOrigins: ["http://127.0.0.1:3210"],
    smtp: { host: "127.0.0.1", port: 1, user: "u", password: "p", from: "Crossline <noreply@example.com>" } };
  await migrateCrosslineAuth(options);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a verification email that does not go out is a failed sign-up, not 「已发送验证邮件」", async () => {
  // Better Auth runs the sender through runInBackgroundOrAwait, which catches every error and only logs it; on the real deployment
  // every address but the owner's got a 550 and the page still said the email was sent.
  const auth = createCrosslineAuth(options);
  const attempt = auth.api.signUpEmail({ body: { email: "friend@example.com", password: "a-long-password", name: "Friend" } });
  await expect(attempt).rejects.toMatchObject({ body: { code: "VERIFICATION_EMAIL_FAILED" } });
  // Asking again sends again, and fails the same honest way.
  await expect(auth.api.sendVerificationEmail({ body: { email: "friend@example.com" } })).rejects.toMatchObject({ body: { code: "VERIFICATION_EMAIL_FAILED" } });
}, 30_000);

test("a code by email signs a person in without a password, creating the account on first use", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const mailbox = path.join(dir, "mailbox");
  const local: CrosslineAuthOptions = { authDbPath: path.join(dir, "otp.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
    trustedOrigins: ["http://127.0.0.1:3210"], testMailboxDir: mailbox };
  await migrateCrosslineAuth(local);
  const auth = createCrosslineAuth(local) as unknown as { api: Record<string, (input: unknown) => Promise<unknown>> };
  await auth.api.sendVerificationOTP!({ body: { email: "new@example.com", type: "sign-in" } });
  const message = JSON.parse(readFileSync(path.join(mailbox, readdirSync(mailbox)[0]!), "utf8")) as { to: string; url: string };
  expect(message.to).toBe("new@example.com");
  const otp = /\d{6}/.exec(message.url)?.[0];
  expect(otp).toBeTruthy();
  const signedIn = await auth.api.signInEmailOTP!({ body: { email: "new@example.com", otp } }) as { user?: { email?: string } };
  expect(signedIn.user?.email).toBe("new@example.com");
}, 30_000);
