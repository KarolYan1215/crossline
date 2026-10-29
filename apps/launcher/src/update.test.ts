import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { layoutFor } from "./config";
import { generateReleaseKeys, RELEASE_PUBLIC_KEYS, releasePayload, signRelease, verifyRelease, type SignedRelease } from "./release-signature";
import { backupData, BACKUPS_KEPT, checkForUpdate, downloadInstaller, isNewer, readManifest, type UpdateManifest } from "./update";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "crossline-update-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const KEYS = generateReleaseKeys();
const OTHER = generateReleaseKeys();
const PUBLIC = [KEYS.publicKey];
const BYTES = Buffer.from("MZ pretend installer");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const FIELDS = { product: "crossline" as const, version: "0.3.0",
  url: "https://github.com/KarolYan1215/crossline-releases/releases/download/v0.3.0/Crossline-Setup-0.3.0.exe", sha256: SHA, size: BYTES.length };
const signed = (fields: SignedRelease & Record<string, unknown>, key = KEYS.privateKeyPem) => ({ ...fields, signature: signRelease(fields, key) });
const MANIFEST: UpdateManifest = signed(FIELDS) as UpdateManifest;
const options = { product: "crossline" as const, publicKeys: PUBLIC };

test("versions compare by number, and a development build is older than any release", () => {
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  expect(isNewer("0.2.0", "0.0.0-dev")).toBe(true);
});

test("a signature covers every field, in a fixed form, and only the matching key verifies it", () => {
  const signature = signRelease(FIELDS, KEYS.privateKeyPem);
  expect(verifyRelease(FIELDS, signature, PUBLIC)).toBe(true);
  expect(verifyRelease(FIELDS, signature, [OTHER.publicKey])).toBe(false);
  expect(verifyRelease({ ...FIELDS, size: FIELDS.size + 1 }, signature, PUBLIC)).toBe(false);
  expect(verifyRelease({ ...FIELDS, product: "crossline-node" }, signature, PUBLIC)).toBe(false);
  expect(verifyRelease(FIELDS, "", PUBLIC)).toBe(false);
  expect(verifyRelease(FIELDS, signature, ["not a key"])).toBe(false);
  // A newline in a value cannot forge another line of the payload.
  expect(releasePayload({ ...FIELDS, notice: "a\nurl=https://evil.example" }).toString()).not.toContain("\nurl=https://evil");
});

test("the programs carry no key until the owner makes one, and then no update is ever taken unsigned", () => {
  // Shipped empty on purpose (docs/local-installer.md): `scripts/release-sign.ts keygen` prints the key that goes here.
  expect(Array.isArray(RELEASE_PUBLIC_KEYS)).toBe(true);
  expect(() => readManifest(MANIFEST, { product: "crossline", publicKeys: [] })).toThrow("UPDATE_SIGNING_KEY_MISSING");
});

test("a manifest is used only when signed by the carried key, for this product, with an https GitHub download and a real hash", () => {
  expect(readManifest(MANIFEST, options)).toEqual(MANIFEST);
  const { signature: _drop, ...unsigned } = MANIFEST;
  expect(() => readManifest(unsigned, options)).toThrow("UPDATE_SIGNATURE_MISSING");
  // Tampered after signing: another URL, hash or size under the old signature.
  expect(() => readManifest({ ...MANIFEST, url: "https://github.com/someone/else/releases/download/v0.3.0/x.exe" }, options)).toThrow("UPDATE_SIGNATURE_INVALID");
  expect(() => readManifest({ ...MANIFEST, sha256: "0".repeat(64) }, options)).toThrow("UPDATE_SIGNATURE_INVALID");
  expect(() => readManifest({ ...MANIFEST, version: "9.9.9" }, options)).toThrow("UPDATE_SIGNATURE_INVALID");
  // Signed by another key, or carried keys replaced.
  expect(() => readManifest(signed(FIELDS, OTHER.privateKeyPem), options)).toThrow("UPDATE_SIGNATURE_INVALID");
  expect(() => readManifest(MANIFEST, { product: "crossline", publicKeys: [OTHER.publicKey] })).toThrow("UPDATE_SIGNATURE_INVALID");
  // A node manifest never installs the full app, nor the other way round.
  expect(() => readManifest(signed({ ...FIELDS, product: "crossline-node" }), options)).toThrow("UPDATE_PRODUCT_MISMATCH");
  // Signed but unusable: the old checks still hold.
  expect(() => readManifest(signed({ ...FIELDS, url: "http://github.com/x.exe" }), options)).toThrow("UPDATE_FEED_INVALID");
  expect(() => readManifest(signed({ ...FIELDS, url: "https://evil.example/x.exe" }), options)).toThrow("UPDATE_FEED_INVALID");
  expect(() => readManifest(signed({ ...FIELDS, sha256: "abc" }), options)).toThrow("UPDATE_FEED_INVALID");
  expect(() => readManifest(signed({ ...FIELDS, size: 0 }), options)).toThrow("UPDATE_FEED_INVALID");
});

