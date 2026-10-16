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
// Better Auth keeps its SQLite handle with no way to close it, and Windows refuses to delete an open file: best effort, the OS temp dir is swept anyway.
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

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

test("sending the code again within its ten minutes sends the same code, with the code in the subject", async () => {
  // The hosted beta's mail arrived minutes late: a fresh code per click made the message in transit worthless, and identical subjects
  // collapsed into one thread where the older code was the one read.
  const { readdirSync, readFileSync } = await import("node:fs");
  const mailbox = path.join(dir, "mailbox-resend");
  const local: CrosslineAuthOptions = { authDbPath: path.join(dir, "resend.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
    trustedOrigins: ["http://127.0.0.1:3210"], testMailboxDir: mailbox };
  await migrateCrosslineAuth(local);
  const auth = createCrosslineAuth(local) as unknown as { api: Record<string, (input: unknown) => Promise<unknown>> };
  for (let i = 0; i < 3; i++) await auth.api.sendVerificationOTP!({ body: { email: "late@example.com", type: "sign-in" } });
  const messages = readdirSync(mailbox).map((file) => JSON.parse(readFileSync(path.join(mailbox, file), "utf8")) as { subject: string; url: string });
  const codes = messages.map((message) => /\d{6}/.exec(message.url)?.[0]);
  expect(messages).toHaveLength(3);
  expect(new Set(codes).size).toBe(1);
  expect(messages[0]!.subject).toBe(`Crossline 登录验证码 ${codes[0]}`);
  const signedIn = await auth.api.signInEmailOTP!({ body: { email: "late@example.com", otp: codes[0] } }) as { user?: { email?: string } };
  expect(signedIn.user?.email).toBe("late@example.com");
}, 30_000);

test("mail is written in the reader's language: the page's cookie for a new address, the account's choice once there is one", async () => {
  // auth has no direct dependency on the catalogues: the English the worker and web register, loaded for this test.
  await import("../../i18n/src/catalog-worker");
  const { readdirSync, readFileSync } = await import("node:fs");
  const mailbox = path.join(dir, "mailbox-lang");
  const chosen = new Map<string, "zh" | "en">();
  const local: CrosslineAuthOptions = { authDbPath: path.join(dir, "lang.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
    trustedOrigins: ["http://127.0.0.1:3210"], testMailboxDir: mailbox, accountLocale: (userId) => chosen.get(userId) };
  await migrateCrosslineAuth(local);
  const auth = createCrosslineAuth(local) as unknown as { api: Record<string, (input: unknown) => Promise<unknown>> };
  const read = () => readdirSync(mailbox).sort().map((file) => JSON.parse(readFileSync(path.join(mailbox, file), "utf8")) as { to: string; subject: string; url: string });
  // Nothing set: Chinese, as before.
  await auth.api.sendVerificationOTP!({ body: { email: "zh@example.com", type: "sign-in" } });
  expect(read().find((message) => message.to === "zh@example.com")!.subject).toMatch(/^Crossline 登录验证码 \d{6}$/);
  // A sign-up from an English page.
  await auth.api.sendVerificationOTP!({ body: { email: "en@example.com", type: "sign-in" }, headers: new Headers({ cookie: "crossline-locale=en" }) });
  const english = read().find((message) => message.to === "en@example.com")!;
  expect(english.subject).toMatch(/^Crossline sign-in code \d{6}$/);
  expect(english.url).toMatch(/^Your code: \d{6} \(valid for 10 minutes\)$/);
  // An account that chose English gets English with no cookie at all.
  const otp = /\d{6}/.exec(english.url)![0];
  const signedIn = await auth.api.signInEmailOTP!({ body: { email: "en@example.com", otp } }) as { user: { id: string } };
  chosen.set(signedIn.user.id, "en");
  rmSync(mailbox, { recursive: true, force: true });
  await auth.api.sendVerificationOTP!({ body: { email: "en@example.com", type: "sign-in" } });
  expect(read()[0]!.subject).toMatch(/^Crossline sign-in code \d{6}$/);
}, 30_000);
