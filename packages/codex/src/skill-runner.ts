import { mkdirSync, writeFileSync } from "node:fs";
import { STYLE_INSTRUCTIONS } from "./style";
import { join } from "node:path";
import { cleanAnswerStrings } from "@crossline/core";
import type { CodexRpcBoundary } from "./index";
import { routeForSkill, tierForSkill, tierRoutes, type ModelRoute, type RouteTier, type SpendMode } from "./model-policy";
import { createUsageCollector, currentSpendMode, reportUsage, type UsageCollector } from "./usage";

import { registerAgentThread, type AgentMode } from "./agent-mode";

export type AnalysisAudit = { threadId?: string; turnId?: string;
  /** How many times a turn went silent for so long it was interrupted and sent again. Absent means none did. */
  stalls?: number;
  /** How many times the validator sent the answer back to be fixed. Absent means it passed first try. */
  repairs?: number;
  /**
   * Content-quality problems the answer still had when the repairs ran out and the caller chose to keep it (`softAccept`). The
   * caller records them for the reviewer; nothing was blocked for them.
   */
  warnings?: Array<{ code: string; detail: string }> };
export type SkillRunResult<T> = { ok: true; output: T; audit: AnalysisAudit }
  | { ok: false; blocker: { code: string; message: string }; audit: AnalysisAudit };

/**
 * Everything a Skill run needs that differs between Skills. Transport, isolation, the tool guard and
 * the blocker vocabulary are shared, because duplicating them is how one of two copies quietly loses
 * a guarantee the other one keeps.
 */
export type SkillRunOptions<T> = {
  skillName: string;
  cwd: string;
  developerInstructions: string;
  outputSchema: unknown;
  /** Validated before the turn starts; whatever it returns is what gets sent. */
  prepareInput: (input: unknown) => unknown;
  /** The trust boundary: the runtime proving a shape is not the same as the content being right. */
  validateOutput: (output: unknown, prepared: unknown) => T;
  /**
   * Called when the repairs are spent and the last rejection is still standing. A caller whose rejection was about content quality,
   * not about safety or about a shape it cannot store, returns the answer to keep (the run then succeeds with `audit.warnings`);
   * returning undefined keeps the refusal (decided 2026-10-07: quality checks warn, safety checks block).
   */
  softAccept?: (rejection: Error, output: unknown, prepared: unknown) => T | undefined;
  /** Only a Skill that must reach outside gets this; it is off for every other run. */
  allowWebSearch?: boolean;
  /**
   * Only the portrait illustrator gets this: the runtime's own image tool, on the person's ChatGPT sign-in like every other call. Each
   * finished image is handed to `onImage` (base64 PNG) as it arrives; nothing is written by the runner itself.
   */
  allowImageGeneration?: boolean;
  onImage?: (image: { base64: string; revisedPrompt: string }) => void;
  onAudit: (audit: AnalysisAudit) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Silence, in ms, after which a turn is treated as hung and sent again. Defaults to 20 minutes (`CROSSLINE_SKILL_IDLE_MINUTES`). */
  idleMs?: number;
  /** Set for the assistant: a thread with a shell and file access, working in `agent.cwd`, whose requests the guard answers. */
  agent?: AgentMode;
  /** Read-only tools the model may call during the turn (the one input box's lookups); see `SkillTools`. */
  tools?: SkillTools;
  /** Run on this tier instead of the Skill's own (the input box's second, stronger look). Ignored when the budget is tight. */
  tier?: RouteTier;
};

/**
 * Functions the model may call mid-turn (Codex dynamic tools: declared at `thread/start`, each call arriving as an `item/tool/call`
 * request about the thread). The caller answers with text; a throw is reported to the model as a failed call, never as a failed run.
 * Only read-only lookups belong here — anything that writes is an action the person confirms, not a tool.
 */
export type SkillTools = {
  specs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call: (name: string, args: unknown) => string | Promise<string>;
};

/** The runtime's request for one tool call, answered from `tools`; any other request about the thread is refused. */
function toolAnswerer(tools: SkillTools) {
  return async (method: string, params: Record<string, unknown>) => {
    if (method !== "item/tool/call") throw new Error("only tool calls are answered for this thread");
    const name = String(params.tool ?? "");
    if (!tools.specs.some((spec) => spec.name === name)) return { contentItems: [{ type: "inputText", text: `没有名为 ${name} 的工具` }], success: false };
    try {
      const text = await tools.call(name, params.arguments ?? {});
      return { contentItems: [{ type: "inputText", text: text.slice(0, 60_000) }], success: true };
    } catch (error) {
      return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : "查询失败" }], success: false };
    }
  };
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Writes what the model actually answered to `CROSSLINE_RECORD_DIR`, when that is set.
 *
 * Every test double in this repo answers with clean JSON somebody typed by hand, which is why three
 * acceptance rounds kept turning up defects the unit suite could not see: no test had ever been shown
 * a real answer. Recording is off unless the variable is set, costs one file write when it is on, and
 * captures the rejected answers too — those are the ones worth replaying.
 */
