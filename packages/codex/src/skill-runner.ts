import type { CodexRpcBoundary } from "./index";

export type AnalysisAudit = { threadId?: string; turnId?: string };
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
  /** Only a Skill that must reach outside gets this; it is off for every other run. */
  allowWebSearch?: boolean;
  onAudit: (audit: AnalysisAudit) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function fail(code: string): never { throw new Error(code); }

type NativeSkill = { path: string; enabled: boolean };
let skillQueue: Promise<void> = Promise.resolve();

// ponytail: one process-wide lock is enough while Crossline owns one CODEX_HOME; key by home if that changes.
function serializeSkillRun<T>(run: () => Promise<T>): Promise<T> {
  const previous = skillQueue;
  let release = () => {};
  skillQueue = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(run).finally(release);
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

export function runCodexSkill<T>(client: CodexRpcBoundary, input: unknown, options: SkillRunOptions<T>): Promise<SkillRunResult<T>> {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, blocker: { code: "SKILL_CANCELED", message: "已取消；未开始运行。" }, audit: {} });
  return serializeSkillRun(async () => {
    let skill: NativeSkill | undefined;
    let result: SkillRunResult<T>;
    try {
      skill = await findNativeSkill(client, options.skillName, options.cwd);
      if (!skill.enabled) await setNativeSkill(client, skill.path, true);
      result = await runSkillTurn(client, input, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      result = skillBlocker<T>(/^SKILL_(LIST_FAILED|MISSING|CONFIG_FAILED)$/.test(message) ? message : "SKILL_CONFIG_FAILED");
    }
    if (skill && !skill.enabled) {
      try { await setNativeSkill(client, skill.path, false); }
      catch { return skillBlocker<T>("SKILL_CONFIG_FAILED", result.audit); }
    }
    return result;
  });
}

