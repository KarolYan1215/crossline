/**
 * Identity/private-deployment gate evidence (stages two–six of the identity plan, not the design §12
 * numbering): two real accounts really cannot see each other's data, revoking a session really takes
 * effect on the next request (not after a cache window), no inbound firewall rule exists for this app's
 * ports, and a backup/restore round trip really carries `auth.db` alongside the main ledger.
 *
 *   pnpm exec tsx scripts/gate-identity-check.ts
 *
 * Runs against throwaway `auth.db`/`crossline.db` files under the OS temp dir — never the live ledger.
 * Two real Better Auth accounts are signed up, verified (via `testMailboxDir`, the same file-based mail
 * sink `e2e/global-setup.ts` uses — not a mock of Better Auth, the same production `createCrosslineAuth`
 * code path with only the mail transport swapped) and signed in through `auth.handler` directly — the
 * exact fetch-style handler `apps/web/app/api/auth/[...all]/route.ts` calls, so this exercises real
 * HTTP-shaped requests/responses without needing a full Next.js server listening on a port.
 */
import { mkdtempSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createCrosslineAuth, migrateCrosslineAuth, requireAccessContext } from "../packages/auth/src/index";
import { CrosslineStore } from "../packages/db/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-gate-identity-"));
const mailboxDir = path.join(dataDir, "mailbox");
const baseURL = "http://127.0.0.1:39399";
const authDbPath = path.join(dataDir, "auth.db");

const failures: string[] = [];
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.info(JSON.stringify({ step: label, ok: condition, ...(detail === undefined ? {} : { detail }) }));
  if (!condition) failures.push(label);
};

const authOptions = {
  authDbPath, secret: "gate-identity-check-secret-not-for-real-use",
  baseURL, trustedOrigins: [baseURL], testMailboxDir: mailboxDir
};
await migrateCrosslineAuth(authOptions);
const auth = createCrosslineAuth(authOptions);
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));

/** Newest mailbox file written at or after `since` — mirrors `e2e/global-setup.ts`'s `waitForMail`. */
function readLatestMail(since: number): { to: string; subject: string; url: string } {
  const fresh = readdirSync(mailboxDir)
    .filter((name) => name.endsWith(".json") && Number(name.split("-")[0]) >= since)
    .sort();
  const newest = fresh.at(-1);
  if (!newest) throw new Error(`no verification mail appeared in ${mailboxDir}`);
  return JSON.parse(readFileSync(path.join(mailboxDir, newest), "utf8"));
}

/** `Set-Cookie: name=value; Attr...` (possibly several) → the `Cookie` header value for later requests. */
function cookieHeaderFrom(response: Response): string {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  return setCookies.filter(Boolean).map((raw) => raw.split(";")[0]).join("; ");
}

async function signUpVerifyAndSignIn(email: string, password: string): Promise<string> {
  const since = Date.now();
  const signUp = await auth.handler(new Request(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ name: email, email, password, callbackURL: "/" })
  }));
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);

  const mail = readLatestMail(since);
  // `verify-email` redirects (302) to a callback URL on success rather than returning 200 — `Response.ok`
  // is false for any 3xx, so success here is "not a 4xx/5xx", not "ok".
  const verify = await auth.handler(new Request(mail.url));
  if (verify.status >= 400) throw new Error(`verify-email failed: ${verify.status} ${await verify.text()}`);

  const signIn = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ email, password })
  }));
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  return cookieHeaderFrom(signIn);
}