function recordAnswer(skillName: string, text: string | undefined): void {
  const dir = process.env.CROSSLINE_RECORD_DIR?.trim();
  if (!dir || text === undefined) return;
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${skillName.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}.txt`;
    writeFileSync(join(dir, name), text, "utf8");
  } catch { /* recording is a diagnostic; never fail a real run because the disk said no */ }
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function fail(code: string): never { throw new Error(code); }

type NativeSkill = { path: string; enabled: boolean };
/**
 * Runs wait in a lane per model tier, not in one line for everything. A ten-minute interview turn used to hold
 * a one-second plan explanation behind it; now the cheap lane moves while the heavy one works. Two runs of the
 * same Skill still never overlap, because a Skill belongs to exactly one tier.
 */
const skillLanes = new Map<string, Promise<void>>();
function serializeSkillRun<T>(skillName: string, run: () => Promise<T>): Promise<T> {
  // The assistant gets a lane of its own: a task that runs for an hour must not hold the capture analysis or the gate behind it.
  const lane = /crossline-agent$/.test(skillName) ? "agent" : tierForSkill(skillName) ?? "default";
  const previous = skillLanes.get(lane) ?? Promise.resolve();
  let release = () => {};
  skillLanes.set(lane, new Promise<void>((resolve) => { release = resolve; }));
  return previous.then(run).finally(release);
}

/**
 * Switching a Skill on or off rewrites the runtime's one config file, so two lanes doing it at once could write
 * over each other. The switch is brief; only it is held in a single line, never the run in between.
 */
let configChain: Promise<void> = Promise.resolve();
function underConfigLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = configChain;
  let release = () => {};
  configChain = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(work).finally(release);
}

/** What one run carries through its turns: the route it was given, and the meter. */
type RunContext = { route: ModelRoute | undefined; spendMode: SpendMode; usage: UsageCollector };
const DEFAULT_MAX_REPAIRS = 2;
/** No event of any kind for this long means a hung turn. Generous: slow work still produces events, silence does not. */
const DEFAULT_IDLE_MS = 20 * 60_000;
const MAX_STALL_RETRIES = 2;

/**
 * Everything the two entry points share: waiting in the right lane, switching the Skill on, running, switching
 * it back off, and reporting what the run used.
 */
async function executeSkill<T>(client: CodexRpcBoundary, options: { skillName: string; cwd: string; tier?: RouteTier },
  body: (context: RunContext) => Promise<SkillRunResult<T>>): Promise<SkillRunResult<T>> {
  return serializeSkillRun(options.skillName, async () => {
    const startedAt = Date.now();
    const spendMode = await currentSpendMode();
    // A stronger look is a cost the person did not ask for: in economy mode the Skill keeps its own route.
    const route = options.tier && spendMode === "normal" && process.env.CROSSLINE_MODEL_ROUTING?.trim().toLowerCase() !== "off"
      ? { ...tierRoutes()[options.tier] } : routeForSkill(options.skillName, process.env, spendMode);
    const context: RunContext = { route, spendMode, usage: createUsageCollector() };
    let skill: NativeSkill | undefined;
    let result: SkillRunResult<T>;
    try {
      skill = await underConfigLock(async () => {
        const found = await findNativeSkill(client, options.skillName, options.cwd);
        if (!found.enabled) await setNativeSkill(client, found.path, true);
        return found;
      });
      result = await body(context);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "";
      result = skillBlocker<T>(/^SKILL_(LIST_FAILED|MISSING|CONFIG_FAILED)$/.test(errorMessage) ? errorMessage : "SKILL_CONFIG_FAILED");
    }
    if (skill && !skill.enabled) {
      const path = skill.path;
      try { await underConfigLock(() => setNativeSkill(client, path, false)); }
      catch { result = skillBlocker<T>("SKILL_CONFIG_FAILED", result.audit); }
    }
    reportUsage({
      skillName: options.skillName, ...(tierForSkill(options.skillName) ? { tier: tierForSkill(options.skillName)! } : {}),
      ...(context.route ? { model: context.route.model, ...(context.route.effort ? { effort: context.route.effort } : {}) } : {}),
      spendMode, ...(result.audit.threadId ? { threadId: result.audit.threadId } : {}), ok: result.ok,
      ...(result.ok ? {} : { errorCode: result.blocker.code }), repairs: result.audit.repairs ?? 0, turns: context.usage.turns(),
      durationMs: Date.now() - startedAt, at: new Date(startedAt).toISOString(), turnSeconds: context.usage.turnSeconds(), ...context.usage.total()
    });
    return result;
  });
}

async function findNativeSkill(client: CodexRpcBoundary, name: string, cwd: string): Promise<NativeSkill> {
  let response: unknown;
  try { response = await client.request("skills/list", { cwds: [cwd], forceReload: true }); }
  catch { fail("SKILL_LIST_FAILED"); }
  const entries = record(response)?.data;
  if (!Array.isArray(entries)) fail("SKILL_LIST_FAILED");
  for (const entry of entries) {
    const skills = record(entry)?.skills;
    if (!Array.isArray(skills)) continue;
    const skill = skills.map(record).find((item) => item?.name === name);
    if (typeof skill?.path === "string" && typeof skill.enabled === "boolean") return { path: skill.path, enabled: skill.enabled };
  }
  fail("SKILL_MISSING");
}

async function setNativeSkill(client: CodexRpcBoundary, path: string, enabled: boolean): Promise<void> {
  try {
    const response = record(await client.request("skills/config/write", { path, enabled }));
    if (response?.effectiveEnabled !== enabled) fail("SKILL_CONFIG_FAILED");
  } catch { fail("SKILL_CONFIG_FAILED"); }
}

const skillBlocker = <T,>(code: string, audit: AnalysisAudit = {}): SkillRunResult<T> => ({
  ok: false,
  blocker: {
    code,
    message: code === "SKILL_MISSING" ? "Skill 未安装；请恢复 Crossline plugin 后重试。"
      : code === "SKILL_LIST_FAILED" ? "无法读取 Codex Skill 状态；请恢复运行时后重试。"
      : "无法隔离启用该 Skill；未开始运行。"
  },
  audit
});

/** Narrower than `SkillRunOptions`: a continued turn reuses an already-started thread, so there is no
 * `developerInstructions`/`allowWebSearch`/`prepareInput` to set up — those only ever apply at
 * `thread/start`, which this path never calls. */
export type ContinueTurnOptions<T> = {
  skillName: string;
  cwd: string;
  outputSchema: unknown;
  validateOutput: (output: unknown) => T;
  onAudit: (audit: AnalysisAudit) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleMs?: number;
  /** As `SkillRunOptions.softAccept`: keep part of an answer the repairs could not fix, when the problem is about content quality. */
  softAccept?: (rejection: Error, output: unknown) => T | undefined;
  /** The tools the thread was started with (they are declared at `thread/start`; this answers their calls on the follow-up turn). */
  tools?: SkillTools;
  /** As `SkillRunOptions.tier`. */
  tier?: RouteTier;
};

/**
 * The runtime keeps a conversation only while it runs. After a restart, a stored thread id answers
 * `thread not found`, which is a JSON-RPC error object rather than an Error, so it never matched the code
 * pattern and surfaced as a generic failure the person could not act on.
 */
function isThreadLost(error: unknown): boolean {
  const text = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message) : "";
  return /thread not found/i.test(text);
}

type Detailed = Error & { detail?: string };
const withDetail = (error: Error, detail: string | undefined): Error => {
  if (detail) (error as Detailed).detail = detail;
  return error;
};

/**
 * The caller's cancellation, plus a time limit that restarts for every step instead of running once for the whole run.
 *
 * It used to be one deadline from the first call to the last. A turn that wrote a long answer used up most of it, so the repair
 * that the validator then asked for had a few seconds left and a run that was nearly right timed out with nothing to show. Each RPC
 * and each turn now gets the full `timeoutMs` of its own; what bounds the whole run is the number of repairs, which is small.
 */
function openScope(client: CodexRpcBoundary, options: { timeoutMs?: number; signal?: AbortSignal }) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  let stopWaiting = () => {};
  const canceled = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error("SKILL_CANCELED"));
    const signal = options.signal;
    if (!signal) return;
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    stopWaiting = () => signal.removeEventListener("abort", abort);
  });
  // Never an unhandled rejection if nothing is racing it at the moment it fires.
  canceled.catch(() => {});
  /** A fresh window: rejects with `SKILL_TIMEOUT` after `timeoutMs` unless cleared. */
  const window = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SKILL_TIMEOUT")), timeoutMs); });
    promise.catch(() => {});
    return { promise, clear: () => { if (timer) clearTimeout(timer); } };
  };
  return {
    canceled,
    window,
    rpc: async (method: string, params: unknown): Promise<unknown> => {
      const limit = window();
      try { return await Promise.race([client.request(method, params), canceled, limit.promise]); }
      finally { limit.clear(); }
    },
    dispose: () => stopWaiting()
  };
}
type Scope = ReturnType<typeof openScope>;

async function requireLogin(scope: Scope): Promise<void> {
  const account = record(await scope.rpc("account/read", { refreshToken: false }));
  if (!record(account?.account)) fail("SKILL_UNAUTHENTICATED");
}

/**
 * The assistant's thread: full access to the person's account, in the task's own directory, with every tool the runtime has. The
 * approval policy is still `untrusted`, so each command that is not on the runtime's own short list of harmless ones comes to
 * `agent.answer` first — that is the hook the guard rails hang on — and `web_search` is live. Nothing here is a sandbox; see
 * `agent-guard.ts` for what the guard is and is not.
 */
async function startAgentThread<T>(scope: Scope, options: SkillRunOptions<T>, context: RunContext): Promise<string> {
  const agent = options.agent!;
  const config: Record<string, unknown> = {
    web_search: "live", include_environment_context: true,
    "memories.use_memories": false, "memories.generate_memories": false,
    "features.shell_tool": true, "features.web_search": true, "features.standalone_web_search": true, "features.plugins": true,
    "features.view_image": true, "features.apply_patch_freeform": true
  };
  const threadParams = {
    cwd: agent.cwd, sandbox: "danger-full-access", approvalPolicy: "untrusted", approvalsReviewer: "user",
    ephemeral: false, experimentalRawEvents: false, developerInstructions: options.developerInstructions,
    ...(context.route ? { model: context.route.model } : {})
  };
  let started: Record<string, unknown> | undefined;
  for (;;) {
    try { started = record(await scope.rpc("thread/start", { ...threadParams, config })); break; }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const field = /unknown configuration field `([^`]+)`/.exec(message)?.[1];
      const dropped = field ? Object.keys(config).filter((key) => key === field || key.startsWith(`${field}.`)) : [];
      if (!dropped.length) {
        if (/configuration|unknown variant/i.test(message)) throw withDetail(new Error("SKILL_CONFIG_REJECTED"), message.slice(0, 400));
        throw error;
      }
      for (const key of dropped) delete config[key];
    }
  }
  const threadId = record(started?.thread)?.id;
  if (!identifier(threadId)) fail("SKILL_PROTOCOL_INVALID");
  // The thread must really be running with the approval policy the guard hangs on; with `never` nothing would ever ask.
  if (started?.approvalPolicy !== "untrusted") fail("SKILL_PERMISSION_DENIED");
  return threadId;
}