async function runSkillTurn<T>(client: CodexRpcBoundary, input: unknown, options: SkillRunOptions<T>): Promise<SkillRunResult<T>> {
  const audit: AnalysisAudit = {};
  // Web search is the only tool any Skill may use, and only when that Skill was granted it.
  const allowedItemTypes = ["agentMessage", "reasoning", "userMessage",
    ...(options.allowWebSearch ? ["webSearch", "webSearchCall"] : [])];
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 120_000), ...(options.signal ? [options.signal] : [])]);
  let unsubscribe = () => {};
  let stopWaiting = () => {};
  let finalText: string | undefined;
  try {
    const prepared = options.prepareInput(input);
    const canceled = new Promise<never>((_, reject) => {
      const abort = () => reject(new Error(options.signal?.aborted ? "SKILL_CANCELED" : "SKILL_TIMEOUT"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      stopWaiting = () => signal.removeEventListener("abort", abort);
    });
    const rpc = (method: string, params: unknown) => Promise.race([client.request(method, params), canceled]);
    const account = record(await rpc("account/read", { refreshToken: false }));
    if (!record(account?.account)) fail("SKILL_UNAUTHENTICATED");
    const runtimeConfig = record(record(await rpc("config/read", { includeLayers: false }))?.config);
    if (!runtimeConfig) fail("SKILL_PROTOCOL_INVALID");
    const mcp = record(runtimeConfig.mcp_servers) ?? {};
    const config: Record<string, unknown> = {
      // "live", not "enabled": this runtime's `web_search` takes `disabled | cached | live`, and the
      // wrong variant made the whole thread/start fail — so the one Skill granted the web could never
      // start at all. A scout that must cite what it read needs `live` rather than `cached`.
      web_search: options.allowWebSearch ? "live" : "disabled", project_doc_max_bytes: 0, include_environment_context: false,
      "memories.use_memories": false, "memories.generate_memories": false,
      "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
      "features.plugins": true,
      ...Object.fromEntries(["shell_tool", "multi_agent", "multi_agent_v2", "apps", "hooks", "codex_hooks", "plugin_hooks", "memories", "web_search", "standalone_web_search", "image_generation", "view_image", "request_permissions_tool", "tool_suggest", "token_budget", "current_time_reminder", "sleep_tool", "send_message_to_user_async", "js_repl", "code_mode", "deferred_executor"]
        .map((key) => [`features.${key}`, Boolean(options.allowWebSearch) && (key === "web_search" || key === "standalone_web_search")])),
      ...Object.fromEntries(Object.keys(mcp).map((key) => [`mcp_servers.${key}.enabled`, false]))
    };
    const threadParams = {
      environments: [], dynamicTools: [], runtimeWorkspaceRoots: [], sandbox: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "user",
      ephemeral: false, experimentalRawEvents: false, persistExtendedHistory: false,
      developerInstructions: options.developerInstructions
    };
    // The flag list is written against the newest runtime, but `--strict-config` rejects the whole call
    // over one field an older runtime never defined. A field this runtime does not know names a feature
    // this runtime does not have, so dropping it removes no protection; the real guarantees are the
    // read-only sandbox, the untrusted approval policy and the tool-call guard below. Any other error
    // still fails the analysis.
    let started: Record<string, unknown> | undefined;
    for (;;) {
      try { started = record(await rpc("thread/start", { ...threadParams, config })); break; }
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
          if (/configuration|unknown variant/i.test(message)) {
            const rejected = new Error("SKILL_CONFIG_REJECTED");
            (rejected as Error & { detail?: string }).detail = message.slice(0, 400);
            throw rejected;
          }
          throw error;
        }
        for (const key of dropped) delete config[key];
      }
    }
    const threadId = record(started?.thread)?.id;
    if (!identifier(threadId)) fail("SKILL_PROTOCOL_INVALID");
    audit.threadId = threadId;
    options.onAudit({ ...audit });
    if (started?.approvalPolicy !== "untrusted" || record(started.sandbox)?.type !== "readOnly" || !Array.isArray(started.instructionSources) || started.instructionSources.length) fail("SKILL_PERMISSION_DENIED");
    const completed = new Promise<void>((resolve, reject) => {
      unsubscribe = client.onNotification((message) => {
        if (message.method === "crossline/runtimeDisconnected") return reject(new Error("SKILL_RUNTIME_EXITED"));
        const params = record(message.params);
        if (!params || params.threadId !== audit.threadId) return;
        const turn = record(params.turn);
        const turnId = params.turnId ?? turn?.id;
        // Events can precede the turn/start response; capture only this isolated thread.
        if (audit.turnId && turnId !== audit.turnId) return;
        if (message.method === "item/completed" || message.method === "item/started") {
          const item = record(params.item);
          if (item?.type === "agentMessage" && message.method === "item/completed" && (item.phase === "final_answer" || item.phase === null)) {
            if (typeof item.text !== "string" || item.text.length > 100_000) reject(new Error("SKILL_SCHEMA_INVALID"));
            else finalText = item.text;
          } else if (item && !allowedItemTypes.includes(String(item.type))) reject(new Error("SKILL_TOOL_FORBIDDEN"));
        }
        if (message.method === "turn/completed") {
          if (!identifier(turn?.id)) return reject(new Error("SKILL_PROTOCOL_INVALID"));
          if (turn.status === "completed") resolve();
          else {
            const error = record(turn.error);
            const info = error?.codexErrorInfo;
            // A spent quota is neither a refusal nor a bug, and calling it one would misreport the
            // only thing the user can act on: waiting, or buying more credits. A turn the runtime
            // rejected outright is not a refusal either — calling it one hid a malformed request
            // behind a word that means the model declined to answer.
            const failure = new Error(turn.status === "interrupted" ? "SKILL_CANCELED"
              : info === "unauthorized" ? "SKILL_UNAUTHENTICATED"
              : info === "sandboxError" ? "SKILL_PERMISSION_DENIED"
              : info === "usageLimitExceeded" ? "SKILL_USAGE_LIMIT"
              : "SKILL_TURN_FAILED");
            if (typeof error?.message === "string") {
              (failure as Error & { detail?: string }).detail = error.message.slice(0, 400);
            }
            reject(failure);
          }
        }
      });
    });
    // Attach a rejection handler immediately, including events that beat the RPC response.
    void completed.catch(() => {});
    const turn = record(record(await rpc("turn/start", {
      threadId, environments: [], input: [{ type: "text", text: `$${options.skillName}\n\n${JSON.stringify(prepared)}`, text_elements: [] }], outputSchema: options.outputSchema
    }))?.turn);
    if (!identifier(turn?.id)) fail("SKILL_PROTOCOL_INVALID");
    audit.turnId = turn.id;
    options.onAudit({ ...audit });
    await Promise.race([completed, canceled]);
    if (!finalText) fail("SKILL_REFUSED");
    let output: unknown;
    // Models routinely wrap JSON in a ```json fence even when told to return JSON only. That is a
    // transport habit, not invented content, so it is unwrapped rather than treated as a refusal —
    // every trust check still runs on whatever is inside.
    const unfenced = finalText.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "");
    try { output = JSON.parse(unfenced); } catch { fail("SKILL_SCHEMA_INVALID"); }
    return { ok: true, output: options.validateOutput(output, prepared), audit };
  } catch (error) {
    if (audit.threadId && audit.turnId) void client.request("turn/interrupt", { threadId: audit.threadId, turnId: audit.turnId }).catch(() => {});
    const message = error instanceof Error ? error.message : "";
    const code = /^[A-Z][A-Z_]{2,}$/.test(message) ? message
      : message === "CODEX_APP_SERVER_EXITED" || message === "CODEX_APP_SERVER_STOPPED" ? "SKILL_RUNTIME_EXITED" : "SKILL_RUNTIME_FAILED";
    // Each message says what the person can actually do; no raw model or auth text ever reaches it.
    const advice: Record<string, string> = {
      SKILL_USAGE_LIMIT: "Codex 用量额度已用完；额度恢复后可重试。",
      SKILL_UNAUTHENTICATED: "Codex 未登录或登录已失效；在连接页重新登录后可重试。",
      SKILL_CANCELED: "已取消。",
      SKILL_TIMEOUT: "运行超时，可重试。",
      SKILL_RUNTIME_EXITED: "Codex 运行时已退出；恢复后可重试。"
    };
    // A caller's validator may attach `detail` when the Skill itself explained the refusal; that text
    // is the only thing the person can act on, so it beats the generic fallback.
    const detail = (error as Error & { detail?: string } | undefined)?.detail;
    return { ok: false, blocker: { code, message: advice[code] ?? detail ?? "运行未完成；请检查阻塞原因。" }, audit };
  } finally { unsubscribe(); stopWaiting(); }
}
