import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `codex-code-mode-host` links V8 through the `v8` crate, whose build script downloads a prebuilt static library. The flavour the
 * runtime needs (pointer compression + sandbox, from `code-mode-runtime`'s `v8_enable_sandbox`) is not published by denoland — its
 * URL answers 404 — so upstream builds it itself and publishes it on openai/codex under `rusty-v8-v<version>`, pinning the checksum
 * manifest's own hash in-repo (`vendor/codex/third_party/v8/rusty_v8_<version>_release_manifests.sha256`). This does exactly what
 * upstream's `.github/actions/setup-rusty-v8` does: fetch the manifest, check it against the pinned hash, fetch the archive and the
 * binding, check both against the manifest. Prints the two environment variables a Cargo build then needs.
 *
 *   pnpm exec tsx scripts/fetch-rusty-v8.ts
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const codexRoot = path.join(repoRoot, "vendor", "codex");
const target = "x86_64-pc-windows-msvc";
const profile = "ptrcomp_sandbox_release";

const lock = readFileSync(path.join(codexRoot, "codex-rs", "Cargo.lock"), "utf8");
const version = /\[\[package\]\]\r?\nname = "v8"\r?\nversion = "([^"]+)"/.exec(lock)?.[1];
if (!version) throw new Error("V8_VERSION_NOT_IN_LOCKFILE");
const trusted = readFileSync(path.join(codexRoot, "third_party", "v8", `rusty_v8_${version.replaceAll(".", "_")}_release_manifests.sha256`), "utf8");

const base = `https://github.com/openai/codex/releases/download/rusty-v8-v${version}`;
const names = { archive: `rusty_v8_${profile}_${target}.lib.gz`, binding: `src_binding_${profile}_${target}.rs`, checksums: `rusty_v8_${profile}_${target}.sha256` };
const outDir = path.join(codexRoot, "codex-rs", "target", "rusty_v8");
mkdirSync(outDir, { recursive: true });

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function download(name: string): Promise<Buffer> {
  const file = path.join(outDir, name);
  if (existsSync(file)) return readFileSync(file);
  const response = await fetch(`${base}/${name}`, { redirect: "follow" });
  if (!response.ok) throw new Error(`V8_DOWNLOAD_FAILED ${name} ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes;
}

const manifest = await download(names.checksums);
const pinned = trusted.split(/\r?\n/).find((line) => line.endsWith(`  ${names.checksums}`))?.split(" ")[0];
if (!pinned || sha256(manifest) !== pinned) throw new Error(`V8_MANIFEST_CHECKSUM_MISMATCH expected ${pinned} got ${sha256(manifest)}`);
const expected = new Map(manifest.toString("utf8").replaceAll("\r", "").trim().split("\n").map((line) => {
  const [hash, name] = line.split(/\s+\*?/); return [name!, hash!] as const;
}));
if (expected.size !== 2) throw new Error("V8_MANIFEST_SHAPE");
for (const name of [names.archive, names.binding]) {
  const bytes = await download(name);
  if (sha256(bytes) !== expected.get(name)) throw new Error(`V8_ARTIFACT_CHECKSUM_MISMATCH ${name}`);
}
console.log(JSON.stringify({ RUSTY_V8_ARCHIVE: path.join(outDir, names.archive), RUSTY_V8_SRC_BINDING_PATH: path.join(outDir, names.binding), version }));
