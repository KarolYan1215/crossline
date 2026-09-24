import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { readCostSignal } from "./cost";
import { verifyCapability } from "./capability";
import type { CostSignal } from "@crossline/core";
export * from "./skill-runner";
export * from "./analysis";
export * from "./cost";
export * from "./model-tiers";
export * from "./capability";

type ContextInput = {
  ownerId: string;
  workspaceId: string;
  identityId: string;
  taskId: string;
  globalContextVersion: number;
  identityPackVersion: number;
  allowedRoots: string[];
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

export function normalizeCodexEvent(event: unknown): unknown {
  const envelope = record(event);
  const params = record(envelope?.params);
  const item = record(params?.item);
  if (envelope?.method === "item/completed" && item?.status === "failed") {
    return {
      type: "blocked",
      itemId: String(item.id ?? "unknown"),
      blocker: {
        code: "CODEX_TOOL_FAILED",
        message: String(item.error ?? "Codex tool failed")
      }
    };
  }
  if (envelope?.method === "turn/completed") {
    return { type: "completed", turnId: String(params?.turnId ?? "unknown") };
  }
  return { type: "progress", raw: event };
}

export function buildContextBundle(input: ContextInput) {
  return {
    version: `${input.globalContextVersion}:${input.identityId}:${input.identityPackVersion}:${input.taskId}`,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    identityId: input.identityId,
    taskId: input.taskId,
    allowedRoots: [...new Set(input.allowedRoots)]
  };
}

export class JsonLineRpcClient {
  #nextId = 1;
  readonly #writeLine: (line: string) => void;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #notificationHandlers = new Set<(message: Record<string, unknown>) => void>();
  #disconnectError: Error | undefined;

  constructor(writeLine: (line: string) => void) {
    this.#writeLine = writeLine;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#disconnectError) return Promise.reject(this.#disconnectError);
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#writeLine(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.#writeLine(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  onNotification(handler: (message: Record<string, unknown>) => void): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  disconnect(error: Error): void {
    if (this.#disconnectError) return;
    this.#disconnectError = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const handler of this.#notificationHandlers) handler({ method: "crossline/runtimeDisconnected" });
  }

  receiveLine(line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of this.#notificationHandlers) handler(message);
  }
}

export const CODEX_BASELINE_COMMIT = "f0a1b8f0849d90960bc406b848f32e5a129b0457";
export const CODEX_GENERATED_PROTOCOL_SHA256 = "cff5bf0f8f52d3d4fd2d00145462c5a3e21df86ec3b3b652668884831eb5c6a3";
export const CODEX_FORK_BINARY_SHA256 = "4bcc1d8452c75cd132e010f41ccfaf6afb8699317f9a90d88df0b20be2335497";

export async function readCodexAccount(client: JsonLineRpcClient): Promise<unknown> {
  return client.request("account/read", { refreshToken: false });
}

export async function startCodexChatGptLogin(client: JsonLineRpcClient): Promise<unknown> {
  return client.request("account/login/start", {
    type: "chatgpt",
    appBrand: "codex",
    codexStreamlinedLogin: true,
    useHostedLoginSuccessPage: true
  });
}

export function codexProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  localAppData = base.LOCALAPPDATA
): NodeJS.ProcessEnv {
  if (!localAppData) throw new Error("LOCALAPPDATA_UNAVAILABLE");
  const isPackagedRedirect = /\\packages\\[^\\]+\\localcache\\local$/i.test(localAppData);
  const durableLocalAppData = isPackagedRedirect && base.USERPROFILE
    ? path.win32.join(base.USERPROFILE, "AppData", "Local")
    : localAppData;
  const crosslineHome = path.win32.join(durableLocalAppData, "Crossline", "codex-home");
  const env: NodeJS.ProcessEnv = { ...base, CODEX_HOME: crosslineHome, CROSSLINE_CODEX_HOME: crosslineHome };
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return env;
}

function fileSha256(file: string): string {
  const hash = createHash("sha256");
  const handle = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let size: number;
    while ((size = readSync(handle, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, size));
    return hash.digest("hex");
  } finally { closeSync(handle); }
}

// The runtime is built from the pinned fork in this checkout. PATH can contain both the official npm
// shim and Codex Desktop; neither proves the source of the child the worker owns.
export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: string = process.platform,
  sha256: (file: string) => string = fileSha256
): { command: string; args: string[] } {
  const fork = path.resolve(import.meta.dirname, "../../../vendor/codex/codex-rs/target/debug",
    platform === "win32" ? "codex.exe" : "codex");
  const executable = env.CROSSLINE_CODEX_PATH ?? fork;
  if (!path.isAbsolute(executable) || !exists(executable)) throw new Error("CODEX_FORK_BINARY_NOT_FOUND");
  if (sha256(executable) !== CODEX_FORK_BINARY_SHA256) throw new Error("CODEX_FORK_BINARY_MISMATCH");
  return { command: executable, args: [] };
}

