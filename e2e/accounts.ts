import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { request } from "@playwright/test";

type CapturedMail = { to: string; subject: string; url: string };

/** Polls the mailbox directory for a message to `to` written after `since`, ignoring anything left by a prior run. */
async function waitForMail(dir: string, since: number, to: string, timeoutMs = 60_000): Promise<CapturedMail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const fresh = readdirSync(dir)
        .filter((name) => name.endsWith(".json") && Number(name.split("-")[0]) >= since)
        .sort()
        .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as CapturedMail)
        .filter((mail) => mail.to === to);
      const newest = fresh.at(-1);
      if (newest) return newest;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No verification email to ${to} appeared in ${dir} within ${timeoutMs}ms`);
}

/**
 * The real Better Auth sign-up → verify flow for one account, reading the verification link back out of the test mailbox
 * (`CROSSLINE_AUTH_TEST_MAILBOX_DIR`). Signing in is left to the caller: the session cookie is `Secure`, and only a real browser
 * sends it over plain `http://127.0.0.1`, so a test signs in from inside its page, while global-setup saves the state for every project.
 */
export async function signUpAccount(baseURL: string, email: string, password: string, name = "E2E Tester"): Promise<void> {
  const mailboxDir = process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR;
  if (!mailboxDir) throw new Error("CROSSLINE_AUTH_TEST_MAILBOX_DIR is not configured — check playwright.config.ts");
  const api = await request.newContext({ baseURL });
  try {
    const since = Date.now();
    const signUp = await api.post("/api/auth/sign-up/email", { data: { name, email, password, callbackURL: "/" } });
    if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`);
    const mail = await waitForMail(mailboxDir, since, email);
    const verify = await api.get(mail.url);
    if (!verify.ok()) throw new Error(`verify-email failed: ${verify.status()} ${await verify.text()}`);
  } finally {
    await api.dispose();
  }
}
