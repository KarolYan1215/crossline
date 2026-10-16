import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCrosslineAuth, migrateCrosslineAuth, signupAllowlist, type CrosslineAuthOptions } from "./index";

const dirs: string[] = [];
const saved = process.env.CROSSLINE_SIGNUP_ALLOWLIST;
afterEach(() => {
  if (saved === undefined) delete process.env.CROSSLINE_SIGNUP_ALLOWLIST; else process.env.CROSSLINE_SIGNUP_ALLOWLIST = saved;
  // Better Auth keeps its SQLite handle open; best effort on Windows.
  while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* locked */ } }
});

test("the list is read from the environment, trimmed and lower-cased; empty means open", () => {
  expect(signupAllowlist({})).toBeUndefined();
  expect(signupAllowlist({ CROSSLINE_SIGNUP_ALLOWLIST: " , " })).toBeUndefined();
  expect([...signupAllowlist({ CROSSLINE_SIGNUP_ALLOWLIST: " A@x.com, b@y.com " })!]).toEqual(["a@x.com", "b@y.com"]);
});

test("a named file adds addresses without a restart, and closes sign-up even while empty or missing", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-allow-file-"));
  dirs.push(dir);
  const file = path.join(dir, "allow.txt");
  expect([...signupAllowlist({ CROSSLINE_SIGNUP_ALLOWLIST_FILE: file })!]).toEqual([]);
  writeFileSync(file, "# from the test\r\nFriend@Example.com\n\n");
  expect([...signupAllowlist({ CROSSLINE_SIGNUP_ALLOWLIST_FILE: file, CROSSLINE_SIGNUP_ALLOWLIST: "owner@x.com" })!]).toEqual(["owner@x.com", "friend@example.com"]);
});

test("with a cap, anyone signs up until it is reached; the next address is refused and put on the waiting list", async () => {
  const savedCap = process.env.CROSSLINE_SIGNUP_CAP;
  const savedWait = process.env.CROSSLINE_SIGNUP_WAITLIST_FILE;
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-auth-cap-"));
  dirs.push(dir);
  process.env.CROSSLINE_SIGNUP_CAP = "1";
  process.env.CROSSLINE_SIGNUP_WAITLIST_FILE = path.join(dir, "waiting.txt");
  try {
    const mailbox = path.join(dir, "mailbox");
    const options: CrosslineAuthOptions = { authDbPath: path.join(dir, "auth.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
      trustedOrigins: ["http://127.0.0.1:3210"], testMailboxDir: mailbox };
    await migrateCrosslineAuth(options);
    const auth = createCrosslineAuth(options) as unknown as { api: Record<string, (input: unknown) => Promise<unknown>> };
    const codeFor = async (email: string) => {
      await auth.api.sendVerificationOTP!({ body: { email, type: "sign-in" } });
      const file = readdirSync(mailbox).sort().map((name) => path.join(mailbox, name)).filter((name) => readFileSync(name, "utf8").includes(email)).at(-1)!;
      return /\d{6}/.exec((JSON.parse(readFileSync(file, "utf8")) as { url: string }).url)![0];
    };
    await auth.api.signInEmailOTP!({ body: { email: "first@example.com", otp: await codeFor("first@example.com") } });
    await expect(auth.api.signInEmailOTP!({ body: { email: "second@example.com", otp: await codeFor("second@example.com") } }))
      .rejects.toMatchObject({ body: { code: "SIGNUP_FULL" } });
    expect(readFileSync(path.join(dir, "waiting.txt"), "utf8")).toMatch(/^second@example\.com\t/);
    // The first person still signs in.
    const again = await auth.api.signInEmailOTP!({ body: { email: "first@example.com", otp: await codeFor("first@example.com") } }) as { user?: { email?: string } };
    expect(again.user?.email).toBe("first@example.com");
  } finally {
    if (savedCap === undefined) delete process.env.CROSSLINE_SIGNUP_CAP; else process.env.CROSSLINE_SIGNUP_CAP = savedCap;
    if (savedWait === undefined) delete process.env.CROSSLINE_SIGNUP_WAITLIST_FILE; else process.env.CROSSLINE_SIGNUP_WAITLIST_FILE = savedWait;
  }
}, 30_000);

test("with a list, an invited address signs up by email code and any other is refused", async () => {
  process.env.CROSSLINE_SIGNUP_ALLOWLIST = "Invited@example.com";
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-auth-allow-"));
  dirs.push(dir);
  const mailbox = path.join(dir, "mailbox");
  const options: CrosslineAuthOptions = { authDbPath: path.join(dir, "auth.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
    trustedOrigins: ["http://127.0.0.1:3210"], testMailboxDir: mailbox };
  await migrateCrosslineAuth(options);
  const auth = createCrosslineAuth(options) as unknown as { api: Record<string, (input: unknown) => Promise<unknown>> };
  const codeFor = async (email: string) => {
    await auth.api.sendVerificationOTP!({ body: { email, type: "sign-in" } });
    const file = readdirSync(mailbox).sort().map((name) => path.join(mailbox, name)).filter((name) => readFileSync(name, "utf8").includes(email)).at(-1)!;
    return /\d{6}/.exec((JSON.parse(readFileSync(file, "utf8")) as { url: string }).url)![0];
  };
  const invited = await auth.api.signInEmailOTP!({ body: { email: "invited@example.com", otp: await codeFor("invited@example.com") } }) as { user?: { email?: string } };
  expect(invited.user?.email).toBe("invited@example.com");
  await expect(auth.api.signInEmailOTP!({ body: { email: "stranger@example.com", otp: await codeFor("stranger@example.com") } }))
    .rejects.toMatchObject({ body: { code: "SIGNUP_NOT_INVITED" } });
}, 30_000);
