/**
 * Which start items (`readyToStart`, decided 2026-10-12) each workspace of a ledger still misses — the list the page gate will lead every
 * person to once it is live, since no existing account is exempt.
 *
 *   pnpm exec tsx scripts/start-readiness.ts C:\path\to\copy-of-crossline.db
 *
 * Run it on a copy: it refuses the live ledger itself (`data/crossline.db`, or `CROSSLINE_DATA_DIR`'s), because opening a database runs
 * its migrations. It calls no model and changes nothing the app reads.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { startMissing } from "../packages/core/src/index";
import { CrosslineStore, interviewChecklistFor } from "../packages/db/src/index";
import { identityLines } from "../apps/worker/src/lines";

const repoRoot = path.resolve(import.meta.dirname, "..");
const liveDatabase = path.join(path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data")), "crossline.db");
const fail = (code: string, message: string): never => {
  console.error(JSON.stringify({ status: "blocked", code, message }));
  process.exit(1);
};

const target = process.argv.slice(2).find((arg) => arg !== "--");
if (!target) fail("READINESS_DB_REQUIRED", "用法：pnpm exec tsx scripts/start-readiness.ts <账本副本.db>");
const resolved = path.resolve(target!);
// Case-insensitive because this runs on Windows, where two spellings of one path are one file.
if (path.normalize(resolved).toLowerCase() === path.normalize(liveDatabase).toLowerCase())
  fail("READINESS_TARGET_IS_LIVE_LEDGER", "这是正在使用的账本；请先复制到别处，再对副本运行。");
if (!existsSync(resolved)) fail("READINESS_DB_NOT_FOUND", `找不到数据库：${resolved}`);

const store = new CrosslineStore(resolved);
try {
  const today = new Date().toISOString().slice(0, 10);
  for (const workspace of store.listWorkspaces()) {
    const lines = identityLines(store, workspace.id).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
    const missing = startMissing(interviewChecklistFor(store, workspace.id, lines, { unfiledFiles: null, today }));
    console.info(`# ${workspace.name}（${workspace.id}）：${missing.length ? `还差 ${missing.length} 项` : "已达可开始标准"}`);
    for (const item of missing) console.info(`- ${item.label}${item.detail ? `：${item.detail}` : ""}`);
  }
} finally {
  store.close();
}
