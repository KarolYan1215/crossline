import { mkdirSync } from "node:fs";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";
import { signUpAccount } from "./accounts";

/**
 * Drives the real Better Auth sign-up → verify → sign-in flow once per e2e run, so every test starts
 * with an authenticated session instead of hitting `/login`. `apps/web` refuses email/password sign-up
 * entirely unless it can actually deliver a verification link (see `CrosslineAuthOptions.testMailboxDir`
 * in `packages/auth`); the server here is started with `CROSSLINE_AUTH_TEST_MAILBOX_DIR` set, so that
 * link lands as a JSON file on disk instead of a real mailbox.
 */
export const TEST_EMAIL = "e2e-tester@crossline.test";
export const TEST_PASSWORD = "Crossline-E2E-Test-Pass-1!";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL as string | undefined ?? "http://127.0.0.1:3310";
  const mailboxDir = process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR;
  const authStatePath = config.projects[0]?.use.storageState as string | undefined;
  if (!mailboxDir || !authStatePath) {
    throw new Error("CROSSLINE_AUTH_TEST_MAILBOX_DIR or storageState is not configured — check playwright.config.ts");
  }
  mkdirSync(mailboxDir, { recursive: true });
  mkdirSync(path.dirname(authStatePath), { recursive: true });

  await signUpAccount(baseURL, TEST_EMAIL, TEST_PASSWORD);
  const api = await request.newContext({ baseURL });
  try {
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
