/**
 * Moves one person's workspace from one Crossline install to another on the same machine — the resident copy (port 3210, the repo's
 * `data/`) into the installed app (`%LOCALAPPDATA%\Crossline\data`) — so the installed app opens with everything the person already has.
 *
 *   pnpm exec tsx scripts/migrate-workspace.ts --from-db <crossline.db> --from-data <dir> --workspace <id>
 *     --to-db <crossline.db> --to-data <dir> [--apply]
 *
 * Without `--apply` it only reports what it would do. The source is read through an SQLite online backup and never written. The
 * target must hold exactly one workspace with no person data in it (no facts, interview messages, work orders, captures or files):
 * its own seeded rows are cleared and the source's rows imported under the target's workspace and owner ids, so the target's sign-in
 * keeps working. Identity tables (principals, workspaces, members, device leases, Tailscale bindings) are never copied. Paths under the
 * source data directory are rewritten to the target's, and the files they name — prepared materials, uploaded sources, the portrait —
 * are copied. Stop the target app before `--apply`; back its data directory up first.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "../packages/db/src/index";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const need = (name: string) => arg(name) ?? (() => { throw new Error(`missing --${name}`); })();
const fromDb = need("from-db"), fromData = need("from-data"), workspaceId = need("workspace"), toDb = need("to-db"), toData = need("to-data");
const apply = process.argv.includes("--apply");

const IDENTITY = new Set(["principals", "workspaces", "workspace_members", "device_leases", "tailscale_bindings", "audit_events"]);
const PERSON_DATA = ["profile_facts", "onboarding_messages", "work_orders", "captures", "source_documents"];

// The source is copied first: an online backup, so the running resident app is never touched.
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const staging = path.join(tmpdir(), `crossline-migrate-${process.pid}`);
mkdirSync(staging, { recursive: true });
const sourceCopy = path.join(staging, "source.db");
const live = new Database(fromDb, { readonly: true, fileMustExist: true });
await live.backup(sourceCopy);
live.close();
const source = new CrosslineStore(sourceCopy);
const snapshot = source.exportSnapshot(workspaceId);
const fromOwner = source.getWorkspaceOwnerId(workspaceId);
source.close();
if (!fromOwner) throw new Error("SOURCE_WORKSPACE_NOT_FOUND");

const target = new CrosslineStore(toDb);
const targets = target.listWorkspaces();
if (targets.length !== 1) throw new Error(`TARGET_WORKSPACES_${targets.length}: expected exactly one`);
const toWorkspace = targets[0]!.id;
const toOwner = target.getWorkspaceOwnerId(toWorkspace)!;
const raw = new Database(toDb) as unknown as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown; all: () => unknown[] }; close: () => void };
for (const table of PERSON_DATA) {
  const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(toWorkspace) as { n: number };
  if (row.n) throw new Error(`TARGET_NOT_EMPTY: ${table} has ${row.n} rows of the person's own`);
}

// Every string in every row: the workspace and owner ids, and the source data directory in each way a path is written in the ledger
// (forward slashes in file URLs, backslashes in Windows paths, and those backslashes JSON-escaped inside a payload).
const variants = (dir: string) => {
  const forward = path.resolve(dir).replace(/\\/g, "/"), back = forward.replace(/\//g, "\\");
  return [forward, back, back.replace(/\\/g, "\\\\")];
};
const pathPairs = variants(fromData).map((from, index) => [from, variants(toData)[index]!] as const);
let paths = 0;
const rewrite = (value: string) => {
  let next = value.split(workspaceId).join(toWorkspace).split(fromOwner).join(toOwner);
  for (const [from, to] of pathPairs) if (next.includes(from)) { paths += next.split(from).length - 1; next = next.split(from).join(to); }
  return next;
};
const tables: Record<string, Array<Record<string, unknown>>> = {};
for (const [table, rows] of Object.entries(snapshot.tables as Record<string, Array<Record<string, unknown>>>)) {
  if (IDENTITY.has(table)) continue;
  tables[table] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === "string" ? rewrite(value) : value])));
}
const counts = Object.fromEntries(Object.entries(tables).filter(([, rows]) => rows.length).map(([table, rows]) => [table, rows.length]));
const seeded = Object.keys(tables).map((table) => [table, (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(toWorkspace) as { n: number }).n] as const)
  .filter(([, n]) => n);

const portraitFrom = path.join(fromData, "portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
const portraitTo = path.join(toData, "portrait", toWorkspace.replace(/[^a-zA-Z0-9_-]/g, "_"));
const folders = [["materials", "materials"], ["sources", "sources"]].map(([from, to]) => [path.join(fromData, from!), path.join(toData, to!)] as const)
  .filter(([from]) => existsSync(from));
console.log(JSON.stringify({ apply, from: { workspaceId, owner: fromOwner }, to: { workspace: toWorkspace, owner: toOwner },
  rows: counts, pathsRewritten: paths, targetSeededRowsCleared: Object.fromEntries(seeded),
  copies: [...folders, ...(existsSync(portraitFrom) ? [[portraitFrom, portraitTo] as const] : [])].map(([from, to]) => `${from} -> ${to}`) }, null, 1));

if (apply) {
  for (const [table] of seeded) raw.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(toWorkspace);
  raw.close();
  const result = target.importSnapshot({ ...snapshot, workspaceId: toWorkspace, tables });
  target.close();
  for (const [from, to] of folders) cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  if (existsSync(portraitFrom)) cpSync(portraitFrom, portraitTo, { recursive: true });
  console.log(JSON.stringify({ imported: Object.fromEntries(Object.entries(result).filter(([, n]) => n)) }));
} else {
  raw.close();
  target.close();
}
rmSync(staging, { recursive: true, force: true });
