import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeUsesNetwork, tFor, type Locale } from "@crossline/core";
import { codexProcessEnvironment, resolveCodexCommand } from "@crossline/codex";

/**
 * Reproducible deliverables (docs/plans/harness-1125.md §7): when the assistant hands over an HTML report, a chart or a data file, the
 * result counts only if the `run.*` script it left beside them makes the same files again. The worker re-runs it once, in a copy of the
 * task directory with the deliverables removed, without the network (dead proxies and a script that names no connection), and compares
 * hashes. A run that worked in a Windows sandbox (docs/plans/harness-1125.md §9) is re-run in the same one, through `codex sandbox`:
 * reads anywhere but the same secrets, writes only in the copy, no network at all. Otherwise this is the guard's level, not an enforced
 * one. What is checked is the re-run, not the assistant's word.
 */
export const REPRODUCIBLE = /\.(html?|png|jpe?g|svg|csv|tsv|json|xlsx|parquet)$/i;
export const RUN_SCRIPTS = ["run.py", "run.mjs", "run.ps1"] as const;
export const REPRODUCE_TIMEOUT_MS = 120_000;

export type Reproduction =
  | { needed: false }
  | { needed: true; reproduced: true; script: string; files: string[] }
  | { needed: true; reproduced: false; script?: string; files: string[]; problem: "missing" | "network" | "failed" | "timeout" | "mismatch"; mismatched?: string[]; detail?: string };

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** The run's own bookkeeping is never a deliverable. */
const OWN_FILES = /^(audit|progress)\.json$/i;

/** The worker's environment minus everything of its own (tokens, keys, paths to the ledger), with every proxy pointed at a dead port. */
function offlineEnv(copy: string): NodeJS.ProcessEnv {
  // SystemDrive and LOCALAPPDATA: MXC refuses to start without the host's own values of both.
  const keep = ["PATH", "SystemRoot", "SYSTEMROOT", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  const dead = "http://127.0.0.1:9";
  return { ...env, TEMP: path.join(copy, ".tmp"), TMP: path.join(copy, ".tmp"), TMPDIR: path.join(copy, ".tmp"), HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead,
    http_proxy: dead, https_proxy: dead, NO_PROXY: "localhost,127.0.0.1,::1", PIP_NO_INDEX: "1", NPM_CONFIG_OFFLINE: "true", PYTHONIOENCODING: "utf-8" };
}

/** How a script is started: a virtual environment the run made in its directory wins over the system's Python. */
function launcher(script: string, copy: string): [string, string[]] {
  if (script === "run.mjs") return [process.execPath, [script]];
  if (script === "run.ps1") return [process.platform === "win32" ? "powershell.exe" : "pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]];
  for (const venv of [".venv", "venv"]) {
    const python = process.platform === "win32" ? path.join(copy, venv, "Scripts", "python.exe") : path.join(copy, venv, "bin", "python");
    if (existsSync(python)) return [python, [script]];
  }
  return [process.platform === "win32" ? "python" : "python3", [script]];
}

/** The re-run's own sandbox: the profile the shell had, minus the network, with only the copy writable. */
export type ReproduceSandbox = { backend: "mxc" | "elevated"; deny: string[] };
const REPRODUCE_PROFILE = "crossline-reproduce";
/** A TOML basic string (JSON's escapes are TOML's) for a `-c` override. */
const toml = (value: string) => JSON.stringify(value);

/**
 * The command that runs `command args` inside `codex sandbox` with a named profile given as `-c` overrides (the runtime's own CLI, no
 * config file written): `:root` readable, `deny` unreadable, the copy writable, no network. MXC is chosen with `features.prefer_mxc`; an
 * elevated sandbox is the one already configured in the runtime's home.
 */
export function sandboxedCommand(codex: { command: string; args: string[] }, sandbox: ReproduceSandbox, copy: string, command: string, args: string[]): [string, string[]] {
  const filesystem = [`":root"="read"`, ...sandbox.deny.map((entry) => `${toml(entry)}="deny"`), `${toml(copy)}="write"`].join(", ");
  return [codex.command, [...codex.args, ...(sandbox.backend === "mxc" ? ["-c", "features.prefer_mxc=true"] : []),
    "-c", `permissions.${REPRODUCE_PROFILE}={filesystem={${filesystem}}, network={enabled=false}}`,
    "sandbox", "-P", REPRODUCE_PROFILE, "-C", copy, "--", command, ...args]];
}

function runScript(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; timedOut: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, { cwd, env: { ...offlineEnv(cwd), ...extraEnv }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    const timer = setTimeout(() => {
      timedOut = true;
      // The whole tree: a script that starts a server or a pool must not outlive its check.
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, timedOut, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut, stderr }); });
  });
}

