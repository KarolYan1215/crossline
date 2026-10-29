import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/**
 * Signed update manifests (docs/local-installer.md 「更新」, decided 2026-10-28). A manifest's SHA-256 only proves the download is the file
 * the manifest names; whoever can write the manifest (the public releases repository, an account that publishes to it, anything between
 * it and the person) could name any installer. So the manifest itself is signed with Ed25519 by a key kept outside the repository
 * (`CROSSLINE_RELEASE_KEY`, `scripts/release-sign.ts`), and every program that runs a downloaded installer — the installed copy's
 * launcher and the standalone node — carries the public half below and refuses a manifest that is unsigned, signed by another key,
 * edited after signing, or signed for the other product.
 *
 * Shared by the launcher and the node (bundled into both; nothing else of Crossline comes with it).
 */

/**
 * The public keys whose signatures are accepted: raw 32-byte Ed25519 keys in base64, as `scripts/release-sign.ts keygen` prints them.
 * Empty until the owner makes the key pair; with none, every update is refused (`UPDATE_SIGNING_KEY_MISSING`), never accepted unsigned.
 * More than one only while a key is being replaced.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];

/** Which program a manifest is for: a node manifest can never install the full app, nor the other way round. */
export type ReleaseProduct = "crossline" | "crossline-node";

/** Everything a signature covers. A manifest field outside this list is not trusted and not used. */
export type SignedRelease = {
  product: ReleaseProduct;
  version: string;
  url?: string;
  sha256?: string;
  size?: number;
  /** A last word instead of an installer: this product is no longer published (the full installed copy, 2026-10-28). */
  discontinued?: boolean;
  notice?: string;
  link?: string;
};

/** The exact bytes signed: one `name=value` line per field in a fixed order, so JSON key order or spacing can never change the meaning. */
export function releasePayload(fields: SignedRelease): Buffer {
  const line = (name: string, value: string | number | boolean | undefined) => `${name}=${value === undefined ? "" : String(value).replace(/[\r\n]/g, " ")}\n`;
  return Buffer.from(["crossline-release-v1\n", line("product", fields.product), line("version", fields.version), line("url", fields.url),
    line("sha256", fields.sha256), line("size", fields.size), line("discontinued", fields.discontinued ? 1 : 0), line("notice", fields.notice),
    line("link", fields.link)].join(""), "utf8");
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyOf(raw: string): KeyObject | undefined {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) return undefined;
  try { return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: "der", type: "spki" }); } catch { return undefined; }
}

/** The raw public key (base64) of a private key in PEM, for checking that a signing key matches what the programs carry. */
export function rawPublicKey(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" });
  return der.subarray(SPKI_PREFIX.length).toString("base64");
}

/** A new key pair: the private key as PKCS#8 PEM (to be written outside the repository), the public key raw in base64 (to be carried). */
export function generateReleaseKeys(): { privateKeyPem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKeyPem, publicKey: rawPublicKey(privateKeyPem) };
}

export function signRelease(fields: SignedRelease, privateKeyPem: string): string {
  return sign(null, releasePayload(fields), createPrivateKey(privateKeyPem)).toString("base64");
}

/** Whether `signature` is a valid signature of these fields by one of `publicKeys`. */
export function verifyRelease(fields: SignedRelease, signature: string, publicKeys: readonly string[] = RELEASE_PUBLIC_KEYS): boolean {
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length !== 64) return false;
  const payload = releasePayload(fields);
  return publicKeys.some((raw) => {
    const key = publicKeyOf(raw);
    try { return Boolean(key && verify(null, payload, key, bytes)); } catch { return false; }
  });
}
