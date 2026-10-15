import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

/**
 * Where an installed copy keeps everything (docs/local-installer.md): `app\` is what the installer writes and an update replaces,
 * `data\` is the person's (CROSSLINE_DATA_DIR), `state\` holds their own Codex login and memories and the Outlook sign-in cache
 * (CROSSLINE_STATE_DIR — apart from the `codex-home\`, `auth\` and `runtimes\` a checkout's resident app keeps beside it on the
 * owner's machine), and `launcher.json` is the launcher's own choices. An update replaces `app\` only.
 */
export type Layout = { root: string; app: string; data: string; state: string; logs: string; config: string; secrets: string; backups: string };

export function layoutFor(appDir: string, env: NodeJS.ProcessEnv = process.env): Layout {
  const local = env.CROSSLINE_LAUNCHER_ROOT ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Crossline") : undefined);
  if (!local) throw new Error("LOCALAPPDATA_UNAVAILABLE");
  const data = path.join(local, "data");
  return { root: local, app: appDir, data, state: path.join(local, "state"), logs: path.join(data, "logs"), config: path.join(local, "launcher.json"),
    secrets: path.join(data, "launcher-secrets.json"), backups: path.join(local, "backups") };
}

/** Baked into `app\release.json` by `scripts/package-installer.ts`: what this build is and where it reports and updates from. */
export type Release = { version: string; telemetryUrl?: string; updateFeed?: string; msClientId?: string; msTenantId?: string };

export function readRelease(appDir: string): Release {
  try {
    const parsed = JSON.parse(readFileSync(path.join(appDir, "release.json"), "utf8")) as Partial<Release>;
    if (typeof parsed.version === "string" && parsed.version) return parsed as Release;
  } catch { /* a development run has none */ }
  return { version: "0.0.0-dev" };
}

export type LauncherConfig = {
  installId: string;
  webPort: number;
  supervisorPort: number;
  /** The version that last ran here, so a start after an update can tell. */
  version: string;
};

export type Secrets = { betterAuthSecret: string; capabilitySecret: string; telemetrySalt: string };

function readJson<T>(file: string): Partial<T> | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as Partial<T>; } catch { return undefined; }
}

/** Written to a temporary file and renamed, so a crash mid-write never leaves half a file the next start cannot read. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode });
  renameSync(temporary, file);
}

export function readConfig(file: string): Partial<LauncherConfig> {
  return readJson<LauncherConfig>(file) ?? {};
}

/** The secrets are made once per install and never leave the data folder; a lost file only signs everyone out. */
export function ensureSecrets(file: string): Secrets {
  const saved = readJson<Secrets>(file);
  if (saved?.betterAuthSecret && saved.capabilitySecret && saved.telemetrySalt) return saved as Secrets;
  const fresh: Secrets = {
    betterAuthSecret: saved?.betterAuthSecret ?? randomBytes(32).toString("base64url"),
    capabilitySecret: saved?.capabilitySecret ?? randomBytes(32).toString("base64url"),
    telemetrySalt: saved?.telemetrySalt ?? randomBytes(16).toString("base64url")
  };
  writeJsonAtomic(file, fresh, 0o600);
  return fresh;
}

export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * The web port is the app's origin, so it is kept for as long as it stays free: a new port is a new origin, and the browser keeps
 * cookies, the offline queue and the installed PWA per origin. Candidates come from one fixed range rather than the OS's ephemeral
 * ports, which other programs are handed all the time. A machine can hold that whole range without a visible listener (the owner's
 * did: 44000–47350 all answered EADDRINUSE), so when nothing in it is free the OS is asked for a port, which is then kept the same way.
 */
export const PORT_RANGE = { first: 47210, last: 47299 } as const;

/**
 * Ports browsers (and Node's fetch) refuse to connect to, from the Fetch standard's "bad port" list: an app served on one cannot be
 * opened at all. The OS hands them out like any other — the owner's machine gave 4190 (sieve) and the page never loaded.
 */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** A port the OS says is free on loopback right now. */
export function anyFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("LAUNCHER_NO_FREE_PORT")));
    });
  });
}

export async function choosePorts(saved: Partial<LauncherConfig>, free: (port: number) => Promise<boolean> = portFree,
  any: () => Promise<number> = anyFreePort): Promise<{ webPort: number; supervisorPort: number }> {
  const taken = new Set<number>();
  const pick = async (preferred: number | undefined): Promise<number> => {
    if (preferred && !taken.has(preferred) && !BLOCKED_PORTS.has(preferred) && await free(preferred)) { taken.add(preferred); return preferred; }
    for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port += 1) {
      if (taken.has(port)) continue;
      if (await free(port)) { taken.add(port); return port; }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await any();
      if (!taken.has(port) && !BLOCKED_PORTS.has(port)) { taken.add(port); return port; }
    }
    throw new Error("LAUNCHER_NO_FREE_PORT");
  };
  const webPort = await pick(saved.webPort);
  const supervisorPort = await pick(saved.supervisorPort);
  return { webPort, supervisorPort };
}

/** Reads `launcher.json`, fills what is missing (first run), re-picks a port another program took, and writes it back. */
export async function prepareConfig(layout: Layout, release: Release, free?: (port: number) => Promise<boolean>, any?: () => Promise<number>):
  Promise<{ config: LauncherConfig; firstRun: boolean; upgradedFrom?: string }> {
  const firstRun = !existsSync(layout.config);
  const saved = readConfig(layout.config);
  const ports = await choosePorts(saved, free, any);
  const config: LauncherConfig = {
    installId: saved.installId ?? randomUUID(),
    ...ports,
    version: release.version
  };
  writeJsonAtomic(layout.config, config);
  return { config, firstRun, ...(saved.version && saved.version !== release.version ? { upgradedFrom: saved.version } : {}) };
}
