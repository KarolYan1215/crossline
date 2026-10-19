import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Whether the shell assistant may run for every account inside Codex's own Linux sandbox (docs/personal-agent.md §8). Off unless the
 * server says `CROSSLINE_SANDBOX_SHELL=on`: running other people's commands on a shared server is the owner's decision, and it needs
 * the container to create user namespaces (bubblewrap), which Docker's default profiles refuse. When on, bubblewrap must exist (on PATH
 * or beside the Codex binary, where Codex itself looks) and a throwaway sandbox must actually start; otherwise the assistant stays in
 * tools mode and the reason is logged.
 */
export function probeSandboxShell(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform,
  run: typeof spawnSync = spawnSync): { ok: boolean; reason: string } {
  if (env.CROSSLINE_SANDBOX_SHELL?.trim() !== "on") return { ok: false, reason: "off" };
  if (platform !== "linux") return { ok: false, reason: "not_linux" };
  const beside = env.CROSSLINE_CODEX_PATH ? path.join(path.dirname(env.CROSSLINE_CODEX_PATH), "codex-resources", "bwrap") : "";
  const onPath = run("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout?.toString().trim() ?? "";
  const bwrap = onPath || (beside && existsSync(beside) ? beside : "");
  if (!bwrap) return { ok: false, reason: "bubblewrap_missing" };
  const probe = run(bwrap, ["--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp", "true"],
    { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0 ? { ok: true, reason: "ok" } : { ok: false, reason: `bwrap_failed: ${String(probe.stderr ?? "").trim().slice(0, 200) || probe.status}` };
}
