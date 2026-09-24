/**
 * Checkpoints and copies Better Auth's own SQLite file (`auth.db`) — a plain WAL-mode database with no
 * export/import concept of its own, unlike the main ledger. `backup-crossline.ps1` calls this so a backup
 * carries both databases: the main ledger alone restores real workspace data with no way back into it.
 *
 *   pnpm exec tsx scripts/checkpoint-auth-db.ts <source auth.db> <target path>
 */
import { copyFileSync } from "node:fs";
import Database from "better-sqlite3";

const [, , sourcePath, targetPath] = process.argv;
if (!sourcePath || !targetPath) {
  console.error(JSON.stringify({ status: "blocked", code: "ARGS_REQUIRED",
    message: "用法: tsx scripts/checkpoint-auth-db.ts <source auth.db> <target path>" }));
  process.exit(1);
}

const source = new Database(sourcePath, { readonly: false });
// Same reason `CrosslineStore`'s own pre-migration backup does this: copying the file while WAL pages
// have not been folded back into it risks a copy that is missing recent writes.
source.pragma("wal_checkpoint(TRUNCATE)");
source.close();
copyFileSync(sourcePath, targetPath);

const verify = new Database(targetPath, { readonly: true });
const counts = Object.fromEntries(["user", "session", "account", "verification"].map((table) => {
  try { return [table, (verify.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]; }
  catch { return [table, null]; }
}));
verify.close();
console.log(JSON.stringify({ status: "auth_db_checkpoint.completed", sourcePath, targetPath, counts }));