/**
 * Starts the one thread a fresh run uses, with everything that makes it safe to run unattended: read-only sandbox, the
 * `untrusted` approval policy, no tools but the one granted, no instruction files, no MCP servers. Returns its id.
 */
async function startIsolatedThread<T>(scope: Scope, options: SkillRunOptions<T>, context: RunContext): Promise<string> {
  const runtimeConfig = record(record(await scope.rpc("config/read", { includeLayers: false }))?.config);
  if (!runtimeConfig) fail("SKILL_PROTOCOL_INVALID");
  const mcp = record(runtimeConfig.mcp_servers) ?? {};
  if (options.agent) return startAgentThread(scope, options, context);
  const config: Record<string, unknown> = {
    // "live", not "enabled": this runtime's `web_search` takes `disabled | cached | live`, and the
    // wrong variant made the whole thread/start fail — so the one Skill granted the web could never
    // start at all. A scout that must cite what it read needs `live` rather than `cached`.
    web_search: options.allowWebSearch ? "live" : "disabled", project_doc_max_bytes: 0, include_environment_context: false,
    // Cross-run memory, on by explicit user decision: every call used to be a clean-slate context for
    // reproducibility and audit, which is why this pair was `false`. Turning it on means the model's
    // own accumulated memory can now influence an answer — the same input is no longer guaranteed to
    // produce the same output — and that memory itself lives in Codex's own CODEX_HOME, not this app's
    // SQLite ledger, so it is outside `pnpm export`/`backup-crossline.ps1`. See the Connectors page for
    // the same disclosure surfaced where a person would actually see it.
    "memories.use_memories": true, "memories.generate_memories": true,
    "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
    "features.plugins": true, "features.memories": true,
    ...Object.fromEntries(["shell_tool", "multi_agent", "multi_agent_v2", "apps", "hooks", "codex_hooks", "plugin_hooks", "web_search", "standalone_web_search", "image_generation", "view_image", "request_permissions_tool", "tool_suggest", "token_budget", "current_time_reminder", "sleep_tool", "send_message_to_user_async", "js_repl", "code_mode", "deferred_executor"]
      .map((key) => [`features.${key}`, (Boolean(options.allowWebSearch) && (key === "web_search" || key === "standalone_web_search"))
        || (Boolean(options.allowImageGeneration) && key === "image_generation")])),
    ...Object.fromEntries(Object.keys(mcp).map((key) => [`mcp_servers.${key}.enabled`, false]))
  };
  const threadParams = {
    environments: [], runtimeWorkspaceRoots: [], sandbox: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "user",
    dynamicTools: (options.tools?.specs ?? []).map((spec) => ({ type: "function", name: spec.name, description: spec.description, inputSchema: spec.inputSchema })),
    ephemeral: false, experimentalRawEvents: false,
    developerInstructions: `${options.developerInstructions}\n\n${STYLE_INSTRUCTIONS}`,
    // Left unset for a Skill with no route, so an unlisted job still runs on the runtime's default.
    ...(context.route ? { model: context.route.model } : {})
  };
  // The flag list is written against the newest runtime, but `--strict-config` rejects the whole call
  // over one field an older runtime never defined. A field this runtime does not know names a feature
  // this runtime does not have, so dropping it removes no protection; the real guarantees are the
  // read-only sandbox, the untrusted approval policy and the tool-call guard. Any other error
  // still fails the analysis.
  let started: Record<string, unknown> | undefined;
  for (;;) {
    try { started = record(await scope.rpc("thread/start", { ...threadParams, config })); break; }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const field = /unknown configuration field `([^`]+)`/.exec(message)?.[1];
      const dropped = field ? Object.keys(config).filter((key) => key === field || key.startsWith(`${field}.`)) : [];
      if (!dropped.length) {
        // A field this runtime does not know can be dropped; a value it rejects cannot, because
        // dropping it would silently turn off the thing that was asked for. This used to surface as
        // a bare SKILL_RUNTIME_FAILED, which hid a one-word config mismatch behind a generic failure
        // for as long as nobody instrumented the call. The runtime's own text is config diagnostics,
        // not model output, so it is safe to carry.
        if (/configuration|unknown variant/i.test(message)) throw withDetail(new Error("SKILL_CONFIG_REJECTED"), message.slice(0, 400));
        throw error;
      }
      for (const key of dropped) delete config[key];
    }
  }
  const threadId = record(started?.thread)?.id;
  if (!identifier(threadId)) fail("SKILL_PROTOCOL_INVALID");
  if (started?.approvalPolicy !== "untrusted" || record(started.sandbox)?.type !== "readOnly" || !Array.isArray(started.instructionSources) || started.instructionSources.length) fail("SKILL_PERMISSION_DENIED");
  return threadId;
}

/**
 * The structured-output half of a run, shared by a fresh run and a continued conversation: send a prompt, take the model's
 * final message, parse it, hand it to the caller's validator — and when anything in that chain says no, send the rejection back
 * on the same thread and ask again, at most twice.
 *
 * What counts as a rejection is deliberately wide. The validator throwing is the obvious case, but an answer that is not
 * JSON at all (cut off, or repeating itself until the limit — the degeneration this repair loop exists for) is one too, and used
 * to end the run at once with no second chance. A timeout, a spent quota, a refusal or a forbidden tool call still ends it,
 * because asking again cannot fix any of them. `audit.repairs` records how often it happened: a schema that needs repair every
 * time is a schema problem, not a cost of doing business.
 */
async function runTurnsUntilValid<T>(client: CodexRpcBoundary, scope: Scope, context: RunContext, audit: AnalysisAudit, run: {
  skillName: string; threadId: string; outputSchema: unknown; allowedItemTypes: string[]; firstPrompt: string;
  validate: (output: unknown) => T; onAudit: (audit: AnalysisAudit) => void; idleMs?: number; agent?: AgentMode;
  soften?: (rejection: Error, output: unknown) => T | undefined;
  onImage?: (image: { base64: string; revisedPrompt: string }) => void;
}): Promise<T> {
  audit.threadId = run.threadId;
  let finalText: string | undefined;
  // The last time the runtime said anything at all about this thread. A turn with no event for a long while is not slow, it is hung:
  // a real run sat for over an hour with the runtime logging nothing, and only the wall-clock limit ended it.
  let lastEventAt = Date.now();
  const envIdle = Number(process.env.CROSSLINE_SKILL_IDLE_MINUTES);
  const idleMs = run.idleMs ?? (envIdle > 0 ? envIdle * 60_000 : DEFAULT_IDLE_MS);
  // One subscription, re-armed per turn: a repair is another turn on the same thread, so the handler stays put and each turn
  // hands it a fresh pair of callbacks to settle.
  let settle: { resolve: (text: string | undefined) => void; reject: (error: Error) => void } | undefined;
  // Turns this run gave up on (a stall interrupted them). Their late events — above all their own 「interrupted」 completion — belong to
  // no one: arriving before the resent turn has its id, that completion used to be read as the new turn's and ended a real assistant run
  // as 「已取消」 after 96 minutes.
  const abandoned = new Set<string>();
  const unsubscribe = client.onNotification((message) => {
    if (message.method === "crossline/runtimeDisconnected") return settle?.reject(new Error("SKILL_RUNTIME_EXITED"));
    const params = record(message.params);
    if (!params || params.threadId !== audit.threadId) return;
    lastEventAt = Date.now();
    const turn = record(params.turn);
    const turnId = params.turnId ?? turn?.id;
    if (typeof turnId === "string" && abandoned.has(turnId)) return;
    // Events can precede the turn/start response; capture only this isolated thread.
    if (audit.turnId && turnId !== audit.turnId) return;
    if (message.method === "thread/tokenUsage/updated") { context.usage.note(params); return; }
    if (message.method === "item/completed" || message.method === "item/started") {
      const item = record(params.item);
      if (item?.type === "agentMessage" && message.method === "item/completed" && (item.phase === "final_answer" || item.phase === null)) {
        if (typeof item.text !== "string" || item.text.length > 100_000) settle?.reject(new Error("SKILL_SCHEMA_INVALID"));
        else finalText = item.text;
      } else if (run.agent) {
        // The assistant is meant to use tools; what it did is recorded, not refused here (the guard answers each request).
        if (item) { try { run.agent.onItem(item, message.method === "item/started" ? "started" : "completed"); } catch { /* the audit must never fail the work */ } }
      } else if (item && !run.allowedItemTypes.includes(String(item.type))) settle?.reject(new Error("SKILL_TOOL_FORBIDDEN"));
      else if (item?.type === "imageGeneration" && message.method === "item/completed" && typeof item.result === "string" && item.result && run.onImage) {
        try { run.onImage({ base64: item.result, revisedPrompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : "" }); } catch { /* the caller's write failing is the caller's to notice */ }
      }
    }
    if (message.method === "turn/completed") {
      if (!identifier(turn?.id)) return settle?.reject(new Error("SKILL_PROTOCOL_INVALID"));
      if (turn.status === "completed") return settle?.resolve(finalText);
      const error = record(turn.error);
      const info = error?.codexErrorInfo;
      // A spent quota is neither a refusal nor a bug, and calling it one would misreport the only thing the user can act on:
      // waiting, or buying more credits. A turn the runtime rejected outright is not a refusal either — calling it one hid a
      // malformed request behind a word that means the model declined to answer.
      settle?.reject(withDetail(new Error(turn.status === "interrupted" ? "SKILL_CANCELED"
        : info === "unauthorized" ? "SKILL_UNAUTHENTICATED"
        : info === "sandboxError" ? "SKILL_PERMISSION_DENIED"
        : info === "usageLimitExceeded" ? "SKILL_USAGE_LIMIT"
        : "SKILL_TURN_FAILED"), typeof error?.message === "string" ? error.message.slice(0, 400) : undefined));
    }
  });

  /** One turn on the thread, from prompt to the model's final text. */
  const runTurn = async (text: string): Promise<string> => {
    finalText = undefined;
    lastEventAt = Date.now();
    // Cleared so the handler's "events can precede the turn/start response" guard arms again.
    delete audit.turnId;
    const completed = new Promise<string | undefined>((resolve, reject) => { settle = { resolve, reject }; });
    // Attach a rejection handler immediately, including events that beat the RPC response.
    void completed.catch(() => {});
    const route = context.route;
    const turn = record(record(await scope.rpc("turn/start", {
      threadId: run.threadId, ...(run.agent ? {} : { environments: [] }), input: [{ type: "text", text, text_elements: [] }], outputSchema: run.outputSchema,
      // Re-stated every turn: a continued turn inherits the thread's model unless told otherwise.
      ...(route ? { model: route.model, ...(route.effort ? { effort: route.effort } : {}) } : {})
    }))?.turn);
    if (!identifier(turn?.id)) fail("SKILL_PROTOCOL_INVALID");
    audit.turnId = turn.id;
    run.onAudit({ ...audit });
    // This turn's own window: the time the previous one took is not held against it.
    const turnStarted = Date.now();
    const limit = scope.window();
    // Silence watchdog, polled often relative to the limit and cleared with the turn.
    let watch: ReturnType<typeof setInterval> | undefined;
    const silent = new Promise<never>((_, reject) => {
      watch = setInterval(() => { if (Date.now() - lastEventAt > idleMs) reject(new Error("SKILL_STALLED")); },
        Math.max(20, Math.min(30_000, Math.floor(idleMs / 4))));
    });
    silent.catch(() => {});
    let answer: string | undefined;
    try { answer = await Promise.race([completed, scope.canceled, limit.promise, silent]); }
    finally { limit.clear(); if (watch) clearInterval(watch); context.usage.noteTurnSeconds((Date.now() - turnStarted) / 1000); }
    recordAnswer(run.skillName, answer);
    if (!answer) return fail("SKILL_REFUSED");
    return answer;
  };

  /** Models routinely wrap JSON in a ```json fence even when told to return JSON only: a transport habit, not invented content. */
  const parse = (answer: string): unknown => {
    try { return cleanAnswerStrings(JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""))); }
    catch { throw withDetail(new Error("SKILL_SCHEMA_INVALID"), "the answer was not valid JSON (cut off, or it repeated itself); return the complete JSON object once"); }
  };

  /** A silent turn is interrupted and the same prompt sent again, a couple of times; every other failure ends the run as before. */
  const runTurnOrRetryStall = async (prompt: string): Promise<string> => {
    for (let stalls = 0; ; stalls += 1) {
      try { return await runTurn(prompt); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "SKILL_STALLED" || stalls >= MAX_STALL_RETRIES) throw error;
        if (audit.turnId) abandoned.add(audit.turnId);
        if (audit.threadId && audit.turnId) void client.request("turn/interrupt", { threadId: audit.threadId, turnId: audit.turnId }).catch(() => {});
        audit.stalls = (audit.stalls ?? 0) + 1;
        run.onAudit({ ...audit });
      }
    }
  };

  const maxRepairs = context.route?.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  let rejection: Error | undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await runTurnOrRetryStall(attempt === 0 ? run.firstPrompt
        : `Your previous answer was rejected by the receiving layer: ${rejection?.message}`
          + `${(rejection as Detailed | undefined)?.detail ? ` — ${(rejection as Detailed).detail}` : ""}\n\n`
          + "Return the corrected JSON object in full. Change only what the rejection names; do not "
          + "explain, apologise, or add commentary outside the JSON.");
      let parsed: unknown;
      try {
        parsed = parse(answer);
        return run.validate(parsed);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxRepairs && parsed !== undefined && run.soften && !/_BLOCKED$/.test(rejection.message)) {
          const kept = run.soften(rejection, parsed);
          if (kept !== undefined) {
            audit.warnings = [{ code: rejection.message, detail: (rejection as Detailed).detail ?? "" }];
            run.onAudit({ ...audit });
            return kept;
          }
        }
        // A Skill that stopped and said why (`*_BLOCKED`: it was missing an input it was told not to guess) has not made a
        // mistake to fix. Sending that back as a "rejection" coaxes it into dropping the blocker and inventing what was
        // missing — which a real run showed it doing, twice out of two, for the capture 「整理一下」.
        if (attempt >= maxRepairs || /_BLOCKED$/.test(rejection.message)) throw rejection;
        audit.repairs = attempt + 1;
        run.onAudit({ ...audit });
      }
    }
  } finally { unsubscribe(); }
}

