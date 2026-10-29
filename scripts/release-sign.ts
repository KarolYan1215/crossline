/**
 * Signs update manifests with Ed25519 (docs/local-installer.md 「更新」; apps/launcher/src/release-signature.ts). The private key never
 * lives in this repository: it is made once into a file the owner names, and read from the path in `CROSSLINE_RELEASE_KEY` when signing.
 *
 *   pnpm exec tsx scripts/release-sign.ts keygen --out D:\keys\crossline-release.pem
 *       makes a key pair; writes the private key there (refused inside the repository or over an existing file) and prints the public
 *       key to put in RELEASE_PUBLIC_KEYS (apps/launcher/src/release-signature.ts).
 *   $env:CROSSLINE_RELEASE_KEY='D:\keys\crossline-release.pem'; pnpm exec tsx scripts/release-sign.ts sign dist\node-installer\node-latest.json
 *       adds `signature` to a manifest the packaging scripts wrote (they call `signManifestFile` themselves when the variable is set).
 *   … release-sign.ts discontinued --product crossline --version 0.3.0 --notice "…" [--link https://…] --out latest.json
 *       writes a product's signed last word instead of an installer (the full installed copy, 2026-10-28).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateReleaseKeys, RELEASE_PUBLIC_KEYS, rawPublicKey, signRelease, verifyRelease, type ReleaseProduct, type SignedRelease }
  from "../apps/launcher/src/release-signature";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** Whether a path is inside this repository (or any worktree under it), following links where the path already exists. */
export function insideRepository(file: string, root = repoRoot): boolean {
  const real = (target: string) => { try { return realpathSync(target); } catch { return path.resolve(target); } };
  const resolved = existsSync(file) ? real(file) : path.join(real(path.dirname(path.resolve(file))), path.basename(file));
  const relative = path.relative(real(root), resolved);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function privateKey(): string {
  const file = process.env.CROSSLINE_RELEASE_KEY;
  if (!file) throw new Error("RELEASE_KEY_NOT_SET: set CROSSLINE_RELEASE_KEY to the private key file made by `release-sign.ts keygen`");
  if (insideRepository(file)) throw new Error("RELEASE_KEY_INSIDE_REPOSITORY: keep the private key outside the repository");
  const pem = readFileSync(file, "utf8");
  const publicKey = rawPublicKey(pem);
  if (!RELEASE_PUBLIC_KEYS.includes(publicKey)) {
    console.warn(`release-sign: this key's public half (${publicKey}) is not in RELEASE_PUBLIC_KEYS; programs built from this checkout will refuse it`);
  }
  return pem;
}

/** The fields of a manifest that a signature covers, as written in it. */
function fieldsOf(raw: Record<string, unknown>): SignedRelease {
  if (raw.product !== "crossline" && raw.product !== "crossline-node") throw new Error("MANIFEST_PRODUCT_MISSING");
  if (typeof raw.version !== "string") throw new Error("MANIFEST_VERSION_MISSING");
  return { product: raw.product, version: raw.version,
    ...(typeof raw.url === "string" ? { url: raw.url } : {}), ...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}),
    ...(typeof raw.size === "number" ? { size: raw.size } : {}), ...(raw.discontinued === true ? { discontinued: true } : {}),
    ...(typeof raw.notice === "string" ? { notice: raw.notice } : {}), ...(typeof raw.link === "string" ? { link: raw.link } : {}) };
}

/** Adds `signature` to a manifest file in place, and checks it back. */
export function signManifestFile(file: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const fields = fieldsOf(raw);
  const pem = privateKey();
  const signature = signRelease(fields, pem);
  if (!verifyRelease(fields, signature, [rawPublicKey(pem)])) throw new Error("RELEASE_SIGNATURE_SELF_CHECK_FAILED");
  const signed = { ...raw, signature };
  writeFileSync(file, `${JSON.stringify(signed, null, 2)}\n`);
  return signed;
}

const option = (args: string[], name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };

async function main(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "keygen") {
    const out = option(args, "out");
    if (!out) throw new Error("usage: release-sign.ts keygen --out <private key file outside the repository>");
    if (insideRepository(out)) throw new Error("RELEASE_KEY_INSIDE_REPOSITORY: choose a path outside the repository");
    if (existsSync(out)) throw new Error("RELEASE_KEY_EXISTS: refusing to overwrite an existing key");
    const keys = generateReleaseKeys();
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, keys.privateKeyPem, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ privateKey: path.resolve(out), publicKey: keys.publicKey,
      next: "put publicKey into RELEASE_PUBLIC_KEYS in apps/launcher/src/release-signature.ts; back the private key up offline" }, null, 2));
    return;
  }
  if (command === "sign") {
    const file = args[1];
    if (!file) throw new Error("usage: release-sign.ts sign <manifest.json>");
    console.log(JSON.stringify(signManifestFile(file), null, 2));
    return;
  }
  if (command === "discontinued") {
    const product = option(args, "product") as ReleaseProduct | undefined;
    const version = option(args, "version"), notice = option(args, "notice"), out = option(args, "out"), link = option(args, "link");
    if (!product || !version || !notice || !out) throw new Error("usage: release-sign.ts discontinued --product crossline --version x.y.z --notice … --out file [--link https://…]");
    if (link && !link.startsWith("https://")) throw new Error("LINK_NOT_HTTPS");
    writeFileSync(out, `${JSON.stringify({ product, version, discontinued: true, notice, ...(link ? { link } : {}) }, null, 2)}\n`);
    console.log(JSON.stringify(signManifestFile(out), null, 2));
    return;
  }
  throw new Error("usage: release-sign.ts keygen|sign|discontinued …");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
