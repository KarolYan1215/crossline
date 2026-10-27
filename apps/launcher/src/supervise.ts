import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { LauncherConfig, Layout, Release, Secrets } from "./config";

export type ChildSpec = { name: "web" | "worker"; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/**
 * The installed tree mirrors the repository (`app\apps\web`, `app\apps\worker\dist`, `app\skills`, one hoisted `app\node_modules`),
 * and the worker's bundle sits at the depth of the `src` folder it replaces, so every path the worker derives from its own location
 * still lands where it does in a checkout. Both
 * children run on the `node.exe` shipped beside them, never one on PATH.
 */
export function childSpecs(layout: Layout, config: LauncherConfig, secrets: Secrets, release: Release, base: NodeJS.ProcessEnv = process.env): ChildSpec[] {
  const node = path.join(layout.app, "node.exe");
  const webUrl = `http://127.0.0.1:${config.webPort}`;
  const codex = path.join(layout.app, "codex", "codex.exe");
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: [layout.app, base.PATH ?? base.Path ?? ""].join(path.delimiter),
    NODE_ENV: "production",
    // A tester behind a company proxy or TLS inspection has their certificate in the Windows store, not Node's bundled list; and a
    // proxy set in their environment must never carry the app's own loopback calls (web ↔ worker ↔ Codex supervisor).
    NODE_USE_SYSTEM_CA: "1",
    NO_PROXY: [...new Set([...(base.NO_PROXY ?? base.no_proxy ?? "").split(",").map((host) => host.trim()).filter(Boolean), "localhost", "127.0.0.1", "::1"])].join(","),
    CROSSLINE_INSTALL_MODE: "local",
    // Where Crossline.exe is, for the Run entry Settings → 开机自启 writes (apps/web/lib/autostart.ts).
    CROSSLINE_APP_DIR: layout.app,
    CROSSLINE_DEPLOYMENT_MODE: "local",
    CROSSLINE_APP_VERSION: release.version,
    CROSSLINE_INSTALL_ID: config.installId,
    CROSSLINE_TELEMETRY_SALT: secrets.telemetrySalt,
    ...(release.telemetryUrl ? { CROSSLINE_TELEMETRY_URL: release.telemetryUrl } : {}),
    CROSSLINE_DATA_DIR: layout.data,
    // Codex home, guest homes and the Outlook sign-in cache: this copy's own, never a resident app's on the same machine.
    CROSSLINE_STATE_DIR: layout.state,
    CROSSLINE_NEXT_DIR: ".next-prod",
    BETTER_AUTH_SECRET: secrets.betterAuthSecret,
    CROSSLINE_SUPERVISOR_CAPABILITY_SECRET: secrets.capabilitySecret,
    CROSSLINE_WEB_BASE_URL: webUrl,
    CROSSLINE_WEB_HEALTH_URL: `${webUrl}/api/health`,
    CROSSLINE_CODEX_SUPERVISOR_URL: `http://127.0.0.1:${config.supervisorPort}`,
    CROSSLINE_CODEX_SUPERVISOR_PORT: String(config.supervisorPort),
    CROSSLINE_CODEX_PATH: codex,
    ...(release.msClientId ? { CROSSLINE_MS_CLIENT_ID: release.msClientId, CROSSLINE_MS_TENANT_ID: release.msTenantId ?? "common" } : {})
  };
  // Nothing the developer's own shell exports may change what an installed copy is: it signs in only through Codex.
  for (const key of ["CROSSLINE_SMTP_HOST", "CROSSLINE_GOOGLE_CLIENT_ID", "CROSSLINE_GOOGLE_CLIENT_SECRET", "CROSSLINE_CHATGPT_SIGNIN",
    "CROSSLINE_AUTH_TEST_MAILBOX_DIR", "CROSSLINE_FIXED_NOW", "CROSSLINE_SEED_EXAMPLES", "CROSSLINE_TAILSCALE_HOSTNAME"]) delete env[key];
  return [
    { name: "web", command: node, cwd: path.join(layout.app, "apps", "web"), env,
      args: [path.join(layout.app, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(config.webPort)] },
    // The worker ships compiled (scripts/bundle-installed.ts): one minified module, no TypeScript and no tsx.
    { name: "worker", command: node, cwd: path.join(layout.app, "apps", "worker"), env,
      args: [path.join(layout.app, "apps", "worker", "dist", "index.mjs")] }
  ];
}

/** Doubles from one second up to a minute; a child that stayed up five minutes starts again from one second. */
export function restartDelay(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}
export const STABLE_AFTER_MS = 5 * 60_000;

export type SupervisorEvent =
  | { type: "child.started"; name: string; pid: number | undefined }
  | { type: "child.exited"; name: string; code: number | null; restartInMs: number }
  | { type: "notify"; title: string; text: string; path: string };

/** The one line a child writes to ask the tray for a balloon (docs/onboarding-v3.md 「等待」): `@crossline:notify {"title","text","path"}`. */
export const NOTICE_PREFIX = "@crossline:notify ";

/** A child's notice line, checked: short plain strings and a same-app path only, so a log line can never make the tray open elsewhere. */
export function noticeFrom(line: string): Extract<SupervisorEvent, { type: "notify" }> | undefined {
  if (!line.startsWith(NOTICE_PREFIX)) return undefined;
  try {
    const body = JSON.parse(line.slice(NOTICE_PREFIX.length)) as Record<string, unknown>;
    const short = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
    const title = short(body.title, 60), text = short(body.text, 200), path = short(body.path, 120);
    if (!title || !text || !path || !/^\/[A-Za-z0-9/_-]*$/.test(path)) return undefined;
    return { type: "notify", title, text, path };
  } catch { return undefined; }
}

type Spawn = (spec: ChildSpec, log: { out: NodeJS.WritableStream; err: NodeJS.WritableStream }) => ChildProcess;

const spawnHidden: Spawn = (spec, log) => {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(log.out, { end: false });
  child.stderr?.pipe(log.err, { end: false });
  return child;
};

/** Keeps each child running: a child that exits is started again after `restartDelay`, until `stop()`. */
export class Supervisor {
  #children = new Map<string, ChildProcess>();
  #timers = new Set<NodeJS.Timeout>();
  #stopping = false;

  constructor(private readonly specs: ChildSpec[], private readonly logDir: string,
    private readonly onEvent: (event: SupervisorEvent) => void = () => undefined,
    private readonly spawnChild: Spawn = spawnHidden, private readonly now: () => number = Date.now) {}

  start(): void { for (const spec of this.specs) this.#run(spec, 0); }

  #run(spec: ChildSpec, failures: number): void {
    if (this.#stopping) return;
    mkdirSync(this.logDir, { recursive: true });
    const log = { out: createWriteStream(path.join(this.logDir, `${spec.name}.log`), { flags: "a" }),
      err: createWriteStream(path.join(this.logDir, `${spec.name}.err.log`), { flags: "a" }) };
    // A log file that cannot be opened or written (its folder removed, a full disk) must not take the launcher down: an unheard stream
    // error is an uncaught exception. The child keeps running and its output is lost, which is the lesser harm.
    for (const stream of [log.out, log.err]) stream.on("error", () => undefined);
    const startedAt = this.now();
    const child = this.spawnChild(spec, log);
    this.#children.set(spec.name, child);
    // Notice lines ride the child's ordinary output (it is also logged); each complete line is checked once.
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop()!.slice(-4096);
      for (const line of lines) { const notice = noticeFrom(line); if (notice) this.onEvent(notice); }
    });
    this.onEvent({ type: "child.started", name: spec.name, pid: child.pid });
    let done = false;
    const exited = (code: number | null) => {
      if (done) return;
      done = true;
      this.#children.delete(spec.name);
      log.out.end(); log.err.end();
      if (this.#stopping) return;
      const next = this.now() - startedAt >= STABLE_AFTER_MS ? 1 : failures + 1;
      const delay = restartDelay(next);
      this.onEvent({ type: "child.exited", name: spec.name, code, restartInMs: delay });
      const timer = setTimeout(() => { this.#timers.delete(timer); this.#run(spec, next); }, delay);
      this.#timers.add(timer);
    };
    child.once("exit", (code) => exited(code));
    child.once("error", () => exited(null));
  }

  /** Stops every child and waits (up to `graceMs`) for them to go. */
  async stop(graceMs = 5000): Promise<void> {
    this.#stopping = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    const running = [...this.#children.values()];
    await Promise.all(running.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const force = setTimeout(() => { killTree(child.pid); resolve(); }, graceMs);
      child.once("exit", () => { clearTimeout(force); resolve(); });
      // Windows has no SIGTERM: `kill()` terminates the process, and the tree kill below reaches anything it started (Codex).
      killTree(child.pid);
    })));
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
  else { try { process.kill(pid); } catch { /* already gone */ } }
}

/** Polls the web app's liveness route until it answers or `timeoutMs` passes. */
export async function waitForHealth(url: string, timeoutMs = 180_000, fetcher: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetcher(url, { signal: AbortSignal.timeout(5000) })).ok) return true; } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}