/** Turns whatever ended a run into the blocker the person sees, and stops the turn if one is still going. */
function failureResult<T>(client: CodexRpcBoundary, error: unknown, audit: AnalysisAudit): SkillRunResult<T> {
  if (audit.threadId && audit.turnId) void client.request("turn/interrupt", { threadId: audit.threadId, turnId: audit.turnId }).catch(() => {});
  const message = error instanceof Error ? error.message : "";
  const code = /^[A-Z][A-Z_]{2,}$/.test(message) ? message
    : message === "CODEX_APP_SERVER_EXITED" || message === "CODEX_APP_SERVER_STOPPED" ? "SKILL_RUNTIME_EXITED"
    : isThreadLost(error) ? "SKILL_THREAD_LOST" : "SKILL_RUNTIME_FAILED";
  // Each message says what the person can actually do; no raw model or auth text ever reaches it.
  const advice: Record<string, string> = {
    SKILL_USAGE_LIMIT: "Codex 用量额度已用完；额度恢复后可重试。",
    SKILL_UNAUTHENTICATED: "Codex 未登录或登录已失效；在连接页重新登录后可重试。",
    SKILL_CANCELED: "已取消。",
    SKILL_TIMEOUT: "运行超时，可重试。",
    SKILL_STALLED: "Codex 长时间没有任何输出，已中断重发仍无响应；稍后重试。",
    SKILL_RUNTIME_EXITED: "Codex 运行时已退出；恢复后可重试。",
    SKILL_THREAD_LOST: "Codex 里这段对话已经不存在（运行时重启过）；需要开一段新的。"
  };
  // A caller's validator may attach `detail` when the Skill itself explained the refusal; that text is the only thing the
  // person can act on, so it beats the generic fallback.
  const detail = (error as Detailed | undefined)?.detail;
  return { ok: false, blocker: { code, message: advice[code] ?? detail ?? "运行未完成；请检查阻塞原因。" }, audit };
}

