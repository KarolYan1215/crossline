/**
 * Puts one account on the developer's model by the invite-code path itself (packages/db/src/invites.ts): an application in the
 * account's name, the owner's approval minting a code, and the account redeeming it — the same three steps a tester goes through,
 * without the mail. The code is redeemed at once and never printed; only its hash is stored.
 *
 *   pnpm exec tsx scripts/grant-sponsor.ts --email someone@example.com [--data /data] [--reason "…"] [--apply]
 *
 * Dry run by default: says which workspace it found and whether it is sponsored already. Back the ledger up before `--apply`
 * (deploy/server/backup.sh on the server). An account that also has its own ChatGPT keeps running on it and moves to the developer's
 * model only while its quota is spent (model-provider.ts, 2026-10-21).
 */
import path from "node:path";
import { applyForInvite, CrosslineStore, decideInvite, redeemInvite, sponsorshipOf, SPONSOR_SETTING } from "../packages/db/src/index";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const email = arg("email")?.trim().toLowerCase();
const dataDir = arg("data") ?? process.env.CROSSLINE_DATA_DIR ?? "data";
const reason = arg("reason") ?? "开发者授权：ChatGPT 额度用尽时改用开发者模型继续";
const apply = process.argv.includes("--apply");
if (!email) throw new Error("usage: --email <address> [--data <dir>] [--apply]");

// Finding the account only reads: the address is in Better Auth's database, the account's own workspace in the ledger.
type Reader = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown }; close: () => void };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: object) => Reader;
const auth = new Database(path.join(dataDir, "auth.db"), { readonly: true, fileMustExist: true });
const user = auth.prepare("SELECT id FROM user WHERE lower(email) = ?").get(email) as { id: string } | undefined;
auth.close();
if (!user) throw new Error("ACCOUNT_NOT_FOUND");
const ledger = new Database(path.join(dataDir, "crossline.db"), { readonly: true, fileMustExist: true });
const found = ledger.prepare(`SELECT p.id AS principalId, wm.workspace_id AS workspaceId FROM principals p
  JOIN workspace_members wm ON wm.principal_id = p.id AND wm.role = 'owner' WHERE p.better_auth_user_id = ?`).get(user.id) as
  { principalId: string; workspaceId: string } | undefined;
ledger.close();
if (!found) throw new Error("WORKSPACE_NOT_FOUND");

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
try {
  const before = sponsorshipOf(store, found.workspaceId);
  console.log(JSON.stringify({ ...found, sponsoredAlready: Boolean(before),
    runtimeOwner: store.getSetting(found.workspaceId, "deployment.runtimeOwner") === "1", apply }));
  if (!before && apply) {
    const { invite } = applyForInvite(store, { workspaceId: found.workspaceId, email, reason });
    // An application already decided (approved and not redeemed, or rejected) is not decided again: said instead of guessed.
    if (invite.status !== "pending") throw new Error(`INVITE_ALREADY_${invite.status.toUpperCase()}: ${invite.id}`);
    const decided = decideInvite(store, invite.id, "approve");
    if (!decided.ok || !decided.code) throw new Error(decided.ok ? "INVITE_NO_CODE" : decided.code);
    const redeemed = redeemInvite(store, found.workspaceId, found.principalId, decided.code);
    if (!redeemed.ok) throw new Error(redeemed.code);
    console.log(JSON.stringify({ granted: true, inviteId: invite.id, [SPONSOR_SETTING]: store.getSetting(found.workspaceId, SPONSOR_SETTING) }));
  }
} finally { store.close(); }
