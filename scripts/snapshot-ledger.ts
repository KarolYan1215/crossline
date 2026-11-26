// i18n-exempt: a command-line tool for the operator; its output is JSON log lines
/**
 * Takes a consistent copy of a Crossline data directory for `backup-crossline.ps1`, without ever opening the live
 * databases for writing:
 *
 *   - `crossline.db`: SQLite's online backup of the live ledger (every workspace, identity tables included),
 *     integrity-checked and switched to a single self-contained file;
 *   - `auth.db`: the same for Better Auth's own database, when there is one;
 *   - `crossline-<workspace>.json`: one `exportSnapshot` per workspace, taken from a throwaway copy of the ledger,
 *     which is what `pnpm restore` rebuilds and what the restore drill reads back.
 *
 *   pnpm exec tsx scripts/snapshot-ledger.ts <data directory> <output directory>
 *
 * Why not `pnpm export` against the data directory, as the backup used to: `CrosslineStore` runs migrations on open,
 * so pointing this checkout's code at the installed app's live ledger would migrate it with whatever version this
 * checkout is at. And `export` refuses a ledger with more than one workspace, which is how the nightly backup stopped
 * producing files on 2026-10-10 without anyone noticing. Migrations here only ever touch the throwaway copy.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { CrosslineStore } from "../packages/db/src/index";

const fail = (code: string, message: string): never => {
  console.error(JSON.stringify({ status: "blocked", code, message }));
  process.exit(1);
};

const [, , dataArg, outArg] = process.argv;
if (!dataArg || !outArg) fail("ARGS_REQUIRED", "用法: tsx scripts/snapshot-ledger.ts <data directory> <output directory>");
const dataDir = path.resolve(dataArg!);
const outDir = path.resolve(outArg!);
const liveLedger = path.join(dataDir, "crossline.db");
if (!existsSync(liveLedger)) fail("SNAPSHOT_LEDGER_MISSING", `找不到账本：${liveLedger}`);
mkdirSync(outDir, { recursive: true });

/** Online backup from a read-only connection, then an integrity check and DELETE journal mode on the copy only. */
async function copyDatabase(source: string, target: string): Promise<void> {
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try { await live.backup(target); } finally { live.close(); }
  const copy = new Database(target);
  try {
    const result = copy.pragma("integrity_check", { simple: true });
    if (result !== "ok") fail("SNAPSHOT_INTEGRITY_FAILED", `${path.basename(source)} 的副本未通过 integrity_check：${String(result)}`);
    copy.pragma("journal_mode = DELETE");
  } finally { copy.close(); }
}

await copyDatabase(liveLedger, path.join(outDir, "crossline.db"));

let auth: Record<string, number | null> | null = null;
const liveAuth = path.join(dataDir, "auth.db");
if (existsSync(liveAuth)) {
  const target = path.join(outDir, "auth.db");
  await copyDatabase(liveAuth, target);
  const db = new Database(target, { readonly: true });
  auth = Object.fromEntries(["user", "session", "account", "verification"].map((table) => {
    try { return [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]; }
    catch { return [table, null]; }
  }));
  db.close();
}

// Export from a copy of the copy: opening it with CrosslineStore may migrate it and leaves -wal/-shm/.bak files
// beside it, none of which belong in the archive.
const scratch = mkdtempSync(path.join(tmpdir(), "crossline-snapshot-"));
const workspaces: { id: string; events: number; workOrders: number; milestones: number }[] = [];
try {
  const exportDb = path.join(scratch, "crossline.db");
  copyFileSync(path.join(outDir, "crossline.db"), exportDb);
  const store = new CrosslineStore(exportDb);
  try {
    const list = store.listWorkspaces();
    if (list.length === 0) fail("SNAPSHOT_NO_WORKSPACE", "账本里没有任何工作区。");
    for (const workspace of list) {
      const snapshot = store.exportSnapshot(workspace.id);
      writeFileSync(path.join(outDir, `crossline-${workspace.id}.json`), `${JSON.stringify(snapshot, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" });
      workspaces.push({ id: workspace.id, events: snapshot.events.length, workOrders: snapshot.workOrders.length,
        milestones: snapshot.milestones.length });
    }
  } finally { store.close(); }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "snapshot.completed", dataDir, outDir, workspaces, auth }));