/**
 * One more turn on a thread a previous `runCodexSkill` call already started — the conversational follow-up path. There is no
 * thread to start, so no instructions, web grant or input preparation: those only ever apply at `thread/start`.
 */
export function continueSkillTurn<T>(client: CodexRpcBoundary, threadId: string, message: string,
  options: ContinueTurnOptions<T>): Promise<SkillRunResult<T>> {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, blocker: { code: "SKILL_CANCELED", message: "已取消；未开始运行。" }, audit: {} });
  return executeSkill(client, options, async (context): Promise<SkillRunResult<T>> => {
    const audit: AnalysisAudit = { threadId };
    const scope = openScope(client, options);
    const unregister = options.tools ? registerAgentThread(client, threadId, toolAnswerer(options.tools)) : undefined;
    try {
      await requireLogin(scope);
      const output = await runTurnsUntilValid(client, scope, context, audit, {
        skillName: options.skillName, threadId, outputSchema: options.outputSchema,
        allowedItemTypes: ["agentMessage", "reasoning", "userMessage", ...(options.tools ? ["dynamicToolCall"] : [])],
        firstPrompt: message, validate: options.validateOutput, onAudit: options.onAudit, ...(options.idleMs ? { idleMs: options.idleMs } : {}),
        ...(options.softAccept ? { soften: options.softAccept } : {})
      });
      return { ok: true, output, audit };
    } catch (error) { return failureResult<T>(client, error, audit); }
    finally { unregister?.(); scope.dispose(); }
  });
}

