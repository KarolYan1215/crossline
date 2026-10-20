/**
 * Prints, as one JSON line, when the person last acted in a workspace and when anything last changed in it — the two stamps
 * scripts/ledger-sync.ts compares between the owner's machine and the hosted server (docs/ledger-sync.md). Read-only: the ledger is
 * opened with better-sqlite3 directly, never through CrosslineStore, so no migration runs on a live database.
 *
 *   pnpm exec tsx scripts/ledger-stamp.ts --db <crossline.db> (--workspace <id> | --email <address>)
 *
 * `--email` finds the account's owner workspace through the auth.db beside the ledger (the server side; the local resident copy has
 * no account for the machine owner, so it is named by `--workspace`).
 */
import { existsSync } from "node:fs";
import path from "node:path";
// The same rows as `PERSON_ACTIVITY_SQL` in packages/db/src/index.ts (the person's own actions). Copied, not imported: this file is
// also mounted into the server's app image, which may predate an export (deploy/server/ledger-sync.sh).
const PERSON_EVENTS = ["ask.answered", "block.confirmed", "execution.confirmed", "execution.paused", "execution.resumed", "capture.created",
  "capture.discarded", "milestone.revised", "milestone.retrospective", "approval.revoked", "risk.accepted", "ask.snoozed", "return.answered",
  "line.created", "line.updated", "line.ranked", "lines.set_up", "dates.decided", "source.project_assigned"];
const PERSON_ACTIVITY_SQL = `
  SELECT created_at AS at FROM conversation_messages WHERE workspace_id = @ws AND role = 'person' AND created_at >= @since
  UNION ALL SELECT created_at FROM onboarding_messages WHERE workspace_id = @ws AND role = 'user' AND created_at >= @since
  UNION ALL SELECT started_at FROM executions WHERE workspace_id = @ws AND started_at >= @since
  UNION ALL SELECT ended_at FROM executions WHERE workspace_id = @ws AND ended_at IS NOT NULL AND ended_at >= @since
  UNION ALL SELECT observed_at FROM energy_observations WHERE workspace_id = @ws AND source = 'self_report' AND observed_at >= @since
  UNION ALL SELECT created_at FROM events WHERE workspace_id = @ws AND created_at >= @since
    AND (type IN (${PERSON_EVENTS.map((type) => `'${type}'`).join(",")})
      OR (type = 'task.step_progress' AND json_extract(payload_json, '$.source') IN ('user', 'person', 'confirm')))`;

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const db = arg("db") ?? (() => { throw new Error("missing --db"); })();
if (!existsSync(db)) throw new Error(`no ledger at ${db}`);

type Row = Record<string, unknown>;
type Db = { prepare: (sql: string) => { get: (...args: unknown[]) => Row | undefined; all: (...args: unknown[]) => Row[] }; pragma: (sql: string, options?: object) => unknown; close: () => void };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => Db;

function workspaceOfEmail(email: string) {
  const authPath = path.join(path.dirname(db), "auth.db");
  if (!existsSync(authPath)) throw new Error(`no auth.db beside ${db}; name the workspace with --workspace`);
  const auth = new Database(authPath, { readonly: true, fileMustExist: true });
  const user = auth.prepare("SELECT id FROM user WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
  auth.close();
  if (!user) throw new Error(`EMAIL_NOT_FOUND: ${email}`);
  const row = ledger.prepare(`SELECT m.workspace_id AS id FROM principals p JOIN workspace_members m ON m.principal_id = p.id
    WHERE p.better_auth_user_id = ? AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`).get(user.id) as { id: string } | undefined;
  if (!row) throw new Error(`EMAIL_NO_WORKSPACE: ${email}`);
  return row.id;
}

const ledger = new Database(db, { readonly: true, fileMustExist: true });
const workspaceId = arg("workspace") ?? (arg("email") ? workspaceOfEmail(arg("email")!) : (() => { throw new Error("pass --workspace or --email"); })());
const known = ledger.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
if (!known) throw new Error(`WORKSPACE_NOT_FOUND: ${workspaceId}`);
const person = (ledger.prepare(`SELECT MAX(at) AS at FROM (${PERSON_ACTIVITY_SQL})`).get({ ws: workspaceId, since: "" }) as { at: string | null }).at;
const changed = (ledger.prepare(`SELECT MAX(at) AS at FROM (
  SELECT MAX(created_at) AS at FROM events WHERE workspace_id = @ws
  UNION ALL SELECT MAX(updated_at) FROM settings WHERE workspace_id = @ws)`).get({ ws: workspaceId }) as { at: string | null }).at;
const counts = Object.fromEntries(["profile_facts", "work_orders", "milestones", "source_documents", "events"].map((table) =>
  [table, (ledger.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId) as { n: number }).n]));
console.log(JSON.stringify({ workspaceId, person, changed, userVersion: ledger.pragma("user_version", { simple: true }), counts }));
ledger.close();
