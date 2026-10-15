import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { readCostSignal } from "./cost";
import { verifyCapability } from "./capability";
import { enterUsageWorkspace } from "./usage";
import { CALENDAR_APPS, calendarAppStatuses, type CostSignal } from "@crossline/core";
import { createRuntimeRegistry, type RuntimeRegistry, type RuntimeSidecar } from "./runtime-registry";
export * from "./skill-runner";
export * from "./style";
export * from "./usage";
export * from "./analysis";
export * from "./cost";
export * from "./model-policy";
export * from "./capability";
export * from "./agent-mode";
export * from "./runtime-registry";
export * from "./prices";
export * from "./providers";
export * from "./model-gateway";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

export class JsonLineRpcClient {
  #nextId = 1;
  readonly #writeLine: (line: string) => void;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #notificationHandlers = new Set<(message: Record<string, unknown>) => void>();
  #disconnectError: Error | undefined;
  #serverRequestHandler: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined;

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

  /**
   * Answers the runtime's own requests (approvals, permission asks, elicitations). They carry an `id` and a `method`, which is what tells
   * them from a response to ours. Until a handler is set, or if it throws, the runtime gets an error back rather than silence: a run
   * waiting on an approval nobody answers would otherwise sit there until its timeout.
   */
  onServerRequest(handler: (method: string, params: unknown) => unknown | Promise<unknown>): () => void {
    this.#serverRequestHandler = handler;
    return () => { if (this.#serverRequestHandler === handler) this.#serverRequestHandler = undefined; };
  }

  async #answerServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      if (!this.#serverRequestHandler) throw new Error("no handler for server requests");
      const result = await this.#serverRequestHandler(method, params);
      this.#writeLine(`${JSON.stringify({ id, result: result ?? {} })}
`);
    } catch (error) {
      this.#writeLine(`${JSON.stringify({ id, error: { code: -32601, message: error instanceof Error ? error.message : "request refused" } })}
`);
    }
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
    // The method check comes first: a request from the runtime has an id of its own, which can equal one of ours still in flight.
    if (message.id !== undefined && typeof message.method === "string") { void this.#answerServerRequest(message.id, message.method, message.params); return; }
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
/** The release build of the same pinned source that the installed copy ships (docs/local-installer.md, Codex 的 Release 构建). */
export const CODEX_RELEASE_BINARY_SHA256 = "ce19ac66ee6204888bf6318f0ae1b02f83b35f512ca5144f1e8bf42b9f7b11b9";

export function codexProcessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  localAppData = base.LOCALAPPDATA
): NodeJS.ProcessEnv {
  // An installed copy (docs/local-installer.md) points CROSSLINE_STATE_DIR at its own folder, so on a machine that also runs a
  // checkout's resident app the two never share a Codex login, its memories or guest homes.
  const stateDir = base.CROSSLINE_STATE_DIR?.trim();
  let crosslineHome: string;
  if (stateDir) crosslineHome = path.win32.join(stateDir, "codex-home");
  else {
    if (!localAppData) throw new Error("LOCALAPPDATA_UNAVAILABLE");
    const isPackagedRedirect = /\\packages\\[^\\]+\\localcache\\local$/i.test(localAppData);
    const durableLocalAppData = isPackagedRedirect && base.USERPROFILE
      ? path.win32.join(base.USERPROFILE, "AppData", "Local")
      : localAppData;
    crosslineHome = path.win32.join(durableLocalAppData, "Crossline", "codex-home");
  }
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
  const hash = sha256(executable);
  if (hash !== CODEX_FORK_BINARY_SHA256 && hash !== CODEX_RELEASE_BINARY_SHA256) throw new Error("CODEX_FORK_BINARY_MISMATCH");
  return { command: executable, args: [] };
}

/**
 * Web research runs through the runtime's code-mode host, a second program it starts from beside its own
 * executable. A fork built without it answers every search with "failed to spawn code-mode host", which a model
 * then reports as "the research tool is unavailable" and returns an empty report, so the cause never reached
 * the person. Checked up front, the answer names the file and where it goes.
 */
export function webResearchBlocker(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: string = process.platform
): { code: string; message: string } | undefined {
  const executable = env.CROSSLINE_CODEX_PATH ?? path.resolve(import.meta.dirname, "../../../vendor/codex/codex-rs/target/debug",
    platform === "win32" ? "codex.exe" : "codex");
  // The platform's own path rules, not the host's: a Windows path checked on Linux has no "/" to split on.
  const p = platform === "win32" ? path.win32 : path.posix;
  const host = p.join(p.dirname(executable), platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host");
  if (exists(host)) return undefined;
  return { code: "WEB_RESEARCH_HOST_MISSING",
    message: `联网查证需要 ${host}，但它不在那里，网页搜索无法启动。把已安装 Codex 应用 bin 目录里的 codex-code-mode-host.exe 复制到这个位置，或在 vendor/codex 里构建 codex-code-mode-host。` };
}

export async function startCodexAppServer(codexHome?: string): Promise<{
  client: JsonLineRpcClient;
  process: ChildProcessWithoutNullStreams;
  forkVerified: true;
  initializeResult: unknown;
  onExit: (handler: () => void) => () => void;
  stop: () => void;
}> {
  // A guest account's runtime runs in its own home (runtime-registry.ts): its own auth.json and memories, never the owner's.
  const env = { ...codexProcessEnvironment(), ...(codexHome ? { CODEX_HOME: codexHome, CROSSLINE_CODEX_HOME: codexHome } : {}) };
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

export type CodexRpcBoundary = Pick<JsonLineRpcClient, "request" | "onNotification"> & Partial<Pick<JsonLineRpcClient, "onServerRequest">>;

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
  /** The current cost reading for a workspace (the owner's when omitted), or an explicit unavailable — never an assumed zero. */
  readCostSignal: (workspaceId?: string) => Promise<CostSignal>;
  /** The owner's runtime: the machine's own Codex, which the owner's workspace keeps. */
  client: CodexRpcBoundary;
  /** The runtime serving a workspace, if it is running; a guest's starts through `runtimes.client`. */
  clientFor: (workspaceId: string) => CodexRpcBoundary | undefined;
  runtimes?: RuntimeRegistry;
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
async function readJsonBody(request: IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return undefined;
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

/**
 * For a run that can take minutes. The caller's fetch gives up when nothing has arrived for five minutes, and a
 * Skill is allowed ten, so the status line goes out at once and a space follows every twenty seconds to keep the
 * body alive; JSON ignores leading whitespace. Every outcome this route can have is already a typed result in the
 * body (`blocked` carries its code), so the status is 200 either way, and a throw becomes one more blocked result
 * instead of a second set of headers.
 */
async function sendJsonWhenReady(response: ServerResponse, work: () => Promise<unknown>): Promise<void> {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  const beat = setInterval(() => { if (!response.writableEnded) response.write(" "); }, 20_000);
  try { response.end(JSON.stringify(await work())); }
  catch { response.end(JSON.stringify({ state: "blocked", code: "SUPERVISOR_RUN_FAILED", message: "这次运行没有完成，可以重试。" })); }
  finally { clearInterval(beat); }
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
  analyzeCapture?: (client: CodexRpcBoundary, id: string, signal: AbortSignal, workspaceId: string) => Promise<unknown>;
  /** The tick's classification of new captures, run now. The web app calls it right after a capture is written. */
  autoAnalyzeCaptures?: (workspaceId: string) => Promise<unknown>;
  /** Works backwards from approved milestones due soon (see `milestonesAwaitingBackplan`); answered at once. */
  autoBackplanGoals?: (workspaceId: string) => Promise<unknown>;
  /** Step planning, replans asked for, and progress reports, run now (the person just asked for one); answered at once. */
  runTaskPass?: (workspaceId: string) => Promise<unknown>;
  /** Splits adopted long-term goals that have no attributes yet (once per goal), run now instead of at the next tick; answered at once. */
  splitGoals?: (workspaceId: string) => Promise<unknown>;
  /**
   * One turn of the one input box (docs/one-input.md): the person's text, the web's snapshot and context pack in; the reply, proposed
   * actions and question back out. Nothing is written but the conversation's thread id.
   */
  conciergeTurn?: (workspaceId: string, request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  /** Hands a work order to the assistant. Answers at once: the task runs on, and writes its own outcome to the ledger. */
  dispatchAgentTask?: (workspaceId: string, workOrderId: string, category?: string, stepId?: string) => unknown;
  /** A running assistant task's progress so far (commands, changed files, searches), or undefined once it has ended. */
  agentProgress?: (workspaceId: string, taskId: string) => unknown;
  /** Stops a running assistant task (「中止」). */
  cancelAgentTask?: (workspaceId: string, taskId: string) => { ok: boolean };
  /** Runs an assistant task again with the person's words (and the checks or items to redo), under the pause, quota and busy rules. */
  retryAgentTask?: (workspaceId: string, taskId: string, input: { note?: string; only?: string[] }) => Promise<{ ok: boolean; [key: string]: unknown }>;
  /**
   * A grown workflow, by hand (docs/skills-library.md §6): `login` opens a browser window of its own for the person to log in to a site
   * it reads; `run` starts it now. Both answer at once.
   */
  workflowAction?: (workspaceId: string, id: string, action: "login" | "login_done" | "run", service: string) => { ok: boolean; [key: string]: unknown };
  /** The person asked for a workflow in words: grow it now rather than at the next tick. Answers at once. */
  growWorkflows?: (workspaceId: string) => void;
  /** Writes plan blocks to the person's Crossline calendar. Only blocks; never touches any other calendar or event. */
  publishCalendar?: (workspaceId: string, blocks: Array<{ id: string; title: string; start: string; end: string; note?: string; reminderMinutes?: number | null;
    recurrence?: { daysOfWeek: string[]; startDate: string; endDate: string; localStart: string; localEnd: string; timeZone: string } }>,
    scope: "work" | "fixed") => Promise<unknown>;
  proposeMilestones?: (client: CodexRpcBoundary, request: string, signal: AbortSignal, workspaceId: string, only?: string[]) => Promise<unknown>;
  continueMilestoneConversation?: (client: CodexRpcBoundary, threadId: string, message: string, signal: AbortSignal, workspaceId: string) => Promise<unknown>;
  /** One turn of the profile interview: the person's message in, the saved turn out. The conversation and
   * everything it learned live in the ledger, so the browser holds only a session id. */
  onboardingTurn?: (client: CodexRpcBoundary, sessionId: string, text: string, signal: AbortSignal,
    workspaceId: string, reread: boolean) => Promise<unknown>;
  /** Researches one line on the web and stores a report of sourced findings. One run at a time per workspace. */
  runDiligence?: (client: CodexRpcBoundary, identityId: string, force: boolean, workspaceId: string) => Promise<unknown>;
  /** Pulls the text out of an uploaded file the web app has already stored and recorded. No model involved,
   * so it needs no Codex runtime and is not subject to the runtime blocker. */
  extractSource?: (documentId: string, workspaceId: string) => Promise<unknown>;
  /** Whether recordings can be turned into text on this machine yet, and if not what is missing. */
  transcriptionStatus?: () => Promise<unknown>;
  /** Starts the one-time model download and answers at once; progress shows in `transcriptionStatus`. */
  startTranscriptionDownload?: () => Promise<unknown>;
  /** Fire-and-forget from the web app's own capture route (`POST /api/commands`) right after a capture
   * is written — never surfaced to the capturing person, so this has no "already running" guard the way
   * onboarding does; concurrent captures compacting at once is the normal case, not a conflict. */
  extractBackgroundFacts?: (client: CodexRpcBoundary, captureTitle: string, captureContext: string,
    signal: AbortSignal, workspaceId: string) => Promise<unknown>;
  backplanGoal?: (client: CodexRpcBoundary, milestoneId: string, signal: AbortSignal, workspaceId: string) => Promise<unknown>;
  // `workspaceId` is the real caller's, taken from its own verified capability token — never the
  // worker's own idea of "the" workspace, which is what let every one of these silently operate on a
  // single hardcoded legacy workspace regardless of who actually asked.
  prepareMaterials?: (workOrderId: string, workspaceId: string) => Promise<unknown>;
  /** Builds (or rebuilds) a committed task's tutorial without moving its state: the step-by-step guide and the analysis of its materials. */
  buildTutorial?: (workOrderId: string, workspaceId: string) => Promise<unknown>;
  /** Writes (or rewrites) the portrait report from the interview; answered at once, the page follows the ledger. */
  writePortrait?: (workspaceId: string) => Promise<unknown>;
  judgeMilestone?: (workOrderId: string, workspaceId: string) => Promise<unknown>;
  explainPlan?: (today: string, workspaceId: string, ranking?: unknown) => Promise<unknown>;
  runWeeklyInsight?: (workspaceId: string) => Promise<unknown>;
  syncCalendar?: (workspaceId: string) => Promise<unknown>;
  /** The accounts and calendars available, with what is currently ticked. A read. */
  listCalendarSources?: (workspaceId: string) => Promise<unknown>;
  /** Replaces the ticked set with exactly these `<accountId>:<calendarId>` keys. */
  saveCalendarSources?: (workspaceId: string, keys: string[]) => Promise<unknown>;
  /** Folders the person authorized: a preview before anything is read, then added (read in the background), removed, or given lines. */
  sourceFolders?: {
    preview: (workspaceId: string, path: string) => Promise<unknown>;
    add: (workspaceId: string, path: string) => Promise<unknown>;
    remove: (workspaceId: string, id: string) => Promise<unknown>;
    setLines: (workspaceId: string, id: string, lines: string[]) => Promise<unknown>;
  };
  /** Signing in the account that holds the Crossline calendar by device code: the code goes to the page and the person signs in there. */
  calendarWriteLogin?: { start: (workspaceId: string) => Promise<unknown>; status: (workspaceId: string) => unknown };
  /** Calendars read from a subscription link: added after one read (the link goes to the worker's secret store), and removed. */
  calendarSubscriptions?: {
    add: (workspaceId: string, input: { link: string; label: string }) => Promise<unknown>;
    remove: (workspaceId: string, id: string) => Promise<unknown>;
  };
  plugin?: LocalPluginContract;
  /**
   * When set, every request must carry a valid `x-crossline-capability` token signed with this secret
   * (see `capability.ts`) — closes the loopback port off to anything but the web app's own already-
   * authenticated routes. Left unset in tests that are not exercising this boundary, the same way
   * `plugin` is optional; the real worker always provides it (`apps/worker/src/index.ts`).
   */
  capabilitySecret?: string;
  /**
   * Each account's own Codex (`runtime-registry.ts`). Absent, every workspace is served by the one runtime, as before accounts existed
   * (tests that do not exercise this). The worker always sets it.
   */
  runtimes?: { baseDir: string; ownerWorkspaceId: () => string | undefined; start?: (codexHome: string) => Promise<RuntimeSidecar>;
    maxRunning?: number; idleMs?: number; hasProvider?: (workspaceId: string) => boolean };
  /**
   * A workspace's own model provider (R7, providers.ts): its routes under `/v1/model/provider*`, answered for the caller's workspace,
   * and the quota reading that replaces the Codex one while a provider serves that workspace.
   */
  modelProviders?: {
    handle: (method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined) => Promise<{ status: number; body: unknown } | undefined>;
    cost: (workspaceId: string) => CostSignal | undefined;
  };
  /** This month's spend and cap for a workspace on a pay-per-use (API key) login, which reports no quota windows of its own. */
  monthSpend?: (workspaceId: string) => { spent: number; cap: number };
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
  const runtimes = options.runtimes ? createRuntimeRegistry({ owner: sidecar, ownerWorkspaceId: options.runtimes.ownerWorkspaceId,
    baseDir: options.runtimes.baseDir, ...(options.runtimes.maxRunning ? { maxRunning: options.runtimes.maxRunning } : {}),
    ...(options.runtimes.idleMs ? { idleMs: options.runtimes.idleMs } : {}),
    ...(options.runtimes.hasProvider ? { hasProvider: options.runtimes.hasProvider } : {}),
    // A guest's runtime gets the same Crossline plugin the owner's has.
    start: options.runtimes.start ?? (async (home) => {
      const started = await startCodexAppServer(home);
      if (options.plugin) await installLocalPlugin(started.client, options.plugin);
      return started;
    }) }) : undefined;
  const isOwner = (workspaceId: string) => !runtimes || runtimes.isOwner(workspaceId);
  /** The runtime that serves this workspace's model work, or a 503 that says why there is none (and undefined). */
  const modelClient = async (response: ServerResponse, workspaceId: string): Promise<CodexRpcBoundary | undefined> => {
    if (isOwner(workspaceId)) {
      if (runtimeBlocker) { sendJson(response, 503, { blocker: runtimeBlocker }); return undefined; }
      return sidecar.client;
    }
    const runtime = await runtimes!.client(workspaceId);
    if (!runtime.ok) { sendJson(response, 503, { blocker: runtime.blocker }); return undefined; }
    return runtime.client;
  };
  /**
   * A runtime's quota. A ChatGPT login reports its windows; an API key reports none (the runtime refuses the read), so its month's
   * spend against the person's cap is the reading instead — before this, an API-key login read as "unavailable" and every background
   * pass stopped without a word.
   */
  const costFor = async (client: CodexRpcBoundary, workspaceId: string): Promise<CostSignal> => {
    const provided = options.modelProviders?.cost(workspaceId);
    if (provided) return provided;
    const signal = await readCostSignal(client);
    if (signal.available || !options.monthSpend) return signal;
    const account = record(record(await client.request("account/read", { refreshToken: false }).catch(() => undefined))?.account);
    if (account?.type !== "apiKey") return signal;
    const { spent, cap } = options.monthSpend(workspaceId);
    const month = new Date();
    const resetsAt = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) / 1000;
    return { available: true, limitReached: spent >= cap, money: { spent, cap },
      long: { usedPercent: cap > 0 ? Math.min(100, (spent / cap) * 100) : 100, windowDurationMins: null, resetsAt } };
  };
  /** A guest's quota, read from its own runtime; an account that has not connected one has none to read. */
  const guestCost = async (workspaceId: string): Promise<CostSignal> => {
    const provided = options.modelProviders?.cost(workspaceId);
    if (provided) return provided;
    if (!runtimes!.connected(workspaceId)) return { available: false, reason: "RUNTIME_UNCONNECTED" };
    const runtime = await runtimes!.client(workspaceId);
    return runtime.ok ? costFor(runtime.client, workspaceId) : { available: false, reason: runtime.blocker.code };
  };
  const analyses = new Map<string, AbortController>();
  let proposing: AbortController | undefined;
  let conversing: AbortController | undefined;
  // One profile-interview turn at a time per workspace: a second click while one is running would race on the
  // same Codex thread and the same message sequence.
  const profileTurns = new Set<string>();
  const diligenceRuns = new Set<string>();
  // Material preparation also runs on the tick loop; this set is what stops a person's retry click and
  // the tick that lands two seconds later from preparing the same order twice.
  const preparing = new Set<string>();
  const judging = new Set<string>();
  const explaining = new Set<string>();
  const insighting = new Set<string>();
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
      // Empty when no `capabilitySecret` is configured at all — the pre-stage-four "no enforcement"
      // mode a chunk of this file's own tests still exercise on purpose. Every route below that needs to
      // know *which* workspace asked (prepare-materials, milestone-gate, calendar) uses this rather than
      // any workspace id the worker itself might otherwise have hardcoded — that hardcoding was the bug.
      let callerWorkspaceId = "";
      if (options.capabilitySecret) {
        const verified = verifyCapability(request.headers["x-crossline-capability"] as string | undefined,
          options.capabilitySecret, { operation: `${request.method} ${pathname}`, supervisorBootId });
        if (!verified.ok) {
          sendJson(response, 401, { blocker: { code: verified.code, message: "Use the local Web API" } });
          return;
        }
        callerWorkspaceId = verified.capability.workspaceId;
      }
      // Every Skill run this request starts is attributed to the workspace that asked for it.
      if (callerWorkspaceId) enterUsageWorkspace(callerWorkspaceId);
      if (request.method === "POST" && pathname === "/v1/captures/auto-analyze" && options.autoAnalyzeCaptures) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "ANALYSIS_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        runDetached(() => options.autoAnalyzeCaptures!(callerWorkspaceId), () => {});
        sendJson(response, 202, { started: true });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/conversation/turn" && options.conciergeTurn) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "CONVERSATION_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        // The context pack is the person's whole open state, so larger than the other bodies; the caller is already verified above.
        const body = await readJsonBody(request, 2_000_000);
        if (!body || typeof body.text !== "string" || !body.text.trim() || typeof body.conversationId !== "string" || typeof body.pack !== "object") {
          sendJson(response, 400, { blocker: { code: "CONVERSATION_TURN_INVALID", message: "缺少会话、内容或上下文" } });
          return;
        }
        const controller = new AbortController();
        try { await sendJsonWhenReady(response, () => options.conciergeTurn!(callerWorkspaceId, body, controller.signal)); }
        finally { controller.abort(); }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/tasks/pass" && options.runTaskPass) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "TASK_PASS_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        runDetached(() => options.runTaskPass!(callerWorkspaceId), () => {});
        sendJson(response, 202, { started: true });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/lines/split-goals" && options.splitGoals) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "GOAL_SPLIT_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        runDetached(() => options.splitGoals!(callerWorkspaceId), () => {});
        sendJson(response, 202, { started: true });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/goals/auto-backplan" && options.autoBackplanGoals) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "BACKPLAN_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        runDetached(() => options.autoBackplanGoals!(callerWorkspaceId), () => {});
        sendJson(response, 202, { started: true });
        return;
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
          const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
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
          const run = options.analyzeCapture(rt, id, controller.signal, callerWorkspaceId)
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
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const id = prepareRoute[1]!;
        if (preparing.has(id)) {
          sendJson(response, 409, { blocker: { code: "MATERIALS_ALREADY_PREPARING", message: "该作业的材料准备已在运行" } });
          return;
        }
        // Answered immediately, not when the run finishes: preparation takes minutes, and the outcome
        // is written to the ledger either way, so making the browser hold a request open for it would
        // buy nothing and time out. The UI reads the result from the ledger like everything else.
        preparing.add(id);
        runDetached(() => options.prepareMaterials!(id, callerWorkspaceId), () => preparing.delete(id));
        sendJson(response, 202, { started: true });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/portrait" && options.writePortrait) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "PORTRAIT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const key = `portrait:${callerWorkspaceId}`;
        if (preparing.has(key)) { sendJson(response, 409, { blocker: { code: "PORTRAIT_ALREADY_WRITING", message: "画像报告正在生成" } }); return; }
        preparing.add(key);
        runDetached(() => options.writePortrait!(callerWorkspaceId), () => preparing.delete(key));
        sendJson(response, 202, { started: true });
        return;
      }
      const tutorialRoute = /^\/v1\/work-orders\/([a-zA-Z0-9_-]{1,128})\/tutorial$/.exec(pathname);
      if (request.method === "POST" && tutorialRoute && options.buildTutorial) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "MATERIALS_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const id = tutorialRoute[1]!;
        if (preparing.has(id)) { sendJson(response, 409, { blocker: { code: "MATERIALS_ALREADY_PREPARING", message: "该任务的教程已在生成" } }); return; }
        preparing.add(id);
        runDetached(() => options.buildTutorial!(id, callerWorkspaceId), () => preparing.delete(id));
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
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const id = gateRoute[1]!;
        if (judging.has(id)) {
          sendJson(response, 409, { blocker: { code: "GATE_ALREADY_RUNNING", message: "该作业的闸门判定已在运行" } });
          return;
        }
        judging.add(id);
        runDetached(() => options.judgeMilestone!(id, callerWorkspaceId), () => judging.delete(id));
        sendJson(response, 202, { started: true });
        return;
      }
      // Explains the schedule the deterministic scheduler already produced — one run per workspace, not
      // per work order, so the dedup key is the caller's own workspace rather than a path segment.
      const explainRoute = /^\/v1\/plan\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/explain$/.exec(pathname);
      if (request.method === "POST" && explainRoute && options.explainPlan) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "PLAN_EXPLAIN_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const today = explainRoute[1]!;
        if (explaining.has(callerWorkspaceId)) {
          sendJson(response, 409, { blocker: { code: "PLAN_EXPLAIN_ALREADY_RUNNING", message: "计划解释已在运行" } });
          return;
        }
        const body = await readJsonBody(request).catch(() => undefined) as { ranking?: unknown } | undefined;
        explaining.add(callerWorkspaceId);
        runDetached(() => options.explainPlan!(today, callerWorkspaceId, Array.isArray(body?.ranking) ? body.ranking : undefined),
          () => explaining.delete(callerWorkspaceId));
        sendJson(response, 202, { started: true });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/review/weekly-insight" && options.runWeeklyInsight) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "WEEKLY_INSIGHT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        if (insighting.has(callerWorkspaceId)) {
          sendJson(response, 409, { blocker: { code: "WEEKLY_INSIGHT_ALREADY_RUNNING", message: "周复盘洞察已在运行" } });
          return;
        }
        insighting.add(callerWorkspaceId);
        runDetached(() => options.runWeeklyInsight!(callerWorkspaceId), () => insighting.delete(callerWorkspaceId));
        sendJson(response, 202, { started: true });
        return;
      }
      // Whether this account's runtime has Google / Outlook calendar connected in ChatGPT, and where to connect it. Two reads that run
      // no model turn: `app/installed` and `app/read` by id. Never `app/list` — its directory call meets a Cloudflare challenge.
      if (request.method === "GET" && pathname === "/v1/apps/calendar") {
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        try {
          const [installed, metadata] = await Promise.all([
            rt.request("app/installed", { forceRefresh: true }),
            rt.request("app/read", { appIds: CALENDAR_APPS.map((item) => item.connectorId) }).catch(() => undefined)
          ]);
          sendJson(response, 200, { apps: calendarAppStatuses(installed, metadata) });
        } catch (error) {
          sendJson(response, 502, { blocker: { code: "APPS_UNAVAILABLE", message: error instanceof Error ? error.message : "读取连接状态失败" } });
        }
        return;
      }
      // Which calendars exist and which are read. Separate from the sync because listing is cheap and
      // safe to do while looking at a settings page, whereas a sync rewrites the plan's reality lane.
      if (request.method === "GET" && pathname === "/v1/calendar/sources" && options.listCalendarSources) {
        try { sendJson(response, 200, await options.listCalendarSources(callerWorkspaceId)); }
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
        try { sendJson(response, 200, await options.saveCalendarSources(callerWorkspaceId, keys)); }
        catch (error) {
          sendJson(response, 502, { blocker: { code: "GRAPH_CALENDARS_UNAVAILABLE",
            message: error instanceof Error ? error.message : "保存日历选择失败" } });
        }
        return;
      }
      // Authorized folders (docs/onboarding-v3.md 「文件夹授权」). The path is the person's own, typed on this machine; the worker checks it
      // (absolute, an existing folder, not a drive, the user folder, a system folder or the app's own data) before walking anything.
      if (pathname.startsWith("/v1/sources/folders") && options.sourceFolders) {
        if (request.headers.origin || (request.method !== "DELETE" && !request.headers["content-type"]?.startsWith("application/json"))) {
          sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const folders = options.sourceFolders;
        const one = /^\/v1\/sources\/folders\/([A-Za-z0-9-]{1,40})(\/lines)?$/.exec(pathname);
        try {
          if (request.method === "POST" && (pathname === "/v1/sources/folders/preview" || pathname === "/v1/sources/folders")) {
            const body = await readJsonBody(request).catch(() => undefined) as { path?: unknown } | undefined;
            if (typeof body?.path !== "string" || !body.path.trim() || body.path.length > 1000) {
              sendJson(response, 400, { blocker: { code: "FOLDER_PATH_REQUIRED", message: "需要文件夹路径" } });
              return;
            }
            sendJson(response, 200, await (pathname.endsWith("/preview") ? folders.preview(callerWorkspaceId, body.path) : folders.add(callerWorkspaceId, body.path)));
            return;
          }
          if (request.method === "DELETE" && one && !one[2]) { sendJson(response, 200, await folders.remove(callerWorkspaceId, one[1]!)); return; }
          if (request.method === "POST" && one?.[2]) {
            const body = await readJsonBody(request).catch(() => undefined) as { lines?: unknown } | undefined;
            const lines = Array.isArray(body?.lines) ? body.lines.filter((line): line is string => typeof line === "string" && line.length <= 80) : undefined;
            if (!lines) { sendJson(response, 400, { blocker: { code: "FOLDER_LINES_REQUIRED", message: "需要 lines 数组" } }); return; }
            sendJson(response, 200, await folders.setLines(callerWorkspaceId, one[1]!, lines));
            return;
          }
        } catch { sendJson(response, 502, { blocker: { code: "FOLDER_FAILED", message: "文件夹操作没有完成" } }); return; }
      }
      // A subscription link (docs/onboarding-v3.md 「日历接入」): read once here before it is kept, so a link that does not open is refused
      // now rather than failing every tick. The answer is awaited: a read takes a second or two and the person is waiting for it.
      if (request.method === "POST" && pathname === "/v1/calendar/subscriptions" && options.calendarSubscriptions) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const body = await readJsonBody(request).catch(() => undefined) as { link?: unknown; label?: unknown } | undefined;
        if (typeof body?.link !== "string" || body.link.length > 2000) {
          sendJson(response, 400, { blocker: { code: "ICAL_LINK_INVALID", message: "需要日历链接" } });
          return;
        }
        try { sendJson(response, 200, await options.calendarSubscriptions.add(callerWorkspaceId, { link: body.link, label: typeof body.label === "string" ? body.label : "" })); }
        catch { sendJson(response, 502, { blocker: { code: "ICAL_ADD_FAILED", message: "没能接入这个日历" } }); }
        return;
      }
      const subscriptionMatch = /^\/v1\/calendar\/subscriptions\/([A-Za-z0-9-]{1,40})$/.exec(pathname);
      if (request.method === "DELETE" && subscriptionMatch && options.calendarSubscriptions) {
        if (request.headers.origin) {
          sendJson(response, 403, { blocker: { code: "SYNC_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        try { sendJson(response, 200, await options.calendarSubscriptions.remove(callerWorkspaceId, subscriptionMatch[1]!)); }
        catch { sendJson(response, 502, { blocker: { code: "ICAL_REMOVE_FAILED", message: "没能移除这个日历" } }); }
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
        try { sendJson(response, 200, await options.syncCalendar(callerWorkspaceId)); }
        catch (error) {
          sendJson(response, 502, { blocker: { code: "GRAPH_SYNC_FAILED",
            message: error instanceof Error ? error.message : "日历同步失败" } });
        } finally { syncing = false; }
        return;
      }
      if (pathname === "/v1/calendar/write-login" && options.calendarWriteLogin && (request.method === "GET" || request.method === "POST")) {
        if (request.method === "GET") { sendJson(response, 200, options.calendarWriteLogin.status(callerWorkspaceId)); return; }
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "CALENDAR_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        sendJson(response, 200, await options.calendarWriteLogin.start(callerWorkspaceId));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/calendar/publish" && options.publishCalendar) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "CALENDAR_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const body = await readJsonBody(request);
        const raw = Array.isArray(body?.blocks) ? body!.blocks as unknown[] : [];
        const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
        const blocks = raw.flatMap((entry) => {
          const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
          return typeof row.id === "string" && row.id.length <= 200 && typeof row.title === "string" && row.title.length > 0 && iso(row.start) && iso(row.end) && Date.parse(row.end as string) > Date.parse(row.start as string)
            ? [{ id: row.id, title: row.title.slice(0, 200), start: row.start as string, end: row.end as string, ...(typeof row.note === "string" ? { note: row.note.slice(0, 500) } : {}),
              ...(typeof row.reminderMinutes === "number" && Number.isInteger(row.reminderMinutes) && row.reminderMinutes >= 0 && row.reminderMinutes <= 1440 ? { reminderMinutes: row.reminderMinutes } : {}),
              ...(recurrenceOf(row.recurrence) ? { recurrence: recurrenceOf(row.recurrence)! } : {}) }] : [];
        }).slice(0, 300);
        // `fixed`: the person's own fixed events, managed apart from the plan's work blocks, so publishing one never removes the other.
        sendJson(response, 200, await options.publishCalendar(callerWorkspaceId, blocks, body?.scope === "fixed" ? "fixed" : "work"));
        return;
      }
      const agentTaskRoute = /^\/v1\/agent\/tasks\/([a-zA-Z0-9_-]{1,128})\/(progress|cancel|retry)$/.exec(pathname);
      if (agentTaskRoute && request.method === "GET" && agentTaskRoute[2] === "progress" && options.agentProgress) {
        sendJson(response, 200, { progress: options.agentProgress(callerWorkspaceId, agentTaskRoute[1]!) ?? null });
        return;
      }
      if (agentTaskRoute && request.method === "POST" && agentTaskRoute[2] === "cancel" && options.cancelAgentTask) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "AGENT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const result = options.cancelAgentTask(callerWorkspaceId, agentTaskRoute[1]!);
        sendJson(response, result.ok ? 200 : 409, result);
        return;
      }
      if (agentTaskRoute && request.method === "POST" && agentTaskRoute[2] === "retry" && options.retryAgentTask) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "AGENT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const body = await readJsonBody(request).catch(() => undefined);
        const note = typeof body?.note === "string" ? body.note.slice(0, 4000) : "";
        const only = Array.isArray(body?.only) ? body.only.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
        const result = await options.retryAgentTask(callerWorkspaceId, agentTaskRoute[1]!, { ...(note ? { note } : {}), ...(only.length ? { only } : {}) });
        sendJson(response, result.ok ? 200 : 409, result);
        return;
      }
      if (request.method === "POST" && pathname === "/v1/workflows/grow" && options.growWorkflows) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "AGENT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        options.growWorkflows(callerWorkspaceId);
        sendJson(response, 202, { ok: true });
        return;
      }
      const workflowRoute = /^\/v1\/workflows\/([a-zA-Z0-9_-]{1,128})\/(login|login_done|run)$/.exec(pathname);
      if (workflowRoute && request.method === "POST" && options.workflowAction) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "AGENT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        if (workflowRoute[2] === "run") { const rt = await modelClient(response, callerWorkspaceId); if (!rt) return; }
        const body = await readJsonBody(request);
        const result = options.workflowAction(callerWorkspaceId, workflowRoute[1]!, workflowRoute[2] as "login" | "login_done" | "run",
          typeof body?.service === "string" ? body.service.slice(0, 40) : "");
        // Refusals are answers ({ok:false, code, message}), so the page can say why.
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && pathname === "/v1/agent/dispatch" && options.dispatchAgentTask) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "AGENT_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const body = await readJsonBody(request);
        const workOrderId = typeof body?.workOrderId === "string" ? body.workOrderId : "";
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workOrderId)) { sendJson(response, 400, { blocker: { code: "AGENT_ORDER_INVALID", message: "缺少任务编号。" } }); return; }
        sendJson(response, 200, options.dispatchAgentTask(callerWorkspaceId, workOrderId, typeof body?.category === "string" ? body.category : undefined,
          typeof body?.stepId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.stepId) ? body.stepId : undefined));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/milestones/propose" && options.proposeMilestones) {
        // Same origin and content-type guard the analyze route uses: this boundary is for the local
        // Web API only, never for a browser that wandered onto the loopback port.
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "PROPOSAL_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        // One proposal run at a time: this Skill is premium-budget and a second concurrent run would
        // spend the window twice to answer the same question.
        if (proposing) {
          sendJson(response, 409, { blocker: { code: "PROPOSAL_ALREADY_RUNNING", message: "已有一次里程碑提议在运行" } });
          return;
        }
        const body = await readJsonBody(request);
        const controller = new AbortController();
        proposing = controller;
        try { await sendJsonWhenReady(response, () => options.proposeMilestones!(rt, String(body?.request ?? ""), controller.signal, callerWorkspaceId,
          Array.isArray(body?.only) ? (body!.only as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 8) : undefined)); }
        finally { if (proposing === controller) proposing = undefined; }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/milestones/propose/continue" && options.continueMilestoneConversation) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "PROPOSAL_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        if (conversing) {
          sendJson(response, 409, { blocker: { code: "PROPOSAL_ALREADY_RUNNING", message: "已有一次对话在运行" } });
          return;
        }
        const body = await readJsonBody(request);
        const threadId = String(body?.threadId ?? "");
        const message = String(body?.message ?? "");
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId) || !message.trim()) {
          sendJson(response, 400, { blocker: { code: "PROPOSAL_CONVERSATION_INVALID", message: "缺少 threadId 或消息内容" } });
          return;
        }
        const controller = new AbortController();
        conversing = controller;
        try { await sendJsonWhenReady(response, () => options.continueMilestoneConversation!(rt, threadId, message, controller.signal, callerWorkspaceId)); }
        finally { if (conversing === controller) conversing = undefined; }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/onboarding/turn" && options.onboardingTurn) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "ONBOARDING_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const body = await readJsonBody(request);
        const sessionId = String(body?.sessionId ?? "");
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
          sendJson(response, 400, { blocker: { code: "ONBOARDING_TURN_INVALID", message: "缺少会话 id" } });
          return;
        }
        if (profileTurns.has(callerWorkspaceId)) {
          sendJson(response, 409, { blocker: { code: "ONBOARDING_ALREADY_RUNNING", message: "上一轮还在处理，请稍等。" } });
          return;
        }
        profileTurns.add(callerWorkspaceId);
        const controller = new AbortController();
        try { await sendJsonWhenReady(response, () => options.onboardingTurn!(rt, sessionId, String(body?.text ?? "").slice(0, 4000), controller.signal, callerWorkspaceId, body?.reread === true)); }
        finally { profileTurns.delete(callerWorkspaceId); }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/diligence/run" && options.runDiligence) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "DILIGENCE_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const body = await readJsonBody(request).catch(() => undefined);
        const identityId = String(body?.identityId ?? "");
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(identityId)) {
          sendJson(response, 400, { blocker: { code: "DILIGENCE_REQUEST_INVALID", message: "缺少主线 id" } });
          return;
        }
        if (diligenceRuns.has(callerWorkspaceId)) {
          sendJson(response, 409, { blocker: { code: "DILIGENCE_ALREADY_RUNNING", message: "正在做尽调，请稍等。" } });
          return;
        }
        diligenceRuns.add(callerWorkspaceId);
        try { await sendJsonWhenReady(response, () => options.runDiligence!(rt, identityId, body?.force === true, callerWorkspaceId)); }
        finally { diligenceRuns.delete(callerWorkspaceId); }
        return;
      }
      if (request.method === "POST" && pathname === "/v1/sources/extract" && options.extractSource) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "SOURCE_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const body = await readJsonBody(request);
        const documentId = String(body?.documentId ?? "");
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) {
          sendJson(response, 400, { blocker: { code: "SOURCE_EXTRACT_INVALID", message: "缺少文档 id" } });
          return;
        }
        sendJson(response, 200, await options.extractSource(documentId, callerWorkspaceId));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/background-facts/extract" && options.extractBackgroundFacts) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "BACKGROUND_FACTS_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        const body = await readJsonBody(request);
        const captureTitle = String(body?.captureTitle ?? "");
        const captureContext = String(body?.captureContext ?? "");
        const controller = new AbortController();
        sendJson(response, 200, await options.extractBackgroundFacts(rt, captureTitle, captureContext, controller.signal, callerWorkspaceId));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/goals/backplan" && options.backplanGoal) {
        if (request.headers.origin || !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { blocker: { code: "BACKPLAN_REQUEST_FORBIDDEN", message: "Use the local Web API" } });
          return;
        }
        const rt = await modelClient(response, callerWorkspaceId); if (!rt) return;
        if (proposing) { sendJson(response, 409, { blocker: { code: "PROPOSAL_ALREADY_RUNNING", message: "已有一次提议在运行" } }); return; }
        const body = await readJsonBody(request);
        const controller = new AbortController();
        proposing = controller;
        try { sendJson(response, 200, await options.backplanGoal(rt, String(body?.milestoneId ?? ""), controller.signal, callerWorkspaceId)); }
        finally { if (proposing === controller) proposing = undefined; }
        return;
      }
      if (options.modelProviders && pathname.startsWith("/v1/model/provider")) {
        const answer = await options.modelProviders.handle(request.method ?? "GET", pathname, callerWorkspaceId,
          request.method === "GET" ? undefined : await readJsonBody(request));
        if (answer) { sendJson(response, answer.status, answer.body); return; }
      }
      // Discretionary spending needs a reading it can refuse on, so this stays available even while
      // the runtime is blocked: an unreachable runtime is itself an "unavailable" cost signal.
      if (request.method === "GET" && pathname === "/v1/codex/cost") {
        if (!isOwner(callerWorkspaceId)) { sendJson(response, 200, await guestCost(callerWorkspaceId)); return; }
        if (runtimeBlocker) {
          sendJson(response, 200, { available: false, reason: runtimeBlocker.code });
          return;
        }
        sendJson(response, 200, await costFor(sidecar.client, callerWorkspaceId));
        return;
      }
      // A guest's own Codex: connect (ChatGPT in the browser, a device code, or an API key), see it, cancel, sign out.
      if (!isOwner(callerWorkspaceId) && pathname.startsWith("/v1/codex/")) {
        const workspace = callerWorkspaceId;
        if (request.method === "GET" && pathname === "/v1/codex/account") {
          const running = runtimes!.connected(workspace) ? await runtimes!.client(workspace) : undefined;
          const account = running?.ok ? await running.client.request("account/read", { refreshToken: false }) : { account: null, requiresOpenaiAuth: true };
          // `guest`: this account runs on its own Codex, which it can sign out of here (the owner's is the machine's own).
          sendJson(response, 200, { ...(record(account) ?? {}), login: runtimes!.loginStatus(workspace), guest: true });
          return;
        }
        if (request.method === "POST" && pathname === "/v1/codex/login") {
          const body = record(await readJsonBody(request));
          const method = body?.type === "apiKey" && typeof body.apiKey === "string" && body.apiKey.trim() ? { type: "apiKey" as const, apiKey: body.apiKey.trim() }
            : body?.type === "chatgpt" ? { type: "chatgpt" as const } : { type: "chatgptDeviceCode" as const };
          try { sendJson(response, 200, await runtimes!.login(workspace, method)); }
          catch (error) { sendJson(response, 503, { blocker: { code: error instanceof Error && /^RUNTIME_/.test(error.message) ? error.message : "RUNTIME_LOGIN_FAILED", message: "登录没有开始" } }); }
          return;
        }
        if (request.method === "POST" && pathname === "/v1/codex/login/cancel") { await runtimes!.cancelLogin(workspace); sendJson(response, 200, { ok: true }); return; }
        if (request.method === "POST" && pathname === "/v1/codex/logout") { await runtimes!.logout(workspace); sendJson(response, 200, { ok: true }); return; }
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
    ...(runtimes ? { runtimes } : {}),
    clientFor: (workspaceId: string) => isOwner(workspaceId) ? sidecar.client : runtimes!.current(workspaceId),
    readCostSignal: async (workspaceId = "") => !isOwner(workspaceId) ? guestCost(workspaceId) : runtimeBlocker
      ? { available: false, reason: runtimeBlocker.code }
      : costFor(sidecar.client, workspaceId),
    stop: async () => {
      for (const controller of analyses.values()) controller.abort();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      unsubscribe();
      unsubscribeExit();
      runtimes?.stopAll();
      sidecar.stop();
    }
  };
}

/** A weekly series as the web sent it, shape-checked: weekday names, two days and two clock times in order, and a zone name. */
function recurrenceOf(value: unknown): { daysOfWeek: string[]; startDate: string; endDate: string; localStart: string; localEnd: string; timeZone: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const day = (text: unknown) => typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text);
  const time = (text: unknown) => typeof text === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
  const weekdays = Array.isArray(row.daysOfWeek) ? row.daysOfWeek.filter((item): item is string => typeof item === "string" && days.includes(item)) : [];
  if (!weekdays.length || !day(row.startDate) || !day(row.endDate) || !time(row.localStart) || !time(row.localEnd) || String(row.localEnd) <= String(row.localStart)
    || typeof row.timeZone !== "string" || !/^[A-Za-z_/+\- ]{1,64}$/.test(row.timeZone)) return undefined;
  return { daysOfWeek: weekdays, startDate: row.startDate as string, endDate: row.endDate as string, localStart: row.localStart as string, localEnd: row.localEnd as string, timeZone: row.timeZone };
}
