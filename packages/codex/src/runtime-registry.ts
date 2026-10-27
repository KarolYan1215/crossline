import { clientBusy, waitForMemory } from "./model-gate";
import { forgetAccountModels } from "./model-catalog";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { CodexRpcBoundary } from "./index";
import { tFor } from "@crossline/core";
import { runLocale } from "./style";

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
/** The message the person reads, in the workspace's language (docs/i18n.md). */
const blocker = (code: RuntimeBlocker["code"], workspaceId?: string): RuntimeBlocker => ({ code, message: tFor(runLocale(undefined, workspaceId))(BLOCKERS[code]) });

/**
 * `account/read`'s account from a Codex `auth.json` (vendor/codex login/src/auth/storage.rs, token_data.rs): an API key, or a ChatGPT
 * login whose email and plan are claims of the stored ID token. Null when the file is missing or unreadable.
 */
export function accountFromAuthFile(file: string): Record<string, unknown> | null {
  let auth: { auth_mode?: string; OPENAI_API_KEY?: string | null; tokens?: { id_token?: unknown } };
  try { auth = JSON.parse(readFileSync(file, "utf8")) as typeof auth; } catch { return null; }
  if (auth.auth_mode === "apikey" || (!auth.tokens && auth.OPENAI_API_KEY)) return { type: "apiKey" };
  if (!auth.tokens) return null;
  let claims: { email?: string; "https://api.openai.com/profile"?: { email?: string }; "https://api.openai.com/auth"?: { chatgpt_plan_type?: string } } = {};
  try {
    const jwt = typeof auth.tokens.id_token === "string" ? auth.tokens.id_token : "";
    claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as typeof claims;
  } catch { /* a login without readable claims is still a login */ }
  return { type: "chatgpt", email: claims.email ?? claims["https://api.openai.com/profile"]?.email ?? null,
    planType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "unknown" };
}

export type RuntimeRegistry = {
  isOwner(workspaceId: string): boolean;
  /** Owner: always. A guest: once its own home holds a login, or it has a model provider of its own (providers.ts). */
  connected(workspaceId: string): boolean;
  /** Owner: always. A guest: only its own Codex sign-in — what serves the Skills a provider cannot. */
  signedIn(workspaceId: string): boolean;
  /**
   * A guest's sign-in as `account/read` would give it, read from its home's `auth.json` without starting its process; null when it has
   * none. The red bar asks every page (2.5 s), and a cold runtime took ~4 s to start just to answer it (2026-10-21).
   */
  savedAccount(workspaceId: string): Record<string, unknown> | null;
  /** The runtime for running Skills; starts a connected guest's process. */
  client(workspaceId: string): Promise<{ ok: true; client: CodexRpcBoundary } | { ok: false; blocker: RuntimeBlocker }>;
  /**
   * A connected account's client without starting or waiting for its process: the first request does that. For routes that hold the
   * caller's connection open while they work (`sendJsonWhenReady`), so a wait for a free runtime happens inside the kept-alive answer
   * rather than before its headers, where the caller's five-minute limit would cut it.
   */
  handle(workspaceId: string): { ok: true; client: CodexRpcBoundary } | { ok: false; blocker: RuntimeBlocker };
  /** Already running (the sync getters the worker's runners take); undefined until `client` has started it. */
  current(workspaceId: string): CodexRpcBoundary | undefined;
  login(workspaceId: string, method: LoginMethod): Promise<RuntimeLogin>;
  cancelLogin(workspaceId: string): Promise<void>;
  loginStatus(workspaceId: string): RuntimeLogin | null;
  /** Signs a guest out and deletes its home (login and memories); the owner's runtime is not touched here. */
  logout(workspaceId: string): Promise<void>;
  stopIdle(): void;
  /** Under memory pressure: stops every guest runtime with no run in flight that has been quiet for a minute. */
  reclaim(): void;
  stopAll(): void;
};

/**
 * A runtime quiet this long with no run in flight may be stopped for another account or under memory pressure. Short, because the
 * runtime holds nothing the ledger does not: an interview's thread is rebuilt from its messages when it is gone (SKILL_THREAD_LOST).
 */
const EVICT_GRACE_MS = 15_000;