export function runCodexSkill<T>(client: CodexRpcBoundary, input: unknown, options: SkillRunOptions<T>): Promise<SkillRunResult<T>> {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, blocker: { code: "SKILL_CANCELED", message: "已取消；未开始运行。" }, audit: {} });
  return executeSkill(client, options, (context) => runSkillTurn(client, input, options, context));
}

async function runSkillTurn<T>(client: CodexRpcBoundary, input: unknown, options: SkillRunOptions<T>, context: RunContext): Promise<SkillRunResult<T>> {
  const audit: AnalysisAudit = {};
  // Web search is the only tool any Skill may use, and only when that Skill was granted it.
  const allowedItemTypes = ["agentMessage", "reasoning", "userMessage",
    ...(options.allowWebSearch ? ["webSearch", "webSearchCall"] : []), ...(options.allowImageGeneration ? ["imageGeneration"] : []),
    ...(options.tools ? ["dynamicToolCall"] : [])];
  let scope: Scope | undefined;
  let unregister: (() => void) | undefined;
  try {
    const prepared = options.prepareInput(input);
    scope = openScope(client, options);
    await requireLogin(scope);
    const threadId = await startIsolatedThread(scope, options, context);
    audit.threadId = threadId;
    options.onAudit({ ...audit });
    if (options.agent) unregister = registerAgentThread(client, threadId, options.agent.answer);
    else if (options.tools) unregister = registerAgentThread(client, threadId, toolAnswerer(options.tools));
    const output = await runTurnsUntilValid(client, scope, context, audit, {
      skillName: options.skillName, threadId, outputSchema: options.outputSchema, allowedItemTypes, ...(options.onImage ? { onImage: options.onImage } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      firstPrompt: `$${options.skillName}\n\n${JSON.stringify(prepared)}`,
      validate: (answer) => options.validateOutput(answer, prepared), onAudit: options.onAudit, ...(options.idleMs ? { idleMs: options.idleMs } : {}),
      ...(options.softAccept ? { soften: (rejection: Error, answer: unknown) => options.softAccept!(rejection, answer, prepared) } : {})
    });
    return { ok: true, output, audit };
  } catch (error) { return failureResult<T>(client, error, audit); }
  finally { unregister?.(); scope?.dispose(); }
}
