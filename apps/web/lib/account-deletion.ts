import "server-only";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessContext } from "@crossline/core";
import { RUNTIME_OWNER_SETTING } from "@crossline/core";
import { deleteAuthUser } from "@crossline/auth";
import type { CrosslineStore } from "@crossline/db";
import { getAuth } from "./auth";
import { requestCodexSupervisor } from "./codex-runtime";
import { dataDirectory, getStore } from "./crossline";
import { isLocalInstall } from "./local-install";

export type AccountDeletion = { ok: true; rows: number; files: number } | { ok: false; code: "ACCOUNT_IS_MACHINE_OWNER" | "ACCOUNT_DELETE_LOCAL" | "EMAIL_MISMATCH" };

/**
 * Why an account cannot be deleted here, if it cannot: the machine owner's workspace runs the server's own runtime (its Codex home, the
 * assistant) and is removed by the owner on the host, never by a button; an installed copy is removed by uninstalling it.
 */
export function deletionRefused(store: CrosslineStore, workspaceId: string): "ACCOUNT_IS_MACHINE_OWNER" | "ACCOUNT_DELETE_LOCAL" | undefined {
  if (isLocalInstall()) return "ACCOUNT_DELETE_LOCAL";
  if (store.getSetting(workspaceId, RUNTIME_OWNER_SETTING) === "1") return "ACCOUNT_IS_MACHINE_OWNER";
  return undefined;
}

/** Removes a path only when it lies inside the data directory: a stored uri is data, and data must never steer a delete elsewhere. */
function removeInside(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(root + path.sep)) return false;
  rmSync(resolved, { recursive: true, force: true });
  return true;
}

/**
 * 「删除账号」 (decided 2026-10-17, for the hosted beta): the person types the account's email, and everything the account holds goes —
 * its Codex sign-in and home on the server, every ledger row of its workspace, the files only it pointed at (uploads, prepared
 * materials, the portrait figure, a stored provider key), then the login itself. The public test keeps its own results under its own
 * delete link; nothing here reaches it.
 */
export async function deleteAccount(ctx: AccessContext, session: { userId: string; email: string }, typedEmail: string): Promise<AccountDeletion> {
  const store = getStore();
  const refused = deletionRefused(store, ctx.workspaceId);
  if (refused) return { ok: false, code: refused };
  if (typedEmail.trim().toLowerCase() !== session.email.trim().toLowerCase()) return { ok: false, code: "EMAIL_MISMATCH" };

  // The account's own Codex: signing out deletes its home on this machine (login, memories). A worker that cannot be reached now must
  // not keep the account alive; the home is then reclaimed with the rest of the runtime directory when the worker restarts.
  await requestCodexSupervisor(ctx, "/v1/codex/logout", { method: "POST" }).catch(() => undefined);

  const root = path.resolve(dataDirectory());
  const safe = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_");
  const purged = store.purgeWorkspace(ctx.workspaceId);
  let files = 0;
  for (const uri of purged.fileUris) {
    try { if (removeInside(root, uri.startsWith("file:") ? fileURLToPath(uri) : uri)) files += 1; } catch { /* an unreadable uri: nothing to remove */ }
  }
  for (const id of purged.workOrderIds) if (removeInside(root, path.join(root, "materials", id))) files += 1;
  removeInside(root, path.join(root, "portrait", safe(ctx.workspaceId)));
  removeInside(root, path.join(root, "secrets", safe(ctx.workspaceId).slice(0, 80)));

  const auth = getAuth();
  for (const userId of new Set([session.userId, ...purged.betterAuthUserIds])) await deleteAuthUser(auth, userId, session.email.toLowerCase());
  console.info(JSON.stringify({ type: "account.deleted", workspaceId: ctx.workspaceId, rows: purged.rows, files }));
  return { ok: true, rows: purged.rows, files };
}
