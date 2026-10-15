import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { layoutFor } from "./config";
import { backupData, BACKUPS_KEPT, checkForUpdate, downloadInstaller, isNewer, readManifest } from "./update";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "crossline-update-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const BYTES = Buffer.from("MZ pretend installer");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const MANIFEST = { version: "0.3.0", url: "https://github.com/KarolYan1215/crossline-releases/releases/download/v0.3.0/Crossline-Setup-0.3.0.exe",
  sha256: SHA, size: BYTES.length };

test("versions compare by number, and a development build is older than any release", () => {
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  expect(isNewer("0.2.0", "0.0.0-dev")).toBe(true);
});

test("a manifest is used only with an https GitHub download, a real hash and a sane size", () => {
  expect(readManifest(MANIFEST)).toEqual(MANIFEST);
  expect(readManifest({ ...MANIFEST, url: "http://github.com/x.exe" })).toBeUndefined();
  expect(readManifest({ ...MANIFEST, url: "https://evil.example/x.exe" })).toBeUndefined();
  expect(readManifest({ ...MANIFEST, sha256: "abc" })).toBeUndefined();
  expect(readManifest({ ...MANIFEST, size: 0 })).toBeUndefined();
});

test("the feed offers only a newer version, and says why when it cannot be read", async () => {
  const feed = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  expect(await checkForUpdate("https://x/latest.json", "0.2.0", feed(MANIFEST))).toEqual(MANIFEST);
  expect(await checkForUpdate("https://x/latest.json", "0.3.0", feed(MANIFEST))).toBeUndefined();
  await expect(checkForUpdate("https://x/latest.json", "0.2.0", feed({}, 404))).rejects.toThrow("UPDATE_FEED_HTTP_404");
  await expect(checkForUpdate("https://x/latest.json", "0.2.0", feed({ version: "x" }))).rejects.toThrow("UPDATE_FEED_INVALID");
});

test("the installer is kept only if it is byte for byte the one the manifest names, through GitHub's own redirects", async () => {
  const root = temp();
  const hops: string[] = [];
  const github = (async (url: string | URL | Request) => {
    hops.push(String(url));
    if (String(url).startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/a/b" } });
    return new Response(new Uint8Array(BYTES));
  }) as typeof fetch;
  const file = await downloadInstaller(MANIFEST, root, github);
  expect(readFileSync(file).equals(BYTES)).toBe(true);
  expect(hops).toHaveLength(2);
  await expect(downloadInstaller({ ...MANIFEST, sha256: "0".repeat(64) }, root, github)).rejects.toThrow("UPDATE_DOWNLOAD_HASH_MISMATCH");
  await expect(downloadInstaller({ ...MANIFEST, size: BYTES.length + 1 }, root, github)).rejects.toThrow("UPDATE_DOWNLOAD_SIZE_MISMATCH");
  const elsewhere = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.exe" } })) as typeof fetch;
  await expect(downloadInstaller(MANIFEST, root, elsewhere)).rejects.toThrow("UPDATE_DOWNLOAD_HOST_REFUSED");
});

test("the data folder is copied aside before an update, without its logs, and only the newest backups are kept", () => {
  const root = temp();
  const layout = layoutFor(path.join(root, "app"), { CROSSLINE_LAUNCHER_ROOT: root });
  mkdirSync(layout.logs, { recursive: true });
  writeFileSync(path.join(layout.data, "crossline.db"), "ledger");
  writeFileSync(path.join(layout.logs, "web.log"), "noise");
  const made: string[] = [];
  for (let index = 0; index < BACKUPS_KEPT + 2; index += 1) made.push(backupData(layout, "0.2.0", new Date(Date.UTC(2026, 9, 13, 12, index))));
  const last = made.at(-1)!;
  expect(readFileSync(path.join(last, "crossline.db"), "utf8")).toBe("ledger");
  expect(existsSync(path.join(last, "logs"))).toBe(false);
  expect(readdirSync(layout.backups).sort()).toEqual(made.slice(-BACKUPS_KEPT).map((dir) => path.basename(dir)).sort());
});
