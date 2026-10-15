import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Layout } from "./config";

/**
 * Updates (docs/local-installer.md, 更新). The public releases repository serves `latest.json` — version, installer URL, SHA-256 and
 * size — written by `scripts/package-installer.ts`. The launcher reads it, says when a newer version exists, and on the person's
 * word downloads the installer, checks it byte for byte against the manifest, stops the app and copies `data\` aside before handing
 * the installer to the tray. The ledger's own migrations back the database up again when the new version first opens it.
 */
export type UpdateManifest = { version: string; url: string; sha256: string; size: number };

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** Only GitHub release downloads: the installer is never fetched from an address the manifest could point anywhere. */
const ALLOWED_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
export const INSTALLER_MAX_BYTES = 400 * 1024 * 1024;
export const BACKUPS_KEPT = 3;

export function isNewer(candidate: string, current: string): boolean {
  const a = VERSION.exec(candidate), b = VERSION.exec(current.replace(/-.*$/, ""));
  if (!a) return false;
  if (!b) return true;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return difference > 0;
  }
  return false;
}

export function readManifest(value: unknown): UpdateManifest | undefined {
  const raw = value as Partial<UpdateManifest> | null;
  if (!raw || typeof raw.version !== "string" || !VERSION.test(raw.version) || typeof raw.url !== "string" || typeof raw.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(raw.sha256) || typeof raw.size !== "number" || raw.size <= 0 || raw.size > INSTALLER_MAX_BYTES) return undefined;
  let url: URL;
  try { url = new URL(raw.url); } catch { return undefined; }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return undefined;
  return { version: raw.version, url: url.toString(), sha256: raw.sha256, size: raw.size };
}

/** The newer release, or undefined when this one is current; throws with a code when the feed cannot be read. */
export async function checkForUpdate(feed: string, current: string, fetcher: typeof fetch = fetch): Promise<UpdateManifest | undefined> {
  const response = await fetcher(feed, { signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } }).catch(() => undefined);
  if (!response?.ok) throw new Error(response ? `UPDATE_FEED_HTTP_${response.status}` : "UPDATE_FEED_NETWORK");
  const manifest = readManifest(await response.json().catch(() => undefined));
  if (!manifest) throw new Error("UPDATE_FEED_INVALID");
  return isNewer(manifest.version, current) ? manifest : undefined;
}

/**
 * Downloads the installer into `<root>\updates` and keeps it only if its size and SHA-256 are the manifest's. Every redirect is
 * followed by hand so each hop is checked against the same hosts.
 */
export async function downloadInstaller(manifest: UpdateManifest, root: string, fetcher: typeof fetch = fetch): Promise<string> {
  let url = manifest.url;
  let response: Response | undefined;
  for (let hop = 0; hop < 5; hop += 1) {
    response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) }).catch(() => undefined);
    if (!response) throw new Error("UPDATE_DOWNLOAD_NETWORK");
    if (response.status < 300 || response.status >= 400) break;
    const next = new URL(response.headers.get("location") ?? "", url);
    if (next.protocol !== "https:" || !ALLOWED_HOSTS.has(next.hostname)) throw new Error("UPDATE_DOWNLOAD_HOST_REFUSED");
    url = next.toString();
    response = undefined;
  }
  if (!response?.ok || !response.body) throw new Error(response ? `UPDATE_DOWNLOAD_HTTP_${response.status}` : "UPDATE_DOWNLOAD_REDIRECTS");
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > manifest.size) { await reader.cancel().catch(() => undefined); throw new Error("UPDATE_DOWNLOAD_SIZE_MISMATCH"); }
    hash.update(value);
    chunks.push(value);
  }
  if (size !== manifest.size) throw new Error("UPDATE_DOWNLOAD_SIZE_MISMATCH");
  if (hash.digest("hex") !== manifest.sha256) throw new Error("UPDATE_DOWNLOAD_HASH_MISMATCH");
  const dir = path.join(root, "updates");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `Crossline-Setup-${manifest.version}.exe`);
  writeFileSync(`${file}.part`, Buffer.concat(chunks));
  renameSync(`${file}.part`, file);
  return file;
}

/**
 * Copies `data\` to `backups\before-<time>-v<version>\` while nothing is running, keeping the newest few. Logs are left out: they
 * are not the person's data and can be large.
 */
export function backupData(layout: Layout, fromVersion: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // Time first, so the names sort oldest to newest whatever the versions are.
  const target = path.join(layout.backups, `before-${stamp}-v${fromVersion}`);
  mkdirSync(layout.backups, { recursive: true });
  if (existsSync(layout.data)) cpSync(layout.data, target, { recursive: true, filter: (source) => path.resolve(source) !== path.resolve(layout.logs) });
  else mkdirSync(target, { recursive: true });
  const kept = readdirSync(layout.backups).filter((name) => name.startsWith("before-")).sort().reverse();
  for (const old of kept.slice(BACKUPS_KEPT)) rmSync(path.join(layout.backups, old), { recursive: true, force: true });
  return target;
}
