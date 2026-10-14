import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { CodexRpcBoundary } from "./index";

/**
 * Which Codex runtime serves which workspace (decided 2026-10-10). The machine owner's workspace keeps the runtime the worker always
 * had — its own login, quota, memories and the shell assistant. Every other workspace uses its **own** Codex: its own CODEX_HOME (so its
 * own `auth.json`, its own memories) and its own app-server process, started when needed and stopped when idle. A workspace that has not
 * connected one is told so (`RUNTIME_UNCONNECTED`); it never falls back to the owner's runtime, which used to mean every account on the
 * machine read the owner's memories and spent the owner's quota.
 */
export type RuntimeSidecar = { client: CodexRpcBoundary; stop: () => void; onExit: (handler: () => void) => () => void };
export type RuntimeBlocker = { code: "RUNTIME_UNCONNECTED" | "RUNTIME_LIMIT_REACHED" | "RUNTIME_START_FAILED"; message: string };
export type RuntimeLogin = {
  loginId: string; type: "chatgpt" | "chatgptDeviceCode" | "apiKey"; state: "pending" | "completed" | "failed"; updatedAt: string;
  authUrl?: string; verificationUrl?: string; userCode?: string;
};
export type LoginMethod = { type: "chatgpt" } | { type: "chatgptDeviceCode" } | { type: "apiKey"; apiKey: string };

const BLOCKERS: Record<RuntimeBlocker["code"], string> = {
  RUNTIME_UNCONNECTED: "还没有连接模型账号：到 设置 → 模型连接 登录 ChatGPT 或填写 API key。",
  RUNTIME_LIMIT_REACHED: "同时运行的模型连接已满，稍后再试。",
  RUNTIME_START_FAILED: "模型运行时没有启动起来，稍后再试。"
};
const blocker = (code: RuntimeBlocker["code"]): RuntimeBlocker => ({ code, message: BLOCKERS[code] });

export type RuntimeRegistry = {
  isOwner(workspaceId: string): boolean;
  /** Owner: always. A guest: once its own home holds a login, or it has a model provider of its own (providers.ts). */
  connected(workspaceId: string): boolean;
  /** Owner: always. A guest: only its own Codex sign-in — what serves the Skills a provider cannot. */
  signedIn(workspaceId: string): boolean;
  /** The runtime for running Skills; starts a connected guest's process. */
  client(workspaceId: string): Promise<{ ok: true; client: CodexRpcBoundary } | { ok: false; blocker: RuntimeBlocker }>;
  /** Already running (the sync getters the worker's runners take); undefined until `client` has started it. */
  current(workspaceId: string): CodexRpcBoundary | undefined;
  login(workspaceId: string, method: LoginMethod): Promise<RuntimeLogin>;
  cancelLogin(workspaceId: string): Promise<void>;
  loginStatus(workspaceId: string): RuntimeLogin | null;
  /** Signs a guest out and deletes its home (login and memories); the owner's runtime is not touched here. */
  logout(workspaceId: string): Promise<void>;
  stopIdle(): void;
  stopAll(): void;
};