export function createRuntimeRegistry(options: {
  owner: RuntimeSidecar;
  /** The client the owner's model runs take (the compute node's runtime while connected); `owner.client` when not given. */
  ownerClient?: () => CodexRpcBoundary;
  ownerWorkspaceId: () => string | undefined;
  /** Where guest homes live: `<baseDir>/<workspaceId>/codex-home`. */
  baseDir: string;
  start: (codexHome: string) => Promise<RuntimeSidecar>;
  maxRunning?: number;
  /** Whether a workspace has a model provider of its own; such a guest gets its own runtime even without a Codex sign-in. */
  hasProvider?: (workspaceId: string) => boolean;
  /**
   * A guest's login just succeeded. Whatever background state was decided while it had no model (a paused background, captures left
   * unanalysed, first drafts not started) is decided again now instead of at the next tick, up to fifteen minutes later (W-11).
   */
  onConnected?: (workspaceId: string) => void;
  /** Longer than a Skill's own stall limit (20 min), so a long turn that is still producing events is never stopped under it. */
  idleMs?: number;
  /** While every runtime is working, how often to look for one that finished, and how long to wait before refusing (three hours). */
  pollMs?: number;
  maxQueueMs?: number;
  now?: () => number;
}): RuntimeRegistry {
  const maxRunning = options.maxRunning ?? 3;
  const pollMs = options.pollMs ?? 2_000;
  // As long as the web's longest wait on a run (three hours): a full house means waiting, and only a runtime stuck busy past it is refused.
  const maxQueueMs = options.maxQueueMs ?? 3 * 60 * 60_000;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;
  const running = new Map<string, { sidecar: RuntimeSidecar; lastUsed: number }>();
  const starting = new Map<string, Promise<RuntimeSidecar>>();
  const logins = new Map<string, RuntimeLogin>();
  const handles = new Map<string, Handle>();
  const isOwner = (workspaceId: string) => !workspaceId || workspaceId === options.ownerWorkspaceId();
  const ownerClient = () => options.ownerClient?.() ?? options.owner.client;
  const homeOf = (workspaceId: string) => path.join(options.baseDir, workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"), "codex-home");
  const signedIn = (workspaceId: string) => isOwner(workspaceId) || existsSync(path.join(homeOf(workspaceId), "auth.json"));
  const connected = (workspaceId: string) => signedIn(workspaceId) || Boolean(options.hasProvider?.(workspaceId));
  const savedAccount = (workspaceId: string) => isOwner(workspaceId) ? null : accountFromAuthFile(path.join(homeOf(workspaceId), "auth.json"));

  const stop = (workspaceId: string) => {
    const entry = running.get(workspaceId);
    running.delete(workspaceId);
    try { entry?.sidecar.stop(); } catch { /* already gone */ }
  };
  const touch = (workspaceId: string) => { const entry = running.get(workspaceId); if (entry) entry.lastUsed = now(); };
  // A runtime with a run in flight is never stopped for being idle or to make room, however quiet its turn is (model-gate.ts). Runs
  // hold the workspace's handle, not the process's own client, so that is what is marked busy.
  const stoppable = (workspaceId: string, entry: { lastUsed: number }, quietMs: number) =>
    !clientBusy(handleFor(workspaceId)) && now() - entry.lastUsed >= quietMs;

  /**
   * The client every caller gets for a guest: one per workspace, kept across the process behind it being stopped and started again.
   * Work waiting for the model gate holds a client but has no run in flight, so its runtime may be stopped to make room for someone
   * else's; when its turn comes, its first request starts the runtime again instead of failing on a dead process. Notifications and
   * the runtime's own requests are forwarded from whichever process is current.
   */
  type Handle = CodexRpcBoundary & { notify: Set<(message: Record<string, unknown>) => void>; serve?: (method: string, params: unknown) => unknown };
  function handleFor(workspaceId: string): Handle {
    const known = handles.get(workspaceId);
    if (known) return known;
    const handle: Handle = {
      notify: new Set(),
      async request(method, params) {
        if (!connected(workspaceId)) throw new Error("RUNTIME_UNCONNECTED");
        const started = await ensure(workspaceId);
        if ("code" in started) throw new Error(started.code);
        return started.client.request(method, params);
      },
      onNotification(handler) { handle.notify.add(handler); return () => { handle.notify.delete(handler); }; },
      onServerRequest(handler) {
        handle.serve = handler;
        return () => { if (handle.serve === handler) delete handle.serve; };
      }
    };
    handles.set(workspaceId, handle);
    return handle;
  }

  async function ensure(workspaceId: string): Promise<RuntimeSidecar | RuntimeBlocker> {
    const existing = running.get(workspaceId);
    if (existing) { existing.lastUsed = now(); return existing.sidecar; }
    const pending = starting.get(workspaceId);
    if (pending) return pending;
    // Make room by stopping the least recently used guest with no run in flight. When every one is working, wait for one to finish
    // instead of refusing: refusing meant a second person got 「同时运行的模型连接已满」 whenever another had used the app in the last
    // minute (the hosted beta, 2026-10-16). Only a wait past `maxQueueMs` (a runtime stuck busy) is refused.
    const queuedAt = now();
    while (running.size >= maxRunning) {
      const oldest = [...running].filter(([id, entry]) => stoppable(id, entry, EVICT_GRACE_MS)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) { stop(oldest[0]); break; }
      if (now() - queuedAt >= maxQueueMs) return blocker("RUNTIME_LIMIT_REACHED", workspaceId);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const arrived = running.get(workspaceId)?.sidecar ?? await starting.get(workspaceId)?.catch(() => undefined);
      if (arrived) return arrived;
    }
    // Another process is the largest single thing this can add: with memory above the high-water mark, wait (reclaiming meanwhile)
    // for as long as another guest's runtime is up, since its run ending is what frees memory. With none up the reading is the worker's
    // own, and starting anyway is the only way forward.
    while (!(await waitForMemory()) && running.size > 0 && now() - queuedAt < maxQueueMs) { /* keep waiting */ }
    // Another call may have started it while this one waited.
    const meanwhile = running.get(workspaceId)?.sidecar ?? await starting.get(workspaceId)?.catch(() => undefined);
    if (meanwhile) return meanwhile;
    const home = homeOf(workspaceId);
    mkdirSync(home, { recursive: true });
    const launch = options.start(home);
    starting.set(workspaceId, launch);
    try {
      const sidecar = await launch;
      running.set(workspaceId, { sidecar, lastUsed: now() });
      // Every event from the runtime is activity: a long turn keeps its process alive as long as it is still working.
      const handle = handleFor(workspaceId);
      sidecar.client.onServerRequest?.((method, params) => {
        if (!handle.serve) throw new Error("no run is waiting on this thread");
        return handle.serve(method, params);
      });
      sidecar.client.onNotification((message) => {
        touch(workspaceId);
        for (const handler of handle.notify) { try { handler(message); } catch { /* one listener must not stop the others */ } }
        if (message.method !== "account/login/completed") return;
        const login = logins.get(workspaceId);
        const params = (message.params ?? {}) as { loginId?: unknown; success?: unknown };
        if (login && (params.loginId === undefined || params.loginId === login.loginId)) {
          logins.set(workspaceId, { ...login, state: params.success === true ? "completed" : "failed", updatedAt: new Date(now()).toISOString() });
          if (params.success === true) connectedNow(workspaceId);
        }
      });
      sidecar.onExit(() => { if (running.get(workspaceId)?.sidecar === sidecar) running.delete(workspaceId); });
      return sidecar;
    } catch {
      return blocker("RUNTIME_START_FAILED", workspaceId);
    } finally { starting.delete(workspaceId); }
  }

  /** Told once per successful login; a listener's failure never reaches the runtime's notification loop. */
  const connectedNow = (workspaceId: string) => { try { options.onConnected?.(workspaceId); } catch { /* the listener's own concern */ } };

  const clientFor = async (workspaceId: string, forLogin = false): Promise<{ ok: true; client: CodexRpcBoundary } | { ok: false; blocker: RuntimeBlocker }> => {
    if (isOwner(workspaceId)) return { ok: true, client: forLogin ? options.owner.client : ownerClient() };
    if (!forLogin && !connected(workspaceId)) return { ok: false, blocker: blocker("RUNTIME_UNCONNECTED", workspaceId) };
    const started = await ensure(workspaceId);
    return "code" in started ? { ok: false, blocker: started } : { ok: true, client: handleFor(workspaceId) };
  };

  return {
    isOwner, connected, signedIn, savedAccount,
    client: (workspaceId) => clientFor(workspaceId),
    handle: (workspaceId) => isOwner(workspaceId) ? { ok: true, client: ownerClient() }
      : connected(workspaceId) ? { ok: true, client: handleFor(workspaceId) } : { ok: false, blocker: blocker("RUNTIME_UNCONNECTED", workspaceId) },
    current: (workspaceId) => isOwner(workspaceId) ? ownerClient() : (touch(workspaceId), running.has(workspaceId) ? handleFor(workspaceId) : undefined),
    async login(workspaceId, method) {
      // Not through the handle: an account that is not connected yet is exactly the one that logs in.
      const started = isOwner(workspaceId) ? options.owner : await ensure(workspaceId);
      if ("code" in started) throw new Error(started.code);
      const runtime = { client: started.client };
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
      if (login.state === "completed") connectedNow(workspaceId);
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
      forgetAccountModels(workspaceId);
      rmSync(path.dirname(homeOf(workspaceId)), { recursive: true, force: true });
    },
    stopIdle() { for (const [workspaceId, entry] of [...running]) if (stoppable(workspaceId, entry, idleMs)) stop(workspaceId); },
    reclaim() { for (const [workspaceId, entry] of [...running]) if (stoppable(workspaceId, entry, EVICT_GRACE_MS)) stop(workspaceId); },
    stopAll() { for (const workspaceId of [...running.keys()]) stop(workspaceId); }
  };
}
