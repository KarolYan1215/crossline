import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Layout } from "./config";
import { RELEASE_PUBLIC_KEYS, verifyRelease, type ReleaseProduct, type SignedRelease } from "./release-signature";

/**
 * Updates (docs/local-installer.md, 更新). The public releases repository serves a manifest — product, version, installer URL, SHA-256,
 * size and an Ed25519 signature over all of them (release-signature.ts) — written by the packaging scripts and signed by
 * `scripts/release-sign.ts`. The launcher (and the standalone node, which bundles this file) reads it, says when a newer version exists,
 * and on the person's word downloads the installer and checks it byte for byte against the signed manifest before anything runs it.
 * An unsigned or wrongly signed manifest is refused, never treated as "no update": the person is told the update could not be checked.
 *
 * A manifest may instead say the product is no longer published (`discontinued`, signed the same way): the full installed copy's
 * last word (2026-10-28), shown once and never acted on.
 */
export type UpdateManifest = { product: ReleaseProduct; version: string; url: string; sha256: string; size: number; signature: string };
export type UpdateCheck = { kind: "none" } | { kind: "update"; manifest: UpdateManifest }
  | { kind: "discontinued"; version: string; notice: string; link?: string };
export type UpdateOptions = { product: ReleaseProduct; publicKeys?: readonly string[]; fetcher?: typeof fetch };

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

function httpsOn(value: unknown, hosts?: Set<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (!hosts || hosts.has(url.hostname)) ? url.toString() : undefined;
  } catch { return undefined; }
}

/**
 * What a feed says, once its signature checks out; throws with a code otherwise. The signature is checked over the fields as written
 * in the manifest (before any normalising), so a manifest edited after signing — a different URL, hash, size or product — fails.
 */
export function readManifest(value: unknown, options: { product: ReleaseProduct; publicKeys?: readonly string[] }):
  UpdateManifest | Extract<UpdateCheck, { kind: "discontinued" }> {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.version !== "string" || !VERSION.test(raw.version)) throw new Error("UPDATE_FEED_INVALID");
  if (raw.product !== "crossline" && raw.product !== "crossline-node") throw new Error("UPDATE_FEED_INVALID");
  if (raw.product !== options.product) throw new Error("UPDATE_PRODUCT_MISMATCH");
  if (typeof raw.signature !== "string" || !raw.signature) throw new Error("UPDATE_SIGNATURE_MISSING");
  const keys = options.publicKeys ?? RELEASE_PUBLIC_KEYS;
  if (!keys.length) throw new Error("UPDATE_SIGNING_KEY_MISSING");
  const fields: SignedRelease = { product: raw.product, version: raw.version,
    ...(typeof raw.url === "string" ? { url: raw.url } : {}), ...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}),
    ...(typeof raw.size === "number" ? { size: raw.size } : {}), ...(raw.discontinued === true ? { discontinued: true } : {}),
    ...(typeof raw.notice === "string" ? { notice: raw.notice } : {}), ...(typeof raw.link === "string" ? { link: raw.link } : {}) };
  if (!verifyRelease(fields, raw.signature, keys)) throw new Error("UPDATE_SIGNATURE_INVALID");
  if (fields.discontinued) {
    if (!fields.notice?.trim()) throw new Error("UPDATE_FEED_INVALID");
    const link = httpsOn(fields.link);
    return { kind: "discontinued", version: fields.version, notice: fields.notice.trim().slice(0, 400), ...(link ? { link } : {}) };
  }
  const url = httpsOn(fields.url, ALLOWED_HOSTS);
  if (!url || typeof fields.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(fields.sha256) || typeof fields.size !== "number" || fields.size <= 0
    || fields.size > INSTALLER_MAX_BYTES) throw new Error("UPDATE_FEED_INVALID");
  return { product: fields.product, version: fields.version, url, sha256: fields.sha256, size: fields.size, signature: raw.signature };
}

/** Whether there is a newer signed release, the product's last word, or nothing; throws with a code when the feed cannot be trusted. */
export async function checkForUpdate(feed: string, current: string, options: UpdateOptions): Promise<UpdateCheck> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(feed, { signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } }).catch(() => undefined);
  if (!response?.ok) throw new Error(response ? `UPDATE_FEED_HTTP_${response.status}` : "UPDATE_FEED_NETWORK");
  const read = readManifest(await response.json().catch(() => undefined), options);
  if ("kind" in read) return read;
  return isNewer(read.version, current) ? { kind: "update", manifest: read } : { kind: "none" };
}

/**
 * Downloads the installer into `<root>\updates` and keeps it only if its size and SHA-256 are the signed manifest's. The signature is
 * checked again first, so a manifest that did not come through `readManifest` is never downloaded. Every redirect is followed by hand
 * so each hop is checked against the same hosts.
 */
export async function downloadInstaller(manifest: UpdateManifest, root: string,
  options: { publicKeys?: readonly string[]; fetcher?: typeof fetch; fileName?: string } = {}): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const signed: SignedRelease = { product: manifest.product, version: manifest.version, url: manifest.url, sha256: manifest.sha256, size: manifest.size };
  if (!verifyRelease(signed, manifest.signature, options.publicKeys ?? RELEASE_PUBLIC_KEYS)) throw new Error("UPDATE_SIGNATURE_INVALID");
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
  const file = path.join(dir, `${options.fileName ?? "Crossline-Setup"}-${manifest.version}.exe`);
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
