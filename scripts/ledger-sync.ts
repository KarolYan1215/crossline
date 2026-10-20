/**
 * Keeps the owner's ledger the same on this machine and on the hosted server (docs/ledger-sync.md): whichever side the person
 * last acted on wins and is copied whole over the other. Runs on the owner's Windows machine (it holds the SSH key); the server
 * side is deploy/server/ledger-sync.sh, copied over and run with sudo on each call.
 *
 *   pnpm exec tsx scripts/ledger-sync.ts [--direction auto|to-server|to-local] [--dry-run] [--check]
 *     [--email <server account>] [--workspace <local workspace id>] [--host admin@47.245.88.172] [--key ~/.ssh/crossline_hk]
 *
 * `auto` (the default) compares `lastPersonActivity` on both sides — the person's own latest action, never what the worker wrote —
 * and does nothing when they are equal (which they are right after a sync). `to-server` / `to-local` force a direction. The losing
 * side's ledger is copied aside first (server: /srv/crossline/backups; here: backups/ledger-sync/<stamp>/). The email, the local
 * workspace and the last sync are remembered in data/ledger-sync.json, so the scheduled run (scripts/install-ledger-sync.ps1) takes
 * no arguments. Machine-local settings (model connection, calendar accounts, push, folders, mailboxes) stay on each side:
 * scripts/migrate-workspace.ts --keep-settings.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const repo = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(repo, "data");
const statePath = path.join(dataDir, "ledger-sync.json");
type State = { email?: string; localWorkspace?: string; serverWorkspace?: string; host?: string; key?: string;
  lastSync?: { at: string; direction: string; person: string | null; localChanged?: string | null; serverChanged?: string | null } };
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as State : {};
const email = arg("email") ?? state.email ?? (() => { throw new Error("missing --email: the address signed in on the server"); })();
const localWorkspace = arg("workspace") ?? state.localWorkspace ?? (() => { throw new Error("missing --workspace: the local workspace id"); })();
const host = arg("host") ?? state.host ?? "admin@47.245.88.172";
const key = (arg("key") ?? state.key ?? "~/.ssh/crossline_hk").replace(/^~/, homedir());
const direction = (arg("direction") ?? "auto") as "auto" | "to-server" | "to-local";
const dryRun = flag("dry-run"), check = flag("check");
const ssh = ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "StrictHostKeyChecking=accept-new"];
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

type Stamp = { workspaceId: string; person: string | null; changed: string | null; userVersion: number; counts: Record<string, number> };
const tsx = path.join(repo, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const runLocal = (args: string[], options: { stdio?: "inherit" | "pipe" } = {}) => {
  const result = spawnSync(tsx, args, { cwd: repo, encoding: "utf8", stdio: options.stdio ?? "pipe", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${args[0]} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout ?? "";
};
const remoteDir = "/tmp/crossline-sync";
let scriptSent = false;
const remote = (args: string[], stdio: "inherit" | "pipe" = "pipe") => {
  if (!scriptSent) {
    spawnSync("ssh", [...ssh, host, `mkdir -p ${remoteDir}`], { stdio: "pipe" });
    execFileSync("scp", [...ssh, path.join(repo, "deploy", "server", "ledger-sync.sh"),
      ...["ledger-stamp.ts", "migrate-workspace.ts", "pack-for-server.ts"].map((name) => path.join(repo, "scripts", name)), `${host}:${remoteDir}/`], { stdio: "pipe" });
    scriptSent = true;
  }
  const result = spawnSync("ssh", [...ssh, host, `sudo sh ${remoteDir}/ledger-sync.sh ${args.map((item) => `'${item.replace(/'/g, "'\\''")}'`).join(" ")}`], { encoding: "utf8", stdio });
  if (result.status !== 0) throw new Error(`server ${args[0]} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout ?? "";
};
const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

// 1. Both stamps.
const local = JSON.parse(lastLine(runLocal(["scripts/ledger-stamp.ts", "--db", path.join(dataDir, "crossline.db"), "--workspace", localWorkspace]))) as Stamp;
const server = JSON.parse(lastLine(remote(["stamp", email]))) as Stamp;
log(`local  ${local.workspaceId} person=${local.person} changed=${local.changed} v${local.userVersion} ${JSON.stringify(local.counts)}`);
log(`server ${server.workspaceId} person=${server.person} changed=${server.changed} v${server.userVersion} ${JSON.stringify(server.counts)}`);
if (local.userVersion !== server.userVersion) throw new Error(`SCHEMA_MISMATCH: local v${local.userVersion}, server v${server.userVersion}; deploy the same build on both sides first`);

// 2. The direction: the side the person last acted on. Equal stamps (the normal state after a sync) mean nothing to do.
let chosen: "to-server" | "to-local" | "none";
if (direction !== "auto") chosen = direction;
else if ((local.person ?? "") === (server.person ?? "")) chosen = "none";
else chosen = (local.person ?? "") > (server.person ?? "") ? "to-server" : "to-local";
const losing = chosen === "to-server" ? server : chosen === "to-local" ? local : undefined;
if (losing && losing.person && state.lastSync?.person && losing.person > state.lastSync.person) {
  log(`WARNING: the ${chosen === "to-server" ? "server" : "local"} side has the person's own actions after the last sync (${state.lastSync.person} → ${losing.person}); they are overwritten`);
}
log(`direction ${chosen}${direction === "auto" ? " (by the person's latest action)" : " (forced)"}`);
if (check || chosen === "none" || dryRun) {
  if (chosen !== "none" && !check) log("dry run: nothing written");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
if (chosen === "to-server") {
  // 3a. Pack here, upload, let the server stop its app, back its ledger up, import and start again.
  const out = path.join(tmpdir(), `crossline-transfer-${process.pid}.tgz`);
  runLocal(["scripts/pack-for-server.ts", "--to-email", email, "--workspace", localWorkspace, "--out", out], { stdio: "inherit" });
  log(`uploading ${out}`);
  execFileSync("scp", [...ssh, out, `${host}:/tmp/crossline-transfer.tgz`], { stdio: "inherit" });
  rmSync(out, { force: true });
  remote(["apply"], "inherit");
} else {
  // 3b. The server packs, this machine downloads, stops its own app, backs its ledger up, imports and starts again.
  const remoteOut = "/tmp/crossline-export.tgz";
  remote(["pack", email, remoteOut], "inherit");
  const staging = mkdtempSync(path.join(tmpdir(), "crossline-sync-"));
  const tgz = path.join(staging, "export.tgz");
  execFileSync("scp", [...ssh, `${host}:${remoteOut}`, tgz], { stdio: "inherit" });
  spawnSync("ssh", [...ssh, host, `rm -f ${remoteOut}`]);
  // The system's bsdtar by full path: from Git Bash the first `tar` on PATH is GNU tar, which reads "C:\…" as a remote host.
  const systemTar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(existsSync(systemTar) ? systemTar : "tar", ["-xzf", tgz, "-C", staging], { stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(path.join(staging, "manifest.json"), "utf8")) as { workspaceId: string; fromData: string };
  stopLocalApp();
  try {
    const backupDir = path.join(repo, "backups", "ledger-sync", stamp);
    mkdirSync(backupDir, { recursive: true });
    for (const file of ["crossline.db", "crossline.db-wal", "crossline.db-shm"]) {
      if (existsSync(path.join(dataDir, file))) cpSync(path.join(dataDir, file), path.join(backupDir, file));
    }
    log(`local ledger copied to ${backupDir}`);
    runLocal(["scripts/migrate-workspace.ts", "--from-db", path.join(staging, "crossline.db"), "--from-data", manifest.fromData,
      "--workspace", manifest.workspaceId, "--to-db", path.join(dataDir, "crossline.db"), "--to-data", dataDir,
      "--files", path.join(staging, "files"), "--to-workspace", localWorkspace, "--replace", "--apply"], { stdio: "inherit" });
  } finally {
    startLocalApp();
    rmSync(staging, { recursive: true, force: true });
  }
}
const after = JSON.parse(lastLine(runLocal(["scripts/ledger-stamp.ts", "--db", path.join(dataDir, "crossline.db"), "--workspace", localWorkspace]))) as Stamp;
writeFileSync(statePath, JSON.stringify({ ...state, email, localWorkspace, serverWorkspace: server.workspaceId, host, key: arg("key") ?? state.key,
  lastSync: { at: new Date().toISOString(), direction: chosen, person: after.person, localChanged: after.changed, serverChanged: server.changed } } satisfies State, null, 1));
log(`done: ${chosen}`);

// The resident app runs under two keeper loops (scripts/keep-running.ps1); each keeper's lock holds its PID, and the keeper's
// children (pnpm → node) go with it. The worker's own heartbeat lock names its process too.
function stopLocalApp() {
  if (process.platform !== "win32") throw new Error("stopping the resident app is written for Windows only");
  const pids = new Set<number>();
  for (const name of ["web", "worker"]) {
    const lock = path.join(dataDir, `${name}.keeper.lock`);
    if (existsSync(lock)) { const pid = Number(readFileSync(lock, "utf8").trim()); if (pid) pids.add(pid); }
  }
  const workerLock = path.join(dataDir, "worker.lock");
  if (existsSync(workerLock)) { try { const pid = (JSON.parse(readFileSync(workerLock, "utf8")) as { pid?: number }).pid; if (pid) pids.add(pid); } catch { /* stale */ } }
  const listening = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 3210,3211 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout;
  for (const line of listening.split(/\r?\n/)) { const pid = Number(line.trim()); if (pid) pids.add(pid); }
  for (const pid of pids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  log(`stopped the resident app (${[...pids].join(", ")})`);
}
function startLocalApp() {
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "scripts", "start-crossline.ps1")], { encoding: "utf8" });
  log(`started the resident app: ${(result.stdout ?? "").trim().replace(/\s+/g, " ")}`);
}