export async function startCodexAppServer(): Promise<{
  client: JsonLineRpcClient;
  process: ChildProcessWithoutNullStreams;
  forkVerified: true;
  initializeResult: unknown;
  onExit: (handler: () => void) => () => void;
  stop: () => void;
}> {
  const env = codexProcessEnvironment();
  mkdirSync(env.CODEX_HOME!, { recursive: true });
  const codex = resolveCodexCommand(env);
  const child = spawn(codex.command, [...codex.args, "app-server", "--listen", "stdio://", "--strict-config"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env
  });
  const client = new JsonLineRpcClient((line) => child.stdin.write(line));
  const lines = createInterface({ input: child.stdout });
  const exitHandlers = new Set<() => void>();
  let stopped = false;
  let exited = false;
  const observeExit = () => {
    if (exited) return;
    exited = true;
    client.disconnect(new Error("CODEX_APP_SERVER_EXITED"));
    if (!stopped) for (const handler of exitHandlers) handler();
  };
  lines.on("line", (line) => client.receiveLine(line));
  child.stderr.resume();
  child.once("error", observeExit);
  child.once("exit", observeExit);
  const initializeResult = await client.request("initialize", {
    clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
  client.notify("initialized");
  return {
    client,
    process: child,
    forkVerified: true as const,
    initializeResult,
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    stop: () => {
      stopped = true;
      client.disconnect(new Error("CODEX_APP_SERVER_STOPPED"));
      lines.close();
      child.kill();
    }
  };
}

export type CodexRpcBoundary = Pick<JsonLineRpcClient, "request" | "onNotification">;

type CodexSidecar = {
  client: CodexRpcBoundary;
  initializeResult: unknown;
  forkVerified?: true;
  onExit: (handler: () => void) => () => void;
  stop: () => void;
};

type SafeCodexBlocker = { code: string; message: string };

type LoginStatus = {
  loginId: string;
  state: "pending" | "completed" | "failed" | "canceled";
  startedAt: string;
  updatedAt: string;
  blocker?: SafeCodexBlocker;
};

export type CodexSupervisorStatus = {
  state: "ready" | "blocked";
  login: LoginStatus | null;
  accountRevision: number;
  blocker?: SafeCodexBlocker;
  plugin: { name: string; requiredSkills: string[]; discoveredSkills: string[]; state: "installed" | "blocked" } | null;
  contract: {
    runtimeVersion: string;
    sourceBaseline: string;
    generatedProtocolSha256: string;
    contractTestResult: "passed";
    relationStatus: "verified" | "unverified";
  };
  /** Regenerated every boot — never itself capability-gated, since a caller needs this to sign a
   * capability's `supervisorBootId` claim in the first place. See `capability.ts`. */
  supervisorBootId: string;
};

export type CodexSupervisor = {
  url: string;
  /** The current cost reading, or an explicit unavailable — never an assumed zero. */
  readCostSignal: () => Promise<CostSignal>;
  /** The owned sidecar, so background work runs on the same isolated runtime as everything else. */
  client: CodexRpcBoundary;
  stop: () => Promise<void>;
};

export type LocalPluginContract = {
  name: string;
  marketplacePath: string;
  cwd: string;
  requiredSkills: string[];
};

async function installLocalPlugin(client: CodexRpcBoundary, plugin: LocalPluginContract): Promise<string[]> {
  try {
    await client.request("plugin/install", { marketplacePath: plugin.marketplacePath, pluginName: plugin.name });
  } catch { throw new Error("CODEX_PLUGIN_INSTALL_FAILED"); }
  let listed: unknown;
  try { listed = await client.request("skills/list", { cwds: [plugin.cwd], forceReload: true }); }
  catch { throw new Error("CODEX_SKILL_LIST_FAILED"); }
  const entries = record(listed)?.data;
  if (!Array.isArray(entries)) throw new Error("CODEX_SKILL_LIST_FAILED");
  const names = new Set(entries.flatMap((entry) => {
    const skills = record(entry)?.skills;
    return Array.isArray(skills) ? skills.map((skill) => record(skill)?.name).filter((name): name is string => typeof name === "string") : [];
  }));
  return [...names].sort();
}

/** Reads a small JSON body. Capped because this listener is reachable by anything on the loopback. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64_000) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function runtimeVersion(initializeResult: unknown): string {
  const result = record(initializeResult);
  return typeof result?.userAgent === "string" ? result.userAgent : "unknown";
}

function loginStartResult(value: unknown): { type: "chatgpt"; loginId: string; authUrl: string } {
  const result = record(value);
  if (result?.type !== "chatgpt" || typeof result.loginId !== "string" || typeof result.authUrl !== "string") {
    throw new Error("CODEX_LOGIN_RESPONSE_INVALID");
  }
  return { type: "chatgpt", loginId: result.loginId, authUrl: result.authUrl };
}

export async function startCodexSupervisor(options: {
  host?: "127.0.0.1";
  port?: number;
  sidecarFactory?: () => Promise<CodexSidecar>;
  analyzeCapture?: (client: CodexRpcBoundary, id: string, signal: AbortSignal) => Promise<unknown>;
  proposeMilestones?: (client: CodexRpcBoundary, request: string, signal: AbortSignal) => Promise<unknown>;
  backplanGoal?: (client: CodexRpcBoundary, milestoneId: string, signal: AbortSignal) => Promise<unknown>;
  prepareMaterials?: (workOrderId: string) => Promise<unknown>;
  judgeMilestone?: (workOrderId: string) => Promise<unknown>;
  syncCalendar?: () => Promise<unknown>;
  /** The accounts and calendars available, with what is currently ticked. A read. */
  listCalendarSources?: () => Promise<unknown>;
  /** Replaces the ticked set with exactly these `<accountId>:<calendarId>` keys. */
  saveCalendarSources?: (keys: string[]) => Promise<unknown>;
  plugin?: LocalPluginContract;
  /**
   * When set, every request must carry a valid `x-crossline-capability` token signed with this secret
   * (see `capability.ts`) — closes the loopback port off to anything but the web app's own already-
   * authenticated routes. Left unset in tests that are not exercising this boundary, the same way
   * `plugin` is optional; the real worker always provides it (`apps/worker/src/index.ts`).
   */
  capabilitySecret?: string;
} = {}): Promise<CodexSupervisor> {
  const host = options.host ?? "127.0.0.1";
  // Regenerated every boot: a token signed before a crash or restart must not still be honoured after
  // recovery, and a fresh id is the cheapest way to guarantee that without tracking process lifetimes.
  const supervisorBootId = randomUUID();
  const sidecar = await (options.sidecarFactory ?? startCodexAppServer)();
  let login: LoginStatus | null = null;
  let accountRevision = 0;
  let runtimeBlocker: SafeCodexBlocker | undefined;
  let pluginState: CodexSupervisorStatus["plugin"] = null;
  if (options.plugin) {
    try {
      const discoveredSkills = await installLocalPlugin(sidecar.client, options.plugin);
      if (options.plugin.requiredSkills.some((name) => !discoveredSkills.includes(name))) throw Object.assign(new Error("CODEX_PLUGIN_SKILLS_MISSING"), { discoveredSkills });
      pluginState = { name: options.plugin.name, requiredSkills: options.plugin.requiredSkills, discoveredSkills, state: "installed" };
    } catch (error) {
      const code = error instanceof Error && /^CODEX_[A-Z_]+$/.test(error.message) ? error.message : "CODEX_PLUGIN_INSTALL_FAILED";
      runtimeBlocker = { code, message: code === "CODEX_PLUGIN_SKILLS_MISSING"
        ? "Crossline plugin 已安装，但必需 Skill 不完整。" : code === "CODEX_SKILL_LIST_FAILED"
          ? "Crossline plugin 已安装，但无法核验 Skill。" : "Crossline plugin 安装失败。" };
      const discoveredSkills = Array.isArray((error as { discoveredSkills?: unknown }).discoveredSkills)
        ? (error as { discoveredSkills: string[] }).discoveredSkills : [];
      pluginState = { name: options.plugin.name, requiredSkills: options.plugin.requiredSkills, discoveredSkills, state: "blocked" };
    }
  }
  const analyses = new Map<string, AbortController>();
  let proposing: AbortController | undefined;
  // Material preparation also runs on the tick loop; this set is what stops a person's retry click and
  // the tick that lands two seconds later from preparing the same order twice.
  const preparing = new Set<string>();
  const judging = new Set<string>();
  let syncing = false;
  /**
   * Starts a job whose answer the caller is not waiting for, and swallows its failure on purpose.
   *
   * These two routes reply 202 and let the job finish in the background, so nothing is left holding
   * the promise. `void p.finally(...)` looks like it detaches but the derived promise still rejects,
   * and since Node 15 an unhandled rejection terminates the process by default — one 现在判定 click on
   * an order the store then refuses (`GATE_ALREADY_APPLIED`, `EVIDENCE_REVIEW_NOT_READY`) would have
   * taken the whole worker down. The outcome of both jobs is written to the ledger, which is where the
   * UI reads it from, so the throw itself carries no information the person needs.
   */
  const runDetached = (start: () => Promise<unknown>, done: () => void): void => {
    void (async () => {
      try { await start(); }
      catch (error) {
        console.warn(JSON.stringify({ type: "supervisor.detached_job_failed",
          message: error instanceof Error ? error.message : "" }));
      } finally { done(); }
    })();
  };
  const contract: CodexSupervisorStatus["contract"] = {
    runtimeVersion: runtimeVersion(sidecar.initializeResult),
    sourceBaseline: CODEX_BASELINE_COMMIT,
    generatedProtocolSha256: CODEX_GENERATED_PROTOCOL_SHA256,
    contractTestResult: "passed",
    relationStatus: sidecar.forkVerified === true ? "verified" : "unverified"
  };
  const unsubscribe = sidecar.client.onNotification((message) => {
    const params = record(message.params);
    const updatedAt = new Date().toISOString();
    if (message.method === "account/login/completed" && login) {
      const loginId = typeof params?.loginId === "string" ? params.loginId : null;
      if (loginId === null || loginId === login.loginId) {
        login = params?.success === true
          ? { ...login, state: "completed", updatedAt }
          : {
              ...login,
              state: "failed",
              updatedAt,
              blocker: { code: "CODEX_LOGIN_FAILED", message: "Codex login failed" }
            };
      }
    }
    if (message.method === "account/updated") accountRevision += 1;
  });
  const unsubscribeExit = sidecar.onExit(() => {
    runtimeBlocker = { code: "CODEX_RUNTIME_EXITED", message: "Codex app-server exited" };
  });
  const status = (): CodexSupervisorStatus => runtimeBlocker
    ? { state: "blocked", login, accountRevision, blocker: runtimeBlocker, plugin: pluginState, contract, supervisorBootId }
    : { state: "ready", login, accountRevision, plugin: pluginState, contract, supervisorBootId };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    try {
      // The one route every other one depends on being reachable without a capability: a caller needs
      // this to learn `supervisorBootId` before it can sign one at all. Low sensitivity by design (see
      // `CodexSupervisorStatus`'s own fields) — nothing here is an action or an account secret.
      if (request.method === "GET" && pathname === "/v1/codex/status") {
        sendJson(response, 200, status());
        return;
      }
      if (options.capabilitySecret) {
        const verified = verifyCapability(request.headers["x-crossline-capability"] as string | undefined,
          options.capabilitySecret, { operation: `${request.method} ${pathname}`, supervisorBootId });
        if (!verified.ok) {
          sendJson(response, 401, { blocker: { code: verified.code, message: "Use the local Web API" } });
          return;
        }
      }
      const analysisRoute = /^\/v1\/captures\/([a-zA-Z0-9_-]{1,128})\/analyze$/.exec(pathname);
      if (analysisRoute && options.analyzeCapture) {
        const id = analysisRoute[1]!;
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "ANALYSIS_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (request.method === "DELETE") {
          analyses.get(id)?.abort();
          sendJson(response, 200, { canceled: analyses.has(id) });
          return;
        }
        if (request.method === "POST") {
          if (runtimeBlocker) { sendJson(response, 503, { blocker: runtimeBlocker }); return; }
          // Only the request that started the run owns the entry. A duplicate reuses the signal but must
          // not deregister it, or cancelling the still-running first analysis would silently do nothing.
          const running = analyses.get(id);
          const controller = running ?? new AbortController();
          if (!running) analyses.set(id, controller);
          // Answered as soon as the run is under way, not when it finishes. The analyzer marks the
          // capture `analyzing` before its first await, so that is a true reading of the ledger — and
          // holding a browser request open for the whole five-minute Skill budget would time out in the
          // browser long before the Skill did, which is what made a slow-but-fine analysis look broken.
          // The run is never cancelled here: it keeps going and writes its own outcome to the ledger.
          const run = options.analyzeCapture(sidecar.client, id, controller.signal)
            .finally(() => { if (!running && analyses.get(id) === controller) analyses.delete(id); });
          run.catch(() => {});
          const settled = await Promise.race([
            run.catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000))
          ]);
          sendJson(response, 200, settled ?? { state: "analyzing" });
          return;
        }
      }
      // Retry-now for material preparation. Without it the retry button only wrote an event and the
      // person watched an unchanged screen until the next 15-minute tick — which reads as "the button
      // does nothing", the exact failure the button was added to fix.
      const prepareRoute = /^\/v1\/work-orders\/([a-zA-Z0-9_-]{1,128})\/prepare-materials$/.exec(pathname);
      if (request.method === "POST" && prepareRoute && options.prepareMaterials) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "MATERIALS_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (runtimeBlocker) { sendJson(response, 503, { blocker: runtimeBlocker }); return; }
        const id = prepareRoute[1]!;
        if (preparing.has(id)) {
          sendJson(response, 409, { blocker: { code: "MATERIALS_ALREADY_PREPARING", message: "该作业的材料准备已在运行" } });
          return;
        }
        // Answered immediately, not when the run finishes: preparation takes minutes, and the outcome
        // is written to the ledger either way, so making the browser hold a request open for it would
        // buy nothing and time out. The UI reads the result from the ledger like everything else.
        preparing.add(id);
        runDetached(() => options.prepareMaterials!(id), () => preparing.delete(id));
        sendJson(response, 202, { started: true });
        return;
      }
      // Same reason as prepare-materials: the tick is fifteen minutes away, and "submit evidence, then
      // watch 「等待里程碑闸门」 for a quarter of an hour" is indistinguishable from nothing happening.
      const gateRoute = /^\/v1\/work-orders\/([a-zA-Z0-9_-]{1,128})\/milestone-gate$/.exec(pathname);
      if (request.method === "POST" && gateRoute && options.judgeMilestone) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "GATE_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (runtimeBlocker) { sendJson(response, 503, { blocker: runtimeBlocker }); return; }
        const id = gateRoute[1]!;
        if (judging.has(id)) {
          sendJson(response, 409, { blocker: { code: "GATE_ALREADY_RUNNING", message: "该作业的闸门判定已在运行" } });
          return;
        }
        judging.add(id);
        runDetached(() => options.judgeMilestone!(id), () => judging.delete(id));
        sendJson(response, 202, { started: true });
        return;
      }
      // Which calendars exist and which are read. Separate from the sync because listing is cheap and
      // safe to do while looking at a settings page, whereas a sync rewrites the plan's reality lane.
      if (request.method === "GET" && pathname === "/v1/calendar/sources" && options.listCalendarSources) {
        try { sendJson(response, 200, await options.listCalendarSources()); }
        catch (error) {
          sendJson(response, 502, { blocker: { code: "GRAPH_CALENDARS_UNAVAILABLE",
            message: error instanceof Error ? error.message : "读取日历列表失败" } });
        }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/calendar/sources" && options.saveCalendarSources) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const body = await readJsonBody(request).catch(() => undefined) as { keys?: unknown } | undefined;
        const keys = Array.isArray(body?.keys) ? body.keys.filter((key): key is string => typeof key === "string") : undefined;
        if (!keys) {
          sendJson(response, 400, { blocker: { code: "CALENDAR_KEYS_REQUIRED", message: "需要 keys 数组" } });
          return;
        }
        try { sendJson(response, 200, await options.saveCalendarSources(keys)); }
        catch (error) {
          sendJson(response, 502, { blocker: { code: "GRAPH_CALENDARS_UNAVAILABLE",
            message: error instanceof Error ? error.message : "保存日历选择失败" } });
        }
        return;
      }
      // Pull the calendar now. The tick is fifteen minutes wide, which makes "change your calendar and
      // watch the plan react" untestable in one sitting and, day to day, makes a plan that is already
      // stale look current. This is a read: `GraphReadSource` has no write methods at all.
      if (request.method === "POST" && pathname === "/v1/calendar/sync" && options.syncCalendar) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (syncing) {
          sendJson(response, 409, { blocker: { code: "SYNC_ALREADY_RUNNING", message: "日历同步已在运行" } });
          return;
        }
        syncing = true;
        // Awaited, unlike the two Skill routes: a calendar read takes a second or two, and the person
        // clicked it to find out what changed, so the answer is worth waiting for.
        try { sendJson(response, 200, await options.syncCalendar()); }
        catch (error) {
          sendJson(response, 502, { blocker: { code: "GRAPH_SYNC_FAILED",
            message: error instanceof Error ? error.message : "日历同步失败" } });
        } finally { syncing = false; }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/milestones/propose" && options.proposeMilestones) {
        // Same origin and content-type guard the analyze route uses: this boundary is for the local
        // Web API only, never for a browser that wandered onto the loopback port.
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "PROPOSAL_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (runtimeBlocker) { sendJson(response, 503, { blocker: runtimeBlocker }); return; }
        // One proposal run at a time: this Skill is premium-budget and a second concurrent run would
        // spend the window twice to answer the same question.
        if (proposing) {
          sendJson(response, 409, { blocker: { code: "PROPOSAL_ALREADY_RUNNING", message: "已有一次里程碑提议在运行" } });
          return;
        }
        const body = await readJsonBody(request);
        const controller = new AbortController();
        proposing = controller;
        try { sendJson(response, 200, await options.proposeMilestones(sidecar.client, String(body?.request ?? ""), controller.signal)); }
        finally { if (proposing === controller) proposing = undefined; }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/goals/backplan" && options.backplanGoal) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "BACKPLAN_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (runtimeBlocker) { sendJson(response, 503, { blocker: runtimeBlocker }); return; }
        if (proposing) { sendJson(response, 409, { blocker: { code: "PROPOSAL_ALREADY_RUNNING", message: "已有一次提议在运行" } }); return; }
        const body = await readJsonBody(request);
        const controller = new AbortController();
        proposing = controller;
        try { sendJson(response, 200, await options.backplanGoal(sidecar.client, String(body?.milestoneId ?? ""), controller.signal)); }
        finally { if (proposing === controller) proposing = undefined; }
        return;
      }
      // Discretionary spending needs a reading it can refuse on, so this stays available even while
      // the runtime is blocked: an unreachable runtime is itself an "unavailable" cost signal.
      if (request.method === "GET" && pathname === "/v1/codex/cost") {
        if (runtimeBlocker) {
          sendJson(response, 200, { available: false, reason: runtimeBlocker.code });
          return;
        }
        sendJson(response, 200, await readCostSignal(sidecar.client));
        return;
      }
      if (runtimeBlocker) {
        sendJson(response, 503, { blocker: runtimeBlocker });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/codex/account") {
        sendJson(response, 200, await sidecar.client.request("account/read", { refreshToken: false }));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/codex/login") {
        const result = loginStartResult(await sidecar.client.request("account/login/start", {
          type: "chatgpt",
          appBrand: "codex",
          codexStreamlinedLogin: true,
          useHostedLoginSuccessPage: true
        }));
        const now = new Date().toISOString();
        login = { loginId: result.loginId, state: "pending", startedAt: now, updatedAt: now };
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && pathname === "/v1/codex/login/cancel") {
        if (!login || login.state !== "pending") {
          sendJson(response, 409, {
            blocker: { code: "CODEX_LOGIN_NOT_PENDING", message: "No Codex login is pending" }
          });
          return;
        }
        const result = await sidecar.client.request("account/login/cancel", { loginId: login.loginId });
        login = { ...login, state: "canceled", updatedAt: new Date().toISOString() };
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { blocker: { code: "CODEX_SUPERVISOR_ROUTE_NOT_FOUND", message: "Route not found" } });
    } catch {
      sendJson(response, 503, {
        blocker: runtimeBlocker ?? { code: "CODEX_APP_SERVER_REQUEST_FAILED", message: "Codex app-server request failed" }
      });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 3211, host, resolve);
    });
  } catch (error) {
    unsubscribe();
    unsubscribeExit();
    sidecar.stop();
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    client: sidecar.client,
    readCostSignal: async () => runtimeBlocker
      ? { available: false, reason: runtimeBlocker.code }
      : readCostSignal(sidecar.client),
    stop: async () => {
      for (const controller of analyses.values()) controller.abort();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      unsubscribe();
      unsubscribeExit();
      sidecar.stop();
    }
  };
}
