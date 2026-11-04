import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { SANDBOX_SHELL_SETTING, type CrosslineStore } from "@crossline/db";
import { loginMode } from "./browser-launch";
import { tOfWorkspace } from "./locale";
import { profileHolder } from "./profile-locks";
import type { NodeShellLink } from "./node/task-sync";
import type { Probe, ProbeOutcome } from "./self-check";
import { closeServerDisplay, serverDisplay, type ServerDisplay } from "./server-display";
import { browserProfilesRoot } from "./workflow-smith";

const ok: ProbeOutcome = { status: "ok", code: "", detail: "" };
const skipped: ProbeOutcome = { status: "skipped", code: "", detail: "" };

/**
 * The sandboxed shell (docs/personal-agent.md §8): the worker's own probe result, re-read at most hourly, is written into each account's
 * settings so the web describes the assistant the worker will actually run (it used to read the environment and promise a shell the
 * worker had fallen back from). A server that asked for the sandbox and cannot start one is a failure the owner must fix on the host.
 */
export function sandboxProbe(store: CrosslineStore, probe: () => { ok: boolean; reason: string }): Probe {
  return { id: "sandbox", run: (workspaceId) => {
    const result = probe();
    const mark = result.ok ? "ok" : result.reason;
    if (store.getSetting(workspaceId, SANDBOX_SHELL_SETTING) !== mark) store.setSetting(workspaceId, SANDBOX_SHELL_SETTING, mark);
    if (result.reason === "off" || result.reason === "not_linux") return skipped;
    if (result.ok) return ok;
    return { status: "failing", code: "SANDBOX_UNAVAILABLE", detail: tOfWorkspace(store, workspaceId)("服务器开了沙箱命令行，但沙箱启动不了（{{reason}}），助手暂用无命令行的方式", { reason: result.reason }) };
  } };
}

/** A probe result kept for an hour, so a host fix is seen without a restart and the bubblewrap check is not run per account. */
export function hourly<T>(read: () => T, now = () => Date.now()): () => T {
  let at = 0; let value: T | undefined;
  return () => { if (value === undefined || now() - at > 3_600_000) { value = read(); at = now(); } return value; };
}

/**
 * The account's computer as a compute node with the shell assistant (docs/compute-node.md): a node that says it has no FFmpeg cannot do
 * audio or video errands. Nothing to repair from here (the person installs it); said once.
 */
export function nodeProbe(store: CrosslineStore, shellFor: (workspaceId: string) => NodeShellLink | undefined): Probe {
  return { id: "node", run: (workspaceId) => {
    const link = shellFor(workspaceId);
    if (!link) return skipped;
    if (link.ffmpeg === false) return { status: "failing", code: "NODE_FFMPEG_MISSING",
      detail: tOfWorkspace(store, workspaceId)("「{{host}}」上没有 FFmpeg，助手在这台电脑上做不了音视频剪辑；装好 FFmpeg 后重启节点即可", { host: link.host }) };
    return ok;
  } };
}

/** Chromium's own profile locks: left behind by a browser that was killed, they keep the next one from opening the profile. */
const SINGLETON = /^Singleton(Lock|Socket|Cookie)$/;

/**
 * The server's login and reading browser (docs/skills-library.md 「托管版登录」): the virtual screen must start, and a profile no live browser
 * holds must not carry Chromium's lock files from one that was killed (the next login then fails to open it). A screen that does not start
 * is restarted once; the stale locks are removed. Only where the browser runs on the server and the account has a profile at all.
 */
export function remoteBrowserProbe(store: CrosslineStore, env: NodeJS.ProcessEnv = process.env,
  display: () => Promise<ServerDisplay> = () => serverDisplay(env), restart: () => void = closeServerDisplay): Probe {
  return { id: "remoteBrowser", run: async (workspaceId) => {
    const root = browserProfilesRoot(workspaceId, env);
    if (loginMode(env) !== "remote" || !existsSync(root)) return skipped;
    const t = tOfWorkspace(store, workspaceId);
    let removed = 0;
    for (const site of readdirSync(root, { withFileTypes: true })) {
      if (!site.isDirectory()) continue;
      const dir = path.join(root, site.name);
      if (profileHolder(dir)) continue;
      for (const name of readdirSync(dir)) if (SINGLETON.test(name)) { rmSync(path.join(dir, name), { force: true }); removed++; }
    }
    let restarted = false;
    if (env.CROSSLINE_SERVER_DISPLAY?.trim().toLowerCase() !== "off" && !(await display())) {
      restart(); restarted = true;
      if (!(await display())) return { status: "failing", code: "SERVER_DISPLAY_UNAVAILABLE", detail: t("服务器的虚拟屏幕启动不了，登录和读取只能用无界面浏览器") };
    }
    if (!removed && !restarted) return ok;
    return { status: "repaired", code: restarted ? "SERVER_DISPLAY_RESTARTED" : "PROFILE_LOCK_STALE",
      detail: t("清理了 {{removed}} 个残留的浏览器锁{{restarted}}", { removed, restarted: restarted ? t("，重启了虚拟屏幕") : "" }) };
  } };
}
