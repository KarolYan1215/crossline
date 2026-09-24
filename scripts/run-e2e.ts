import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(repoRoot, "apps", "web");
const node = process.execPath;
const next = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const playwright = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-e2e-"));
// Mirrors the same `path.join(e2eDataDir, "mailbox")` computation `playwright.config.ts` does from
// `CROSSLINE_E2E_DATA_DIR` — this script owns the actual `next start` process on Windows (bypassing
// Playwright's own `webServer`, see below), so it has to set the auth env vars on that process itself
// rather than through the `webServer.env` block, which never runs here.
const authMailboxDir = path.join(dataDir, "mailbox");
const env = {
  ...process.env,
  CROSSLINE_DATA_DIR: dataDir,
  CROSSLINE_E2E_DATA_DIR: dataDir,
  CROSSLINE_E2E_EXTERNAL_SERVER: "1",
  CROSSLINE_NEXT_DIR: ".next-e2e",
  CROSSLINE_FIXED_NOW: "2026-09-14T16:45:00.000Z",
  BETTER_AUTH_SECRET: "e2e-test-secret-not-for-production-use",
  CROSSLINE_WEB_BASE_URL: "http://127.0.0.1:3310",
  CROSSLINE_AUTH_TEST_MAILBOX_DIR: authMailboxDir
};

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function windowsListenerPid(port: number): number | null {
  if (process.platform !== "win32") return null;
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const address = `127.0.0.1:${port}`;
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "TCP" && fields[1] === address && fields[3] === "LISTENING") {
      const pid = Number(fields[4]);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    }
  }
  return null;
}

function stop(processToStop: ChildProcess): void {
  if (process.platform === "win32") {
    const pids = new Set([processToStop.pid, windowsListenerPid(3310)].filter((pid): pid is number => Boolean(pid)));
    for (const pid of pids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  if (processToStop.pid && processToStop.exitCode === null) processToStop.kill("SIGTERM");
}

async function waitForHealth(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`E2E_SERVER_EXITED: ${server.exitCode}`);
    try {
      const response = await fetch("http://127.0.0.1:3310/api/health");
      if (response.ok) return;
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("E2E_SERVER_START_TIMEOUT");
}

if (windowsListenerPid(3310)) throw new Error("E2E_PORT_IN_USE: 127.0.0.1:3310");
run(node, [next, "build", "--webpack"], webRoot);
const server = spawn(node, [next, "start", "--hostname", "127.0.0.1", "--port", "3310"], {
  cwd: webRoot, env, stdio: "inherit"
});
process.once("SIGINT", () => { stop(server); process.exit(130); });
process.once("SIGTERM", () => { stop(server); process.exit(143); });

try {
  await waitForHealth(server);
  run(node, [playwright, "test", ...process.argv.slice(2)], repoRoot);
} finally {
  stop(server);
}
