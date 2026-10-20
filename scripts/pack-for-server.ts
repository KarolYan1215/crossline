/**
 * Packs the owner's local workspace for the hosted server (docs/beta-launch.md §10.6): an online backup of the ledger (the running app
 * is never stopped or written), the `materials`, `sources` and portrait folders, and a manifest naming the workspace, the original data
 * directory (so the server can rewrite the paths stored in the ledger) and the server account it goes to.
 *
 *   pnpm exec tsx scripts/pack-for-server.ts --to-email <address> [--data <dir>] [--workspace <id>] [--out <file.tgz>]
 *
 * Then upload it: scp -i <key> <file.tgz> admin@47.245.88.172:/tmp/crossline-transfer.tgz
 * The server side is `.github/workflows/server.yml` ([migrate] previews, [migrate-apply] writes), which runs scripts/migrate-workspace.ts.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "../packages/db/src/index";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const toEmail = arg("to-email") ?? (() => { throw new Error("missing --to-email: the address you sign in with on the server"); })();
const dataDir = path.resolve(arg("data") ?? path.join(import.meta.dirname, "..", "data"));
const out = path.resolve(arg("out") ?? "crossline-transfer.tgz");
const ledger = path.join(dataDir, "crossline.db");
if (!existsSync(ledger)) throw new Error(`no ledger at ${ledger}; pass --data <dir>`);

const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const staging = path.join(tmpdir(), `crossline-pack-${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(path.join(staging, "files"), { recursive: true });
const live = new Database(ledger, { readonly: true, fileMustExist: true });
await live.backup(path.join(staging, "crossline.db"));
live.close();

const store = new CrosslineStore(path.join(staging, "crossline.db"));
const workspaces = store.listWorkspaces();
const workspaceId = arg("workspace") ?? (workspaces.length === 1 ? workspaces[0]!.id
  : (() => { throw new Error(`${workspaces.length} workspaces: pass --workspace (${workspaces.map((item) => item.id).join(", ")})`); })());
store.close();

const portrait = path.join("portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
const copied: string[] = [];
for (const folder of ["materials", "sources", portrait]) {
  const from = path.join(dataDir, folder);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(staging, "files", folder), { recursive: true });
  copied.push(folder);
}
writeFileSync(path.join(staging, "manifest.json"),
  JSON.stringify({ workspaceId, fromData: dataDir, toEmail, folders: copied, packedAt: new Date().toISOString() }, null, 1));

// Windows 10 and later ship bsdtar as tar.exe; it writes the same gzip archive GNU tar reads on the server. It is named by its full
// path: from Git Bash the first `tar` on PATH is GNU tar, which reads "C:…" as a remote host and fails.
const systemTar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
execFileSync(existsSync(systemTar) ? systemTar : "tar", ["-czf", out, "-C", staging, "."], { stdio: "inherit" });
rmSync(staging, { recursive: true, force: true });
console.log(JSON.stringify({ out, megabytes: +(statSync(out).size / 1048576).toFixed(1), workspaceId, toEmail, folders: copied }, null, 1));
console.log(`next: scp -i <key> "${out}" admin@47.245.88.172:/tmp/crossline-transfer.tgz`);
