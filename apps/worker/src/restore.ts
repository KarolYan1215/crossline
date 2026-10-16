// i18n-exempt: a command-line tool for the operator; its output is JSON log lines
/**
 * Rebuilds a database from an exported snapshot. This is the half of the backup story that proves a
 * backup is usable: decrypting and unzipping a file only shows it is readable, not that a working
 * ledger can come back out of it.
 *
 *   pnpm restore -- C:\path\to\crossline.json [C:\path\to\target.db]
 *
 * It never writes to the live ledger. The target must not already exist, and it must not be the
 * database the app is using — destroying the real ledger during a restore would be the exact failure
 * a backup exists to prevent.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CrosslineStore, type CrosslineSnapshot } from "@crossline/db";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const liveDatabase = path.join(dataDir, "crossline.db");

const fail = (code: string, message: string): never => {
  console.error(JSON.stringify({ status: "blocked", code, message }));
  process.exit(1);
};

// pnpm forwards a literal `--` on some shells and swallows it on others, so the documented
// `pnpm export -- <path>` would otherwise write to a file named `--` when run from a POSIX shell.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const snapshotPath = args[0];
if (!snapshotPath) fail("RESTORE_SNAPSHOT_REQUIRED", "用法：pnpm restore -- <snapshot.json> [target.db]");
const resolvedSnapshot = path.resolve(snapshotPath!);
if (!existsSync(resolvedSnapshot)) fail("RESTORE_SNAPSHOT_NOT_FOUND", `找不到快照文件：${resolvedSnapshot}`);

const targetPath = path.resolve(args[1]
  ?? path.join(repoRoot, "restored", `crossline-${new Date().toISOString().replace(/[:.]/g, "-")}.db`));
// Case-insensitive because this runs on Windows, where two spellings of one path are one file.
if (path.normalize(targetPath).toLowerCase() === path.normalize(liveDatabase).toLowerCase()) {
  fail("RESTORE_TARGET_IS_LIVE_LEDGER",
    "拒绝写入正在使用的账本。恢复只重建到新文件，替换账本必须由人手动完成。");
}
if (existsSync(targetPath)) fail("RESTORE_TARGET_EXISTS", `目标已存在，拒绝覆盖：${targetPath}`);

let parsed: CrosslineSnapshot | undefined;
try {
  parsed = JSON.parse(readFileSync(resolvedSnapshot, "utf8")) as CrosslineSnapshot;
} catch { /* reported below, so the failure reads as one blocked status rather than a stack trace */ }
if (!parsed) fail("RESTORE_SNAPSHOT_UNREADABLE", "快照不是合法 JSON。");
const snapshot = parsed!;

mkdirSync(path.dirname(targetPath), { recursive: true });
const store = new CrosslineStore(targetPath);
try {
  const counts = store.importSnapshot(snapshot);
  // Re-reading through the normal query path is the drill's actual assertion: rows that went in but
  // cannot be read back out are not a restored ledger.
  const verified = store.exportSnapshot(snapshot.workspaceId);
  const mismatches = Object.entries(counts)
    .filter(([table, count]) => (verified.tables[table]?.length ?? -1) !== count)
    .map(([table]) => table);
  if (mismatches.length) {
    fail("RESTORE_VERIFICATION_FAILED", `这些表读回的行数与写入不一致：${mismatches.join(", ")}`);
  }
  console.info(JSON.stringify({
    status: "restore.completed",
    snapshotPath: resolvedSnapshot,
    targetPath,
    workspaceId: snapshot.workspaceId,
    exportedAt: snapshot.exportedAt,
    verified: true,
    counts: {
      events: verified.events.length,
      workOrders: verified.workOrders.length,
      milestones: verified.milestones.length,
      rows: Object.values(counts).reduce((total, count) => total + count, 0)
    }
  }, null, 1));
} catch (error) {
  const message = error instanceof Error ? error.message : "恢复失败。";
  fail(/^[A-Z_]+$/.test(message) ? message : "RESTORE_FAILED", message);
} finally {
  store.close();
}
