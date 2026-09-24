import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";

/**
 * Drives the real Better Auth sign-up → verify → sign-in flow once per e2e run, so every test starts
 * with an authenticated session instead of hitting `/login`. `apps/web` refuses email/password sign-up
 * entirely unless it can actually deliver a verification link (see `CrosslineAuthOptions.testMailboxDir`
 * in `packages/auth`); the server here is started with `CROSSLINE_AUTH_TEST_MAILBOX_DIR` set, so that
 * link lands as a JSON file on disk instead of a real mailbox.
 */
const TEST_EMAIL = "e2e-tester@crossline.test";
const TEST_PASSWORD = "Crossline-E2E-Test-Pass-1!";

type CapturedMail = { to: string; subject: string; url: string };

/** Polls the mailbox directory for a message written after `since`, ignoring anything left by a prior run. */
async function waitForMail(dir: string, since: number, timeoutMs = 20_000): Promise<CapturedMail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const fresh = readdirSync(dir)
        .filter((name) => name.endsWith(".json") && Number(name.split("-")[0]) >= since)
        .sort();
      const newest = fresh.at(-1);
      if (newest) return JSON.parse(readFileSync(path.join(dir, newest), "utf8")) as CapturedMail;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No verification email appeared in ${dir} within ${timeoutMs}ms`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL as string | undefined ?? "http://127.0.0.1:3310";
  const mailboxDir = process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR;
  const authStatePath = config.projects[0]?.use.storageState as string | undefined;
  if (!mailboxDir || !authStatePath) {
    throw new Error("CROSSLINE_AUTH_TEST_MAILBOX_DIR or storageState is not configured — check playwright.config.ts");
  }
  mkdirSync(mailboxDir, { recursive: true });
  mkdirSync(path.dirname(authStatePath), { recursive: true });

  const api = await request.newContext({ baseURL });
  try {
    const since = Date.now();
    const signUp = await api.post("/api/auth/sign-up/email", {
      data: { name: "E2E Tester", email: TEST_EMAIL, password: TEST_PASSWORD, callbackURL: "/" }
    });
    if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()} ${await signUp.text()}`);

    const mail = await waitForMail(mailboxDir, since);
    const verify = await api.get(mail.url);
    if (!verify.ok()) throw new Error(`verify-email failed: ${verify.status()} ${await verify.text()}`);

    // The proof verification actually took effect: sign-in refuses an unverified account outright
    // (`EMAIL_NOT_VERIFIED`), so a session here means the token really was accepted.
    const signIn = await api.post("/api/auth/sign-in/email", { data: { email: TEST_EMAIL, password: TEST_PASSWORD } });
    if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()} ${await signIn.text()}`);

    // Not `api.get("/")` here to eagerly create the principal+workspace row: this context's cookie jar
    // is a bare Node HTTP client, and Better Auth's session cookie is `Secure` — only a real browser
    // applies Chrome's loopback exception that still sends a `Secure` cookie over plain
    // `http://127.0.0.1`, so a request from here would come back unauthenticated regardless of the
    // sign-in above. The exported storage state below still carries the real cookie faithfully; the
    // first test to actually load a page in a real browser is what triggers
    // `requireAccessContext`'s `createPrincipalWithWorkspace`, and it is idempotent per account, so it
    // does not matter which test gets there first.
    await api.storageState({ path: authStatePath });
  } finally {
    await api.dispose();
  }
}
