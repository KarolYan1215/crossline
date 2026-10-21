/**
 * Moves one person's workspace from one Crossline install to another on the same machine — the resident copy (port 3210, the repo's
 * `data/`) into the installed app (`%LOCALAPPDATA%\Crossline\data`) — so the installed app opens with everything the person already has.
 *
 *   pnpm exec tsx scripts/migrate-workspace.ts --from-db <crossline.db> --from-data <dir> --workspace <id>
 *     --to-db <crossline.db> --to-data <dir> [--files <dir>] [--to-workspace <id> | --to-email <address>] [--replace] [--apply]
 *
 * Also moves a workspace from the owner's Windows machine onto the hosted server (docs/beta-launch.md §10.6): the ledger and the
 * folders are packed by scripts/pack-for-server.ts and uploaded; `--from-data` is then the original Windows data directory (only used
 * to recognise and rewrite the paths stored in the ledger, which become POSIX paths under `--to-data`) and `--files` the directory the
 * uploaded `materials`, `sources` and `portrait` folders were unpacked into. `--replace` clears everything the target workspace already
 * holds (interview, facts, tasks, files…) instead of refusing a target that is not empty. `--to-workspace` names the target when the
 * target ledger holds more than one workspace; `--to-email` finds it by the account's sign-in address in the `auth.db` beside it.
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
const apply = process.argv.includes("--apply"), replace = process.argv.includes("--replace");
// Settings that belong to the machine, not the person: these keep the target's own values (docs/ledger-sync.md). Each entry is a
// prefix. `--keep-settings none` turns it off, `--keep-settings a,b` replaces the list.
const MACHINE_SETTINGS = ["deployment.runtimeOwner", "calendar.graph.owner", "calendar.write.account", "calendar.sources", "calendar.sources.seeded",
  "calendar.subscriptions", "calendar.sync_zone:", "calendar.published", "calendar.autopublish.hash", "calendar.fixed.hash", "calendar.publish.failure",
  "calendar.sync.failure", "push.subscriptions", "sources.folders", "sources.folder.index:", "localActivity.", "activity.", "energy.camera",
  "health.token.sha256", "model.provider", "model.provider.conformance", "model.sponsor", "model.chatgptExhausted", "model.budget.monthly", "mail.", "agent.sandbox", "background.blocker"];
const keepSettings = arg("keep-settings") === "none" ? [] : arg("keep-settings")?.split(",").map((key) => key.trim()).filter(Boolean) ?? MACHINE_SETTINGS;
const keptKey = (key: string) => keepSettings.some((rule) => key.startsWith(rule));
const filesRoot = arg("files") ?? fromData;
// A Windows path is resolved with Windows rules even on the Linux server, and the other way round.
const pathFor = (dir: string) => (/^[A-Za-z]:[\\/]/.test(dir) ? path.win32 : path.posix);

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
const named = arg("to-workspace") ?? workspaceOfEmail(arg("to-email"));
if (named ? !targets.some((workspace) => workspace.id === named) : targets.length !== 1) {
  throw new Error(`TARGET_WORKSPACES: ${targets.map((workspace) => workspace.id).join(", ") || "none"}; name one with --to-workspace`);
}
const toWorkspace = named ?? targets[0]!.id;
const toOwner = target.getWorkspaceOwnerId(toWorkspace)!;
const raw = new Database(toDb) as unknown as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }; close: () => void };
const existing = Object.fromEntries(PERSON_DATA.map((table) =>
  [table, (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(toWorkspace) as { n: number }).n] as const).filter(([, n]) => n));
if (Object.keys(existing).length && !replace) throw new Error(`TARGET_NOT_EMPTY: ${JSON.stringify(existing)}; pass --replace to clear it`);

// The owner workspace of the account signed in with this address: auth.db's user → principals → workspace_members.
function workspaceOfEmail(email: string | undefined) {
  if (!email) return undefined;
  const auth = new Database(path.join(path.dirname(toDb), "auth.db"), { readonly: true, fileMustExist: true }) as unknown as
    { prepare: (sql: string) => { get: (...args: unknown[]) => unknown }; close: () => void };
  const user = auth.prepare("SELECT id FROM user WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
  auth.close();
  if (!user) throw new Error(`TARGET_EMAIL_NOT_FOUND: ${email} has not signed in on the target`);
  const ledger = new Database(toDb, { readonly: true }) as unknown as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown }; close: () => void };
  const row = ledger.prepare(`SELECT m.workspace_id AS id FROM principals p JOIN workspace_members m ON m.principal_id = p.id
    WHERE p.better_auth_user_id = ? AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`).get(user.id) as { id: string } | undefined;
  ledger.close();
  if (!row) throw new Error(`TARGET_EMAIL_NO_WORKSPACE: ${email} has an account but no workspace yet; open the app once`);
  return row.id;
}

// With --replace every table that holds rows of a workspace is cleared for the target, not only the ones the snapshot carries.
function workspaceTables() {
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  return names.filter((name) => !IDENTITY.has(name)
    && (raw.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as Array<{ name: string }>).some((column) => column.name === "workspace_id"));
}

// Every string in every row: the workspace and owner ids, and the source data directory in each way a path is written in the ledger
// (forward slashes in file URLs, backslashes in Windows paths, and those backslashes JSON-escaped inside a payload).
const variants = (dir: string) => {
  const forward = pathFor(dir).resolve(dir).replace(/\\/g, "/"), back = forward.replace(/\//g, "\\");
  return [forward, back, back.replace(/\\/g, "\\\\")];
};
const toPosix = pathFor(toData) === path.posix;
const fromVariants = variants(fromData), toVariants = variants(toData);
// Each way the source directory is written, with the separator its tail uses: on a POSIX target the tail's backslashes become slashes.
const pathPairs = fromVariants.map((from, index) => ({ from, to: toPosix ? toVariants[0]! : toVariants[index]!, separator: ["/", "\\", "\\\\"][index]! }));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let paths = 0;
const rewrite = (value: string) => {
  let next = value.split(workspaceId).join(toWorkspace).split(fromOwner).join(toOwner);
  for (const { from, to, separator } of pathPairs) {
    if (!next.includes(from)) continue;
    // The directory and the rest of the path after it, up to a quote, whitespace or the end.
    next = next.replace(new RegExp(`${escape(from)}((?:${escape(separator)}[^\\s"'<>|*?\\\\/]+)*)`, "g"), (_match, tail: string) => {
      paths += 1;
      return to + (toPosix ? tail.split(separator).join("/") : tail);
    });
  }
  return next;
};
const tables: Record<string, Array<Record<string, unknown>>> = {};
for (const [table, rows] of Object.entries(snapshot.tables as Record<string, Array<Record<string, unknown>>>)) {
  if (IDENTITY.has(table)) continue;
  tables[table] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === "string" ? rewrite(value) : value])));
}
const keptSettings = (raw.prepare("SELECT key FROM settings WHERE workspace_id = ?").all(toWorkspace) as Array<{ key: string }>).map((row) => row.key).filter(keptKey);
if (tables.settings) tables.settings = tables.settings.filter((row) => !keptKey(String(row.key)));
// A row id the target assigns itself (INTEGER PRIMARY KEY AUTOINCREMENT: model_usage, activity_segments) is global to the ledger, so the
// source's values collide with other workspaces' rows on the server — the first real write failed on `model_usage.id`. They are left
// for the target to number.
const autoNumbered = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'").all() as Array<{ name: string }>).map((row) => row.name));
for (const table of autoNumbered) if (tables[table]) tables[table] = tables[table].map((row) => ({ ...row, id: null }));
const counts = Object.fromEntries(Object.entries(tables).filter(([, rows]) => rows.length).map(([table, rows]) => [table, rows.length]));
const seeded = (replace ? workspaceTables() : Object.keys(tables)).map((table) => [table, (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(toWorkspace) as { n: number }).n] as const)
  .filter(([, n]) => n);

const portraitFrom = path.join(filesRoot, "portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
const portraitTo = path.join(toData, "portrait", toWorkspace.replace(/[^a-zA-Z0-9_-]/g, "_"));
const folders = [["materials", "materials"], ["sources", "sources"]].map(([from, to]) => [path.join(filesRoot, from!), path.join(toData, to!)] as const)
  .filter(([from]) => existsSync(from));
console.log(JSON.stringify({ apply, from: { workspaceId, owner: fromOwner }, to: { workspace: toWorkspace, owner: toOwner },
  rows: counts, pathsRewritten: paths, replace, targetRowsCleared: Object.fromEntries(seeded), settingsKept: keptSettings,
  copies: [...folders, ...(existsSync(portraitFrom) ? [[portraitFrom, portraitTo] as const] : [])].map(([from, to]) => `${from} -> ${to}`) }, null, 1));

if (apply) {
  raw.close();
  // Clearing and importing are one transaction: the first real write cleared the target, failed in the import and left the account
  // empty. `resetWorkspace` is the app's own 「清空数据重新开始」 — it keeps the membership, the model spend and the kept settings.
  // importSnapshot refuses a table that still holds rows of the workspace, so the kept settings are taken out and put back after it,
  // and the model spend is the target's own (it is what a sponsored account's monthly budget is counted from): the source's is not
  // imported and the target's stays.
  const keptRows = keptSettings.map((key) => ({ key, value: target.getSetting(toWorkspace, key) })).filter((row): row is { key: string; value: string } => row.value !== undefined);
  const { model_usage: _sourceSpend, ...imported } = tables;
  const result = target.atomically(() => {
    target.resetWorkspace(toWorkspace, { settingPrefixes: [], eventTypePrefixes: [] });
    const counts = target.importSnapshot({ ...snapshot, workspaceId: toWorkspace, tables: imported });
    for (const row of keptRows) target.setSetting(toWorkspace, row.key, row.value);
    return counts;
  });
  target.close();
  for (const [from, to] of folders) cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  if (existsSync(portraitFrom)) { rmSync(portraitTo, { recursive: true, force: true }); cpSync(portraitFrom, portraitTo, { recursive: true }); }
  console.log(JSON.stringify({ imported: Object.fromEntries(Object.entries(result).filter(([, n]) => n)) }));
} else {
  raw.close();
  target.close();
}
rmSync(staging, { recursive: true, force: true });