try {
  // ---- Two real, independently signed-up-and-verified accounts.
  const cookie1 = await signUpVerifyAndSignIn("gate-identity-1@crossline.test", "Gate-Identity-Check-Pass-1!");
  const cookie2 = await signUpVerifyAndSignIn("gate-identity-2@crossline.test", "Gate-Identity-Check-Pass-2!");

  const result1 = await requireAccessContext(auth, store, new Request(`${baseURL}/`, { headers: { cookie: cookie1 } }));
  const result2 = await requireAccessContext(auth, store, new Request(`${baseURL}/`, { headers: { cookie: cookie2 } }));
  if ("error" in result1) throw new Error(`account 1 context failed: ${result1.error}`);
  if ("error" in result2) throw new Error(`account 2 context failed: ${result2.error}`);
  const ctx1 = result1.ctx, ctx2 = result2.ctx;
  check("two_accounts_distinct_workspaces", ctx1.workspaceId !== ctx2.workspaceId && ctx1.principalId !== ctx2.principalId,
    { workspace1: ctx1.workspaceId, workspace2: ctx2.workspaceId });

  // ---- Workspace isolation: a work order written under account 1's workspace never shows up in
  // account 2's — the real gap `isolation.test.ts`'s doc comment names, exercised here through the
  // actual session→AccessContext path rather than a directly-constructed context object.
  store.saveWorkOrder({
    id: "gate-identity-order", ownerId: ctx1.principalId, workspaceId: ctx1.workspaceId, identityId: "research",
    projectId: "gate-identity-project", milestoneId: "gate-identity-milestone", intent: "账号一私有作业",
    state: "captured", riskTier: "routine",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 30, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract: [], evidenceContract: [] }
  });
  check("owner_sees_own_order", store.listWorkOrders(ctx1.workspaceId).some((item) => item.id === "gate-identity-order"));
  check("other_account_sees_nothing", store.listWorkOrders(ctx2.workspaceId).length === 0,
    store.listWorkOrders(ctx2.workspaceId));

  // ---- Revocation takes effect immediately: `session: { cookieCache: { enabled: false } }` means the
  // next request re-checks the database rather than trusting a signed cookie payload.
  const signOut = await auth.handler(new Request(`${baseURL}/api/auth/sign-out`, {
    method: "POST", headers: { cookie: cookie1, origin: baseURL }
  }));
  check("sign_out_succeeds", signOut.ok, { status: signOut.status });
  const afterRevoke = await requireAccessContext(auth, store, new Request(`${baseURL}/`, { headers: { cookie: cookie1 } }));
  check("revoked_session_rejected_immediately", "error" in afterRevoke && afterRevoke.error === "UNAUTHENTICATED", afterRevoke);
  // Account 2's independent session is untouched by account 1's sign-out.
  const stillCtx2 = await requireAccessContext(auth, store, new Request(`${baseURL}/`, { headers: { cookie: cookie2 } }));
  check("other_account_session_unaffected", "ctx" in stillCtx2 && stillCtx2.ctx.workspaceId === ctx2.workspaceId, stillCtx2);

  // ---- No inbound firewall rule exists for this app's ports — Tailscale Serve rides its own virtual
  // network interface and needs none; a rule appearing here would mean something else opened one.
  try {
    const rules = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "Get-NetFirewallRule | Where-Object { $_.DisplayName -match '3210|3211|[Cc]rossline' } | Select-Object -ExpandProperty DisplayName"
    ], { encoding: "utf8" }).trim();
    check("no_inbound_firewall_rule_for_app_ports", rules.length === 0, rules || "(none)");
  } catch (error) {
    check("no_inbound_firewall_rule_for_app_ports", false, String(error));
  }

  // ---- Backup/restore carries `auth.db` alongside the ledger: a real WAL checkpoint, copy, and
  // independent read-back of `user`/`session`/`account`/`verification` row counts — the same drill
  // `scripts/checkpoint-auth-db.ts` and `scripts/read-auth-db-counts.ts` perform, run inline here so this
  // script stays self-contained.
  const before = new Database(authDbPath, { readonly: false });
  before.pragma("wal_checkpoint(TRUNCATE)");
  const beforeCounts = Object.fromEntries(["user", "session", "account", "verification"].map((table) =>
    [table, (before.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
  before.close();
  const restoredAuthDbPath = path.join(dataDir, "auth-restored.db");
  copyFileSync(authDbPath, restoredAuthDbPath);
  const after = new Database(restoredAuthDbPath, { readonly: true });
  const afterCounts = Object.fromEntries(["user", "session", "account", "verification"].map((table) =>
    [table, (after.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
  after.close();
  check("auth_db_backup_restore_roundtrip", JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
    { beforeCounts, afterCounts });
  // Two signed-up users must actually have landed rows — otherwise the counts matching each other would
  // be vacuously true (both zero).
  check("auth_db_has_real_rows", (beforeCounts.user ?? 0) >= 2, beforeCounts);
} finally {
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "gates_failed" : "gates_passed", failures, dataDir }));
process.exitCode = failures.length ? 1 : 0;
