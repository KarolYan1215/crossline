/**
 * CI provenance check for the Crossline-owned Codex fork.
 *
 * The binary hash is reported as an artifact, not compared with the local runtime hash: Rust output
 * includes build-environment details, so a hosted Windows runner is not a reproducible-binary oracle.
 * The source commit, applied patch and post-bootstrap Cargo.lock hash are portable provenance checks.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Baseline = {
  repository: string;
  commit: string;
  patches: Array<{ path: string; sha256: string }>;
  build: { lockfileSha256: string; binary: string };
  runtimeVersion: string;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const forkFlag = process.argv.indexOf("--fork");
const forkRoot = forkFlag >= 0 ? process.argv[forkFlag + 1] : undefined;
if (!forkRoot) throw new Error("CODEX_FORK_PATH_REQUIRED: pass --fork <checkout>");

const baseline = JSON.parse(readFileSync(path.join(repoRoot, "codex-baseline.json"), "utf8")) as Baseline;
const fork = path.resolve(forkRoot);
const fail = (message: string): never => { throw new Error(`CODEX_FORK_PROVENANCE_FAILED: ${message}`); };
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (command: string, args: string[], cwd = fork) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const repository = (value: string) => value.replace(/\.git\/?$/, "").toLowerCase();

if (!existsSync(fork)) fail(`missing checkout ${fork}`);
if (repository(run("git", ["remote", "get-url", "origin"])) !== repository(baseline.repository)) {
  fail("origin does not match codex-baseline.json");
}
if (run("git", ["rev-parse", "HEAD"]) !== baseline.commit) fail("checkout is not at the pinned commit");
if (run("git", ["status", "--porcelain"]) !== "") fail("checkout is not clean before applying the patch");

const patch = baseline.patches[0];
if (!patch) fail("no fork patch is recorded");
const patchPath = path.join(repoRoot, patch.path);
if (sha256(patchPath) !== patch.sha256) fail("fork patch hash differs from codex-baseline.json");
run("git", ["apply", "--check", patchPath]);
run("git", ["apply", patchPath]);

const cargoRoot = path.join(fork, "codex-rs");
run("cargo", ["build", "-p", "codex-cli", "--bin", "codex"], cargoRoot);
const lockDiff = run("git", ["diff", "--unified=0", "--", "codex-rs/Cargo.lock"]);
const changedVersions = lockDiff.split(/\r?\n/).filter((line) => /^[-+]version = "(?:0\.0\.0|0\.163\.0)"$/.test(line));
const allVersionOnly = lockDiff.split(/\r?\n/).every((line) =>
  !/^[+-]/.test(line) || /^[-+]version = "(?:0\.0\.0|0\.163\.0)"$/.test(line) || /^---|^\+\+\+/.test(line));
if (!allVersionOnly || changedVersions.length !== 320) fail("Cargo bootstrap changed more than the documented 160 workspace versions");
const lockPath = path.join(cargoRoot, "Cargo.lock");
if (sha256(lockPath) !== baseline.build.lockfileSha256) fail("post-bootstrap Cargo.lock hash differs from baseline");

run("cargo", ["build", "--locked", "-p", "codex-cli", "--bin", "codex"], cargoRoot);
run("cargo", ["test", "-p", "codex-state", "runtime_migrator_accepts_existing_windows_checksums", "--lib"], cargoRoot);
const binary = path.join(fork, baseline.build.binary.replace(/^vendor[\\/]codex[\\/]/, ""));
if (!existsSync(binary)) fail(`missing built binary ${binary}`);
const runtimeVersion = run(binary, ["--version"]);
if (!runtimeVersion.includes(baseline.runtimeVersion)) fail(`unexpected runtime version ${runtimeVersion}`);

console.info(JSON.stringify({
  status: "verified",
  commit: baseline.commit,
  patchSha256: patch.sha256,
  lockfileSha256: baseline.build.lockfileSha256,
  binarySha256: sha256(binary),
  runtimeVersion
}, null, 2));
