/**
 * Copies what Codex remembers across runs out of the Crossline CODEX_HOME, for `backup-crossline.ps1`: the `memories` folder and
 * `memories_1.sqlite`. Settings → 连接与账号 says plainly that this memory changes later answers and that it lived outside every
 * backup; a restored ledger with a model that has forgotten everything it learned about the person is not the same system.
 *
 * Login tokens (`auth.json`) are deliberately not copied: a backup is a file that travels, and a credential does not belong in one.
 * The database is copied with SQLite's online backup, which is safe while the runtime has it open.
 *
 *   pnpm exec tsx scripts/copy-codex-memory.ts <target directory>
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const [, , target] = process.argv;
if (!target) { console.error("用法: tsx scripts/copy-codex-memory.ts <target directory>"); process.exit(1); }
const home = process.env.CROSSLINE_CODEX_HOME ?? path.join(process.env.LOCALAPPDATA ?? "", "Crossline", "codex-home");
mkdirSync(target, { recursive: true });
const copied: string[] = [];
const folder = path.join(home, "memories");
if (existsSync(folder)) { cpSync(folder, path.join(target, "memories"), { recursive: true }); copied.push("memories/"); }
const database = path.join(home, "memories_1.sqlite");
if (existsSync(database)) {
  const source = new Database(database, { readonly: true, fileMustExist: true });
  await source.backup(path.join(target, "memories_1.sqlite"));
  source.close();
  copied.push("memories_1.sqlite");
}
console.log(JSON.stringify({ status: "ok", home, copied }));