export function createRuntimeRegistry(options: {
  owner: RuntimeSidecar;
  ownerWorkspaceId: () => string | undefined;
  /** Where guest homes live: `<baseDir>/<workspaceId>/codex-home`. */
  baseDir: string;
  start: (codexHome: string) => Promise<RuntimeSidecar>;
  maxRunning?: number;
  /** Whether a workspace has a model provider of its own; such a guest gets its own runtime even without a Codex sign-in. */
  hasProvider?: (workspaceId: string) => boolean;
  /** Longer than a Skill's own stall limit (20 min), so a long turn that is still producing events is never stopped under it. */
  idleMs?: number;
  now?: () => number;
}): RuntimeRegistry {
  const maxRunning = options.maxRunning ?? 3;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;
  const running = new Map<string, { sidecar: RuntimeSidecar; lastUsed: number }>();
  const starting = new Map<string, Promise<RuntimeSidecar>>();
  const logins = new Map<string, RuntimeLogin>();
  const isOwner = (workspaceId: string) => !workspaceId || workspaceId === options.ownerWorkspaceId();
  const homeOf = (workspaceId: string) => path.join(options.baseDir, workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"), "codex-home");
  const signedIn = (workspaceId: string) => isOwner(workspaceId) || existsSync(path.join(homeOf(workspaceId), "auth.json"));
  const connected = (workspaceId: string) => signedIn(workspaceId) || Boolean(options.hasProvider?.(workspaceId));

  const stop = (workspaceId: string) => {
    const entry = running.get(workspaceId);
    running.delete(workspaceId);
    try { entry?.sidecar.stop(); } catch { /* already gone */ }
  };
  const touch = (workspaceId: string) => { const entry = running.get(workspaceId); if (entry) entry.lastUsed = now(); };

  async function ensure(workspaceId: string): Promise<RuntimeSidecar | RuntimeBlocker> {
    const existing = running.get(workspaceId);
    if (existing) { existing.lastUsed = now(); return existing.sidecar; }
    const pending = starting.get(workspaceId);
    if (pending) return pending;
    if (running.size >= maxRunning) {
      // Make room by stopping the least recently used guest; if every one is in use right now, say so rather than queue for hours.
      const oldest = [...running].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest || now() - oldest[1].lastUsed < 60_000) return blocker("RUNTIME_LIMIT_REACHED");
      stop(oldest[0]);
    }
    const home = homeOf(workspaceId);
    mkdirSync(home, { recursive: true });
    const launch = options.start(home);
    starting.set(workspaceId, launch);
    try {
      const sidecar = await launch;
      running.set(workspaceId, { sidecar, lastUsed: now() });
      // Every event from the runtime is activity: a long turn keeps its process alive as long as it is still working.
      sidecar.client.onNotification((message) => {
        touch(workspaceId);
        if (message.method !== "account/login/completed") return;
        const login = logins.get(workspaceId);
        const params = (message.params ?? {}) as { loginId?: unknown; success?: unknown };
        if (login && (params.loginId === undefined || params.loginId === login.loginId))
          logins.set(workspaceId, { ...login, state: params.success === true ? "completed" : "failed", updatedAt: new Date(now()).toISOString() });
      });
      sidecar.onExit(() => { if (running.get(workspaceId)?.sidecar === sidecar) running.delete(workspaceId); });
      return sidecar;
    } catch {
      return blocker("RUNTIME_START_FAILED");
    } finally { starting.delete(workspaceId); }
  }

  const clientFor = async (workspaceId: string, forLogin = false): Promise<{ ok: true; client: CodexRpcBoundary } | { ok: false; blocker: RuntimeBlocker }> => {
    if (isOwner(workspaceId)) return { ok: true, client: options.owner.client };
    if (!forLogin && !connected(workspaceId)) return { ok: false, blocker: blocker("RUNTIME_UNCONNECTED") };
    const started = await ensure(workspaceId);
    return "code" in started ? { ok: false, blocker: started } : { ok: true, client: started.client };
  };

  return {
    isOwner, connected, signedIn,
    client: (workspaceId) => clientFor(workspaceId),
    current: (workspaceId) => isOwner(workspaceId) ? options.owner.client : (touch(workspaceId), running.get(workspaceId)?.sidecar.client),
    async login(workspaceId, method) {
      const runtime = await clientFor(workspaceId, true);
      if (!runtime.ok) throw new Error(runtime.blocker.code);
      const params = method.type === "chatgpt" ? { type: "chatgpt", appBrand: "codex", codexStreamlinedLogin: true, useHostedLoginSuccessPage: true }
        : method.type === "apiKey" ? { type: "apiKey", apiKey: method.apiKey } : { type: "chatgptDeviceCode" };
      const answer = (await runtime.client.request("account/login/start", params) ?? {}) as Record<string, unknown>;
      const at = new Date(now()).toISOString();
      const login: RuntimeLogin = { loginId: typeof answer.loginId === "string" ? answer.loginId : `${method.type}-${at}`, type: method.type,
        // An API key is saved by the runtime as it answers; there is nothing left to wait for.
        state: method.type === "apiKey" ? "completed" : "pending", updatedAt: at,
        ...(typeof answer.authUrl === "string" ? { authUrl: answer.authUrl } : {}),
        ...(typeof answer.verificationUrl === "string" ? { verificationUrl: answer.verificationUrl } : {}),
        ...(typeof answer.userCode === "string" ? { userCode: answer.userCode } : {}) };
      logins.set(workspaceId, login);
      return login;
    },
    async cancelLogin(workspaceId) {
      const login = logins.get(workspaceId);
      const client = isOwner(workspaceId) ? options.owner.client : running.get(workspaceId)?.sidecar.client;
      if (login && client) await client.request("account/login/cancel", { loginId: login.loginId }).catch(() => undefined);
      logins.delete(workspaceId);
    },
    loginStatus: (workspaceId) => logins.get(workspaceId) ?? null,
    async logout(workspaceId) {
      if (isOwner(workspaceId)) return;
      await running.get(workspaceId)?.sidecar.client.request("account/logout", {}).catch(() => undefined);
      stop(workspaceId);
      logins.delete(workspaceId);
      rmSync(path.dirname(homeOf(workspaceId)), { recursive: true, force: true });
    },
    stopIdle() { for (const [workspaceId, entry] of [...running]) if (now() - entry.lastUsed >= idleMs) stop(workspaceId); },
    stopAll() { for (const workspaceId of [...running.keys()]) stop(workspaceId); }
  };
}