/**
 * Re-runs the task's `run.*` once and compares what it makes with what was delivered. Only artifacts of a reproducible kind are checked;
 * a run that delivered none of them needs nothing. Exact hashes only (a PNG or a report with a timestamp in it is a mismatch, reported
 * as one).
 */
export async function reproduceDeliverables(directory: string, artifacts: Array<{ path: string; sha256: string }>,
  options: { timeoutMs?: number; sandbox?: ReproduceSandbox; codex?: { command: string; args: string[]; env: NodeJS.ProcessEnv } } = {}): Promise<Reproduction> {
  const delivered = artifacts.filter((artifact) => REPRODUCIBLE.test(artifact.path) && !OWN_FILES.test(artifact.path));
  if (!delivered.length) return { needed: false };
  const files = delivered.map((artifact) => artifact.path);
  const script = RUN_SCRIPTS.find((name) => existsSync(path.join(directory, name)));
  if (!script) return { needed: true, reproduced: false, files, problem: "missing" };
  if (codeUsesNetwork(readFileSync(path.join(directory, script), "utf8"))) return { needed: true, reproduced: false, script, files, problem: "network" };
  const copy = path.join(tmpdir(), `crossline-reproduce-${randomUUID().slice(0, 8)}`);
  const skip = new Set([...delivered.map((artifact) => path.resolve(directory, artifact.path).toLowerCase()),
    ...["audit.json", "progress.json"].map((name) => path.join(directory, name).toLowerCase())]);
  try {
    // A sandboxed run kept its temp files and package caches in `.tmp` (agent-task.ts `windowsShellSandbox`): never part of the result.
    const ownTmp = path.join(directory, ".tmp").toLowerCase();
    cpSync(directory, copy, { recursive: true, filter: (source) => path.basename(source) !== ".git" && !skip.has(path.resolve(source).toLowerCase()) && path.resolve(source).toLowerCase() !== ownTmp });
    mkdirSync(path.join(copy, ".tmp"), { recursive: true });
    const [bare, bareArgs] = launcher(script, copy);
    let launch: [string, string[]] = [bare, bareArgs];
    let extraEnv: NodeJS.ProcessEnv = {};
    if (options.sandbox) {
      // The same sandbox as the run, through the runtime's CLI; a runtime that cannot be found fails the check rather than running bare.
      let codex = options.codex;
      if (!codex) {
        try { const env = codexProcessEnvironment(); codex = { ...resolveCodexCommand(env), env }; }
        catch (error) { return { needed: true, reproduced: false, script, files, problem: "failed", detail: error instanceof Error ? error.message.slice(0, 300) : "" }; }
      }
      launch = sandboxedCommand(codex, options.sandbox, copy, bare, bareArgs);
      extraEnv = { ...(codex.env.CODEX_HOME ? { CODEX_HOME: codex.env.CODEX_HOME } : {}) };
    }
    const ran = await runScript(launch[0], launch[1], copy, options.timeoutMs ?? REPRODUCE_TIMEOUT_MS, extraEnv);
    if (ran.timedOut) return { needed: true, reproduced: false, script, files, problem: "timeout" };
    if (ran.code !== 0) {
      // The error line itself (Python's last `XError: …`, Node's `Error: …`), not the stack around it.
      const lines = ran.stderr.trim().split(/\r?\n/);
      return { needed: true, reproduced: false, script, files, problem: "failed", detail: ([...lines].reverse().find((line) => /(error|exception)\b[^:]*:/i.test(line)) ?? lines.at(-1) ?? "").trim().slice(0, 300) };
    }
    const mismatched = delivered.filter((artifact) => {
      const made = path.join(copy, artifact.path);
      return !existsSync(made) || sha(made) !== artifact.sha256;
    }).map((artifact) => artifact.path);
    return mismatched.length ? { needed: true, reproduced: false, script, files, problem: "mismatch", mismatched } : { needed: true, reproduced: true, script, files };
  } finally {
    rmSync(copy, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Why a result is held for the person when its deliverables could not be made again; undefined when nothing is held. */
export function reproductionReason(result: Reproduction, locale?: Locale): string | undefined {
  if (!result.needed || result.reproduced) return undefined;
  const t = tFor(locale);
  const list = (files: string[]) => files.slice(0, 3).join(locale === "en" ? ", " : "、");
  switch (result.problem) {
    case "missing": return t("交付的报告、图表或数据没有附上能重新生成它们的 run 脚本");
    case "network": return t("重新生成交付物的 run 脚本要联网，没有重跑");
    case "timeout": return t("重新生成交付物的 run 脚本 2 分钟内没有跑完");
    case "failed": return t("重新生成交付物的 run 脚本运行出错");
    case "mismatch": return t("重新运行 run 脚本生成的 {{files}} 与交付的不一致", { files: list(result.mismatched ?? []) });
  }
}