test("the feed offers only a newer version, says the product's last word when it has one, and says why when it cannot be read", async () => {
  const feed = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  expect(await checkForUpdate("https://x/latest.json", "0.2.0", { ...options, fetcher: feed(MANIFEST) })).toEqual({ kind: "update", manifest: MANIFEST });
  expect(await checkForUpdate("https://x/latest.json", "0.3.0", { ...options, fetcher: feed(MANIFEST) })).toEqual({ kind: "none" });
  const last = signed({ product: "crossline", version: "0.3.0", discontinued: true, notice: "本机版已停止更新，数据仍在原处。", link: "https://app.crossline.lol/settings" });
  expect(await checkForUpdate("https://x/latest.json", "0.3.0", { ...options, fetcher: feed(last) }))
    .toEqual({ kind: "discontinued", version: "0.3.0", notice: "本机版已停止更新，数据仍在原处。", link: "https://app.crossline.lol/settings" });
  await expect(checkForUpdate("https://x/latest.json", "0.3.0", { ...options, fetcher: feed({ ...last, notice: "改过的话" }) })).rejects.toThrow("UPDATE_SIGNATURE_INVALID");
  await expect(checkForUpdate("https://x/latest.json", "0.2.0", { ...options, fetcher: feed({}, 404) })).rejects.toThrow("UPDATE_FEED_HTTP_404");
  await expect(checkForUpdate("https://x/latest.json", "0.2.0", { ...options, fetcher: feed({ version: "x" }) })).rejects.toThrow("UPDATE_FEED_INVALID");
});

test("the installer is kept only if it is byte for byte the one the signed manifest names, through GitHub's own redirects", async () => {
  const root = temp();
  const hops: string[] = [];
  const github = (async (url: string | URL | Request) => {
    hops.push(String(url));
    if (String(url).startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/a/b" } });
    return new Response(new Uint8Array(BYTES));
  }) as typeof fetch;
  const file = await downloadInstaller(MANIFEST, root, { publicKeys: PUBLIC, fetcher: github });
  expect(readFileSync(file).equals(BYTES)).toBe(true);
  expect(path.basename(file)).toBe("Crossline-Setup-0.3.0.exe");
  expect(hops).toHaveLength(2);
  const resign = (fields: Partial<UpdateManifest>) => signed({ ...FIELDS, ...fields }) as UpdateManifest;
  await expect(downloadInstaller(resign({ sha256: "0".repeat(64) }), root, { publicKeys: PUBLIC, fetcher: github })).rejects.toThrow("UPDATE_DOWNLOAD_HASH_MISMATCH");
  await expect(downloadInstaller(resign({ size: BYTES.length + 1 }), root, { publicKeys: PUBLIC, fetcher: github })).rejects.toThrow("UPDATE_DOWNLOAD_SIZE_MISMATCH");
  const elsewhere = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.exe" } })) as typeof fetch;
  await expect(downloadInstaller(MANIFEST, root, { publicKeys: PUBLIC, fetcher: elsewhere })).rejects.toThrow("UPDATE_DOWNLOAD_HOST_REFUSED");
  // A manifest that did not pass the signature check is never fetched at all.
  hops.length = 0;
  await expect(downloadInstaller({ ...MANIFEST, sha256: "1".repeat(64) }, root, { publicKeys: PUBLIC, fetcher: github })).rejects.toThrow("UPDATE_SIGNATURE_INVALID");
  await expect(downloadInstaller(MANIFEST, root, { publicKeys: [OTHER.publicKey], fetcher: github })).rejects.toThrow("UPDATE_SIGNATURE_INVALID");
  await expect(downloadInstaller(MANIFEST, root, { publicKeys: [], fetcher: github })).rejects.toThrow("UPDATE_SIGNATURE_INVALID");
  expect(hops).toHaveLength(0);
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
