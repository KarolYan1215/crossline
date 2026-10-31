import { mkdirSync, writeFileSync } from "node:fs";
import { agentLanguageLine, runLocale, schemaForLocale, styleInstructions } from "./style";
import { join } from "node:path";
import { cleanAnswerStrings, tFor, type Locale } from "@crossline/core";
import type { CodexRpcBoundary } from "./index";
import { routeForSkill, tierForSkill, tierRoutes, type ModelRoute, type RouteTier, type SpendMode } from "./model-policy";
import { createUsageCollector, currentSpendMode, currentUsageWorkspace, reportUsage, type UsageCollector } from "./usage";
import { currentProviderRouting, decideRoute, noteChatgptUsageLimit, type ThreadProvider } from "./providers";
import { markClientBusy, priorityForSkill, withModelSlot, type ModelPriority } from "./model-gate";
import { bindForRun } from "./runtime-pool";
import { accountModels, fitRoute } from "./model-catalog";

import { registerAgentThread, SANDBOX_PROFILE, sandboxProfile, type AgentMode } from "./agent-mode";

export type AnalysisAudit = { threadId?: string; turnId?: string;
  /** How many times a turn went silent for so long it was interrupted and sent again. Absent means none did. */
  stalls?: number;
  /** How many times the validator sent the answer back to be fixed. Absent means it passed first try. */
  repairs?: number;
  /**
   * Content-quality problems the answer still had when the repairs ran out and the caller chose to keep it (`softAccept`). The
   * caller records them for the reviewer; nothing was blocked for them.
   */
  warnings?: Array<{ code: string; detail: string }>;
  /** The library skills (`extraSkills`) that were installed and switched on for this run. */
  skills?: string[];
  /** Set when the answer is a second run on the provider's own model (`redoOnRepair`): the repairs the first one needed. */
  redone?: { repairs: number };
  /** With `resumeThreadId`: whether the run went on in that thread (true) or the runtime no longer had it and a new one was opened. */
  resumed?: boolean };
/**
 * What a running turn has done so far, for a screen that shows the wait (docs/onboarding-v3.md 「等待」): `thinking` until the first
 * word, `writing` with the answer streamed so far (unvalidated — never stored, only counted and previewed), `checking` once it is in.
 * `repairs` and `stalls` say this is a second look or a resent turn.
 */
export type SkillProgress = { phase: "thinking" | "writing" | "checking"; text: string; repairs: number; stalls: number };
export type SkillRunResult<T> = { ok: true; output: T; audit: AnalysisAudit }
  | { ok: false; blocker: { code: string; message: string; detail?: string }; audit: AnalysisAudit };

/**
 * Items the runtime writes on its own that do nothing outside the thread: a long conversation is compacted (`contextCompaction`) and a
 * model may lay out a plan (`plan`). Refusing them ended whole interview rounds as 「使用了禁止的工具」 (2026-10-19: a tester's long
 * interview failed six times in a row at the start of a turn, the moment the runtime compacts).
 */
const HARMLESS_ITEM_TYPES = new Set(["contextCompaction", "plan"]);
/**
 * The runtime's own MCP resource tools, which it offers whenever an MCP server is configured (a plugin's), in structured runs too: they
 * list and read resources and change nothing. A model that calls one used a tool it was offered, so the turn goes on (2026-10-19:
 * Step-3.5-Flash called `list_mcp_resources` and failed conformance cases as 「使用了禁止的工具」).
 */
const RUNTIME_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/**
 * ChatGPT connectors with reading only: every connector tool not marked read-only needs approval (`writes`), destructive ones are not
 * offered at all, and the runner answers each approval request with a refusal (vendor/codex core/src/mcp_tool_call.rs: an unanswered or
 * refused elicitation denies the call).
 */
const CONNECTORS_READ_ONLY: Record<string, unknown> = { "apps._default.default_tools_approval_mode": "writes", "apps._default.destructive_enabled": false };

/**
 * Another provider's context window, so the runtime compacts before the model overflows: an unknown model is assumed to have 272k
 * (vendor/codex models-manager fallback) and would compact only at ~245k, past the window of most 128k models. Unknown here → 128k.
 */
/** `request_user_input` outside Plan mode is behind a feature flag of its own; the tool itself is on unless configured off. */
const ASK_PERSON_CONFIG = { "tools.experimental_request_user_input.enabled": true, "features.default_mode_request_user_input": true };

export function contextWindowConfig(provider: ThreadProvider): Record<string, number> {
  const window = provider.contextWindow && provider.contextWindow >= 16_000 ? provider.contextWindow : 128_000;
  return { model_context_window: window, model_auto_compact_token_limit: Math.floor(window * 0.8) };
}

/**
 * What a turn the provider refused means for the person, from the provider's own words. Known shapes are said plainly; anything else
 * is said as a provider error, and the original text travels as the blocker's `detail` (shown folded, never auth material).
 */
export function turnFailureAdvice(raw: string | undefined, locale?: Locale): string {
  const t = tFor(locale);
  const text = (raw ?? "").toLowerCase();
  if (/capacity|overload|temporarily unavailable|server is busy|503|529/.test(text)) return t("模型服务这会儿满载，没有接这一轮；过几分钟重试即可，连续出现可在设置里换一个模型。");
  if (/rate limit|too many requests|429/.test(text)) return t("请求太频繁，模型服务暂时限流；稍等一分钟再试。");
  if (/context|too long|maximum.*tokens|token limit/.test(text)) return t("这段对话超出了模型一次能读的长度；重试会自动压缩后再发。");
  if (/invalid|bad request|400/.test(text)) return t("模型服务拒绝了这一轮的请求格式；已记录，可重试，仍不行请反馈。");
  return t("模型服务这一轮报错，没有给出回答；可以重试，原文在下面的技术信息里。");
}

/** The provider's words, kept for the person to read: credentials and long tokens are cut out. */
const shownDetail = (raw: string | undefined) => (raw ?? "").replace(/(bearer|api[-_ ]?key|token|authorization)[^\s,;]*[\s:=]+\S+/gi, "$1 ***")
  .replace(/[A-Za-z0-9_-]{32,}/g, "***").slice(0, 300);

/**
 * Everything a Skill run needs that differs between Skills. Transport, isolation, the tool guard and
 * the blocker vocabulary are shared, because duplicating them is how one of two copies quietly loses
 * a guarantee the other one keeps.
 */
export type SkillRunOptions<T> = {
  skillName: string;
  cwd: string;
  /** Local image files shown with the first prompt (a screenshot the person attached); the model reads them, code checks what it read. */
  images?: string[];
  /**
   * The caller will send more turns on this thread (`continueSkillTurn`): it stays loaded for `THREAD_KEEP_MS` after its last turn
   * instead of being released when the run ends. A later turn on a released thread answers SKILL_THREAD_LOST, which those callers
   * already rebuild from their own history.
   */
  keepThread?: boolean;
  developerInstructions: string;
  outputSchema: unknown;
  /** Validated before the turn starts; whatever it returns is what gets sent. */
  prepareInput: (input: unknown) => unknown;
  /**
   * The prompt cache (docs/token-economy.md §2.5): the provider matches a request from its first token, so what is the same for every
   * run of this Skill goes first. The top-level keys of the prepared input that change little between runs (the person's profile and
   * preferences, the archetype table, a line's facts), from the least to the most changing; they are sent first and every other key
   * (today's date, the object of this run) after, each in the order the runner wrote it (`cacheOrderedInput`). Nothing is added or left out.
   */
  stableKeys?: readonly string[];
  /**
   * What only this run is told beside the Skill's own instructions (feedback to apply, the library skills it names, a mode): sent as the
   * last part of the first prompt, after the input, so the developer instructions are the same for every run of the Skill and the
   * shared writing style after them is not pushed behind text that changes (`firstPromptTexts`).
   */
  runNote?: string;
  /** The trust boundary: the runtime proving a shape is not the same as the content being right. */
  validateOutput: (output: unknown, prepared: unknown) => T;
  /**
   * Called when the repairs are spent and the last rejection is still standing. A caller whose rejection was about content quality,
   * not about safety or about a shape it cannot store, returns the answer to keep (the run then succeeds with `audit.warnings`);
   * returning undefined keeps the refusal (decided 2026-10-07: quality checks warn, safety checks block).
   */
  softAccept?: (rejection: Error, output: unknown, prepared: unknown) => T | undefined;
  /**
   * Tried at every rejection before a repair is asked for: an answer whose trouble is small enough to drop (a caller-defined bound,
   * e.g. at most two items) is kept at once with `audit.warnings`, instead of the model rewriting the whole answer. Each repair of a
   * long answer is a full regeneration — a real interview turn spent 174 s, two thirds of it on two repairs (2026-10-16).
   */
  keepEarly?: (rejection: Error, output: unknown, prepared: unknown) => T | undefined;
  /** Only a Skill that must reach outside gets this; it is off for every other run. */
  allowWebSearch?: boolean;
  /**
   * Only the portrait illustrator gets this: the runtime's own image tool, on the person's ChatGPT sign-in like every other call. Each
   * finished image is handed to `onImage` (base64 PNG) as it arrives; nothing is written by the runner itself.
   */
  allowImageGeneration?: boolean;
  onImage?: (image: { base64: string; revisedPrompt: string }) => void;
  onAudit: (audit: AnalysisAudit) => void;
  /** Called as the turn moves (throttled to twice a second while it writes); see `SkillProgress`. */
  onProgress?: (progress: SkillProgress) => void;
  /** While the run waits for the process-wide model gate (model-gate.ts): how many runs are ahead of it. */
  onQueued?: (ahead: number) => void;
  /** Overrides the gate's priority, which otherwise follows the Skill (`priorityForSkill`). */
  priority?: ModelPriority;
  /** The account the gate counts this run against; otherwise the workspace the run is attributed to (`enterUsageWorkspace`). */
  tenant?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Silence, in ms, after which a turn is treated as hung and sent again. Defaults to 20 minutes (`CROSSLINE_SKILL_IDLE_MINUTES`). */
  idleMs?: number;
  /** Set for the assistant: a thread with a shell and file access, working in `agent.cwd`, whose requests the guard answers. */
  agent?: AgentMode;
  /** Read-only tools the model may call during the turn (the one input box's lookups); see `SkillTools`. */
  tools?: SkillTools;
  /**
   * Lookups the run is better with but can do without (the step planner's `search_material`/`read_chunk`, docs/context-selection.md):
   * offered beside `tools`, with `instructions` appended, when the route calls functions — the account's own Codex always, another
   * provider only when its conformance record shows it calling one (`ProviderRouting.functionCalls`). Otherwise they are not offered
   * and the run's input is `withoutTools(input)`: the passages code picked, in full. `onMode` is told which it was.
   */
  optionalTools?: { tools: SkillTools; instructions: string; withoutTools: (input: unknown) => unknown; onMode?: (mode: "tools" | "fallback") => void };
  /**
   * Codex's code mode for a run with `tools` (2026-10-19, the owner: turn the runtime's own features over to use): the model may write
   * JavaScript that runs in the runtime's V8 isolate — no file system, network or process of its own — to compute and to call the run's
   * tools (`tools.read_file(…)`). Needs `codex-code-mode-host` beside the runtime; the caller checks that.
   */
  codeMode?: boolean;
  /**
   * Codex's `request_user_input` (2026-10-19, the owner: turn the runtime's own features over to use): the run may stop and ask the
   * person what only they know and the work cannot go on without. Each request reaches this function, whose answers (one list per
   * question id) go back on the same turn; the caller decides how long to wait and what an unanswered question becomes.
   */
  askPerson?: (questions: PersonQuestion[]) => Promise<Record<string, string[]>>;
  /**
   * The person's ChatGPT connectors (Gmail, Calendar, Drive, Notion …) for this run, read-only: the runtime asks before any tool not
   * marked read-only and this runner declines every such request, so only reading goes through. A ChatGPT sign-in is needed; on any
   * other login the runtime offers none.
   */
  connectors?: boolean;
  /** The runtime's own plan tool: each update of the model's step list is handed here as it is made (`turn/plan/updated`). */
  onPlan?: (plan: { explanation: string; steps: Array<{ step: string; status: string }> }) => void;
  /** Run on this tier instead of the Skill's own (the input box's second, stronger look). Ignored when the budget is tight. */
  tier?: RouteTier;
  /**
   * On a provider that gives this Skill a model of its own (the developer's planning model, `SPONSOR_PLANNING_SKILLS`): a run there that
   * needed a repair is run once more on the provider's own model and that answer kept, unless it fails (decided 2026-10-20 after the
   * real-work comparison, where the one plan that missed its task was a repaired one). `audit.redone` says it happened.
   */
  redoOnRepair?: boolean;
  /** The provider's own model even where the Skill has one of its own (set by `redoOnRepair` for the second run). */
  mainModel?: boolean;
  /** Run on exactly this provider, bypassing routing: only the conformance check, which measures a provider before it may be routed to. */
  provider?: ThreadProvider;
  /** With `provider`: the search functions to stand in for hosted web search (routing supplies them otherwise). */
  webTools?: SkillTools;
  /**
   * Skills from the person's library switched on beside the target for this run only and named in the first prompt
   * (`$crossline-mine:<line>`, docs/skills-library.md §3). One that is not installed is skipped, never a failure: a line with no skill yet
   * runs as before. Which ones were actually on is reported in `audit.skills`.
   */
  extraSkills?: string[];
  /**
   * The language the person reads (docs/i18n.md). Unset, the run follows its workspace's language (`setLocaleProvider`); the interview
   * passes the language it started in, so a switch mid-interview does not change the conversation's language.
   */
  locale?: Locale;
  /**
   * The fields that speak to the person as 你 (the interview's `reply` and questions); the shared style says so instead of its
   * third-person rule. Unset, every field is third person.
   */
  secondPerson?: string[];
  /**
   * Go on in this thread instead of starting one (an automation that wakes up where its last run left off, 2026-10-20). The thread is
   * resumed with the same settings a new one would be started with (`thread/resume` applies them to a thread it loads from disk, and
   * since 0.163 restores its saved permissions too); a runtime that no longer has it (`thread not found`, `no rollout found`) gets a
   * new thread, and `audit.resumed` says which happened. The caller's prompt carries what the last run did either way.
   */
  resumeThreadId?: string;
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
export type PersonQuestion = { id: string; header: string; question: string; options: Array<{ label: string; description: string }> };

/** The runtime's `item/tool/requestUserInput` answered through `askPerson`; every other request goes to `fallback`. */
function withPersonQuestions(ask: SkillRunOptions<unknown>["askPerson"], fallback: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>) {
  if (!ask) return fallback;
  return async (method: string, params: Record<string, unknown>) => {
    if (method !== "item/tool/requestUserInput") return fallback(method, params);
    const questions = (Array.isArray(params.questions) ? params.questions : []).flatMap((raw): PersonQuestion[] => {
      const item = record(raw);
      if (!item || typeof item.id !== "string" || typeof item.question !== "string") return [];
      const options = (Array.isArray(item.options) ? item.options : []).flatMap((option) => {
        const value = record(option);
        return value && typeof value.label === "string" ? [{ label: value.label, description: typeof value.description === "string" ? value.description : "" }] : [];
      });
      return [{ id: item.id, header: typeof item.header === "string" ? item.header : "", question: item.question, options }];
    });
    const answers = questions.length ? await ask(questions) : {};
    return { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: answers[question.id] ?? [] }])) };
  };
}
const refuseAll = async (): Promise<never> => { throw new Error("nothing on this thread is answered here"); };

function toolAnswerer(tools: SkillTools) {
  return async (method: string, params: Record<string, unknown>) => {
    if (method !== "item/tool/call") throw new Error("only tool calls are answered for this thread");
    const name = String(params.tool ?? "");
    // i18n-ignore: an answer to the model
    if (!tools.specs.some((spec) => spec.name === name)) return { contentItems: [{ type: "inputText", text: `没有名为 ${name} 的工具` }], success: false };
    try {
      const text = await tools.call(name, params.arguments ?? {});
      return { contentItems: [{ type: "inputText", text: text.slice(0, 60_000) }], success: true };
    } catch (error) {
      return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : "查询失败" }], success: false }; // i18n-ignore: an answer to the model
    }
  };
}
/**
 * The blocker vocabulary is shown to the person: in the run's language — the caller's (the interview's locked one), else the
 * workspace's (docs/i18n.md).
 */
const said = (locale?: Locale) => tFor(runLocale(locale, currentUsageWorkspace()));
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
 * The assistant waits in a line of its own per runtime: a task that runs for up to an hour must not hold anything else, and two of one
 * account's assistant runs never overlap. Every other run is paced by the model gate (model-gate.ts): an account holds at most two
 * background slots, accounts take turns, and a person's turn starts at once. Until 2026-10-19 every run waited in a line per tier and
 * runtime, so one account's twelve backplans and thirty step plans ran strictly one after another (decided with the owner that day).
 */
const agentLanes = new Map<string, Promise<void>>();
// Lanes and the config lock belong to one runtime: each account's own Codex (runtime-registry.ts) queues only its own runs.
const runtimeIds = new WeakMap<object, number>();
let nextRuntimeId = 0;
const runtimeKey = (client: object) => { if (!runtimeIds.has(client)) runtimeIds.set(client, ++nextRuntimeId); return runtimeIds.get(client)!; };
function inLane<T>(lanes: Map<string, Promise<void>>, lane: string, run: () => Promise<T>): Promise<T> {
  const previous = lanes.get(lane) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((resolve) => { release = resolve; });
  lanes.set(lane, mine);
  return previous.then(run).finally(() => { release(); if (lanes.get(lane) === mine) lanes.delete(lane); });
}
const isAssistant = (skillName: string) => /crossline-agent(-tools)?$/.test(skillName);
/** Two turns on one thread never overlap (the interview and the input box send one after another on the same thread). */
const threadLanes = new Map<string, Promise<void>>();

/** The account a run is for, as the gate counts it: a model evaluation's many keys are one account. */
const tenantOf = (workspaceId: string | undefined) => workspaceId?.startsWith("sponsor-eval:") ? "sponsor-eval" : workspaceId;

/**
 * Switching a Skill on or off rewrites the runtime's one config file, so two lanes doing it at once could write
 * over each other. The switch is brief; only it is held in a single line, never the run in between.
 */
const configChains = new WeakMap<object, Promise<void>>();
function underConfigLock<T>(client: object, work: () => Promise<T>): Promise<T> {
  const previous = configChains.get(client) ?? Promise.resolve();
  let release = () => {};
  configChains.set(client, new Promise<void>((resolve) => { release = resolve; }));
  return previous.then(work).finally(release);
}

/** What one run carries through its turns: the route it was given, and the meter. */
type RunContext = { route: ModelRoute | undefined; spendMode: SpendMode; usage: UsageCollector;
  /** The runtime this run was given (runtime-pool.ts: this server's or a compute node's); every request of the run goes to it. */
  client: CodexRpcBoundary;
  /** Set when this run goes to a provider other than the workspace's Codex sign-in (providers.ts); the thread is started on it. */
  provider?: ThreadProvider;
  /** On a provider: Crossline's own `web_search`/`web_fetch`, standing in for the OpenAI-hosted search the provider does not have. */
  webTools?: SkillTools;
  /** The library skills switched on for this run, named in its first prompt beside the target. */
  extraSkills: string[];
  /** Whether the thread kept only Crossline's own plugins (`onlyOwnPlugins`) or every plugin; logged on `skill.run`. */
  plugins?: "own" | "all";
  /** Whether the model on this route calls functions: the account's own Codex does; a provider has to have shown it (`functionCalls`). */
  functionCalls: boolean };

/**
 * A run's optional lookups resolved for its route: merged into its tools with their instructions where the model calls functions,
 * else left out and the input replaced by what stands in for them.
 */
function withOptionalTools<T>(options: SkillRunOptions<T>, input: unknown, context: RunContext): { options: SkillRunOptions<T>; input: unknown } {
  const optional = options.optionalTools;
  if (!optional) return { options, input };
  const { optionalTools: _resolved, ...rest } = options;
  if (!context.functionCalls) { optional.onMode?.("fallback"); return { options: rest, input: optional.withoutTools(input) }; }
  optional.onMode?.("tools");
  const own = options.tools;
  return { input, options: { ...rest, developerInstructions: `${options.developerInstructions}\n\n${optional.instructions}`,
    tools: { specs: [...(own?.specs ?? []), ...optional.tools.specs.filter((spec) => !own?.specs.some((mine) => mine.name === spec.name))],
      call: (name, args) => own?.specs.some((spec) => spec.name === name) ? own.call(name, args) : optional.tools.call(name, args) } } };
}

const WEB_TOOLS_INSTRUCTION = "Web access in this run is through the functions `web_search` (results: title, url, snippet) and `web_fetch` "
  + "(the page's text). Search, then fetch every page you rely on before citing it; cite only pages you fetched, by their exact url.";

/**
 * A run's options as the thread sees them: on a provider, a Skill granted the web gets Crossline's search functions instead of the
 * hosted tool (which only exists on OpenAI), merged with any tools of its own.
 */
function withWebTools<T>(options: SkillRunOptions<T>, context: RunContext): SkillRunOptions<T> {
  // The assistant always has the web on Codex (`startAgentThread`), so on a provider it always gets the stand-in.
  if (!context.provider || !(options.allowWebSearch || options.agent)) return options;
  const { allowWebSearch: _hosted, ...rest } = options;
  const web = context.webTools;
  if (!web) return rest;
  const own = options.tools;
  return { ...rest, developerInstructions: `${options.developerInstructions}\n\n${WEB_TOOLS_INSTRUCTION}`,
    tools: { specs: [...(own?.specs ?? []), ...web.specs.filter((spec) => !own?.specs.some((mine) => mine.name === spec.name))],
      call: (name, args) => own?.specs.some((spec) => spec.name === name) ? own.call(name, args) : web.call(name, args) } };
}
const DEFAULT_MAX_REPAIRS = 2;
/** No event of any kind for this long means a hung turn. Generous: slow work still produces events, silence does not. */
const DEFAULT_IDLE_MS = 20 * 60_000;
const MAX_STALL_RETRIES = 2;

/**
 * Everything the two entry points share: waiting in the right lane, switching the Skill on, running, switching
 * it back off, and reporting what the run used.
 */
async function executeSkill<T>(client: CodexRpcBoundary, options: { skillName: string; cwd: string; tier?: RouteTier; mainModel?: boolean; provider?: ThreadProvider; extraSkills?: string[]; webTools?: SkillTools;
  onQueued?: (ahead: number) => void; priority?: ModelPriority; signal?: AbortSignal; agent?: AgentMode; tenant?: string; threadId?: string },
  body: (context: RunContext) => Promise<SkillRunResult<T>>): Promise<SkillRunResult<T>> {
  const queuedAt = Date.now();
  const timing: RunTiming = { laneMs: 0, gateMs: 0, tenant: options.tenant ?? tenantOf(currentUsageWorkspace()) ?? "-" };
  const gated = async () => {
    timing.laneMs = Date.now() - queuedAt;
    // The assistant (owner's machine only, never on the hosted beta) runs for up to an hour; holding a gate slot that long would stop
    // every interview behind it. A sandboxed assistant (any account, on a shared server) waits for a model slot like any background run.
    if (/crossline-agent$/.test(options.skillName) && !options.agent?.sandbox) return runGated(client, options, body, timing);
    // The assistant's own runs count apart from the account's two background slots (the owner's decision of 2026-10-19).
    const tenant = isAssistant(options.skillName) ? `${timing.tenant}#assistant` : timing.tenant;
    const result = await withModelSlot({ skill: options.skillName, tenant, onGranted: (waited) => { timing.gateMs = waited; },
      ...(options.priority ? { priority: options.priority } : {}),
      ...(options.onQueued ? { onQueued: options.onQueued } : {}), ...(options.signal ? { signal: options.signal } : {}) },
    () => runGated(client, options, body, timing));
    return result ?? { ok: false, blocker: { code: "SKILL_CANCELED", message: said()("已取消；排队时取消，没有开始运行。") }, audit: {} };
  };
  return isAssistant(options.skillName) ? inLane(agentLanes, `${runtimeKey(client)}:agent`, gated) : gated();
}

/**
 * Which model provider each kept thread was started on (`codex` for the account's own sign-in). A thread keeps the provider it was
 * started with, so a later turn whose route has moved (ChatGPT's quota spent and the developer's model standing in, or back) is answered
 * `SKILL_THREAD_LOST`, which the conversations already rebuild from (concierge, interview). Unknown threads (after a restart) go on.
 */
const threadRoutes = new Map<string, string>();
const THREAD_ROUTES_MAX = 2_000;
const routeOf = (context: RunContext) => context.provider?.id ?? "codex";
function rememberThreadRoute(client: object, threadId: string, context: RunContext): void {
  const key = `${runtimeKey(client)}:${threadId}`;
  threadRoutes.delete(key);
  threadRoutes.set(key, routeOf(context));
  if (threadRoutes.size > THREAD_ROUTES_MAX) threadRoutes.delete(threadRoutes.keys().next().value!);
}
/** Whether this thread was started on another provider than the turn's route. */
function threadRouteMoved(client: object, threadId: string, context: RunContext): boolean {
  const started = threadRoutes.get(`${runtimeKey(client)}:${threadId}`);
  return started !== undefined && started !== routeOf(context);
}

/** How long a run waited before it began, for which account and on which runtime (logged with the run as `skill.run`). */
type RunTiming = { laneMs: number; gateMs: number; tenant: string; runtime?: string };

/**
 * The run itself, once it holds a slot: given its runtime now (a pool's choice — this server's or a compute node's — or the client
 * itself), and counted as in flight on it so the runtime is never reclaimed under it.
 */
async function runGated<T>(client: CodexRpcBoundary, options: { skillName: string; cwd: string; tier?: RouteTier; mainModel?: boolean; provider?: ThreadProvider; extraSkills?: string[]; webTools?: SkillTools; threadId?: string },
  body: (context: RunContext) => Promise<SkillRunResult<T>>, timing: RunTiming): Promise<SkillRunResult<T>> {
  const bound = bindForRun(client, options.threadId ? { threadId: options.threadId } : undefined);
  markClientBusy(client, 1);
  if (bound.client !== client) markClientBusy(bound.client, 1);
  try { return await runRouted(bound.client, options, body, { ...timing, runtime: bound.member }); }
  finally { markClientBusy(client, -1); if (bound.client !== client) markClientBusy(bound.client, -1); bound.release(); }
}

/**
 * A Skill switched on for a run stays on while any run that needs it is going: two runs of one Skill may now overlap on one runtime, and
 * the first to finish must not switch it off under the other (whose first prompt names it). Counted per runtime and skill path; switched
 * back off only by the last holder, and only if it was off before the first.
 */
const heldSkills = new WeakMap<object, Map<string, { count: number; restore: boolean }>>();
function heldOn(client: object): Map<string, { count: number; restore: boolean }> {
  let held = heldSkills.get(client);
  if (!held) { held = new Map(); heldSkills.set(client, held); }
  return held;
}
/** Under the config lock: switches the skill on unless a run already holds it, and counts this run as holding it. */
async function holdSkill(client: CodexRpcBoundary, skill: NativeSkill): Promise<void> {
  const held = heldOn(client);
  const entry = held.get(skill.path);
  if (entry) { entry.count += 1; return; }
  if (!skill.enabled) await setNativeSkill(client, skill.path, true);
  held.set(skill.path, { count: 1, restore: !skill.enabled });
}
/** Under the config lock: the last holder switches the skill back off when it was off before. */
async function releaseSkill(client: CodexRpcBoundary, path: string): Promise<void> {
  const held = heldOn(client);
  const entry = held.get(path);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0) return;
  held.delete(path);
  if (entry.restore) await setNativeSkill(client, path, false);
}

async function runRouted<T>(client: CodexRpcBoundary, options: { skillName: string; cwd: string; tier?: RouteTier; mainModel?: boolean; provider?: ThreadProvider; extraSkills?: string[]; webTools?: SkillTools },
  body: (context: RunContext) => Promise<SkillRunResult<T>>, timing: RunTiming): Promise<SkillRunResult<T>> {
  const startedAt = Date.now();
  const spendMode = await currentSpendMode();
  // The workspace's own provider when it can serve this Skill, else its own Codex sign-in, else a blocker (never the owner's runtime).
  const routing = options.provider ? undefined : currentProviderRouting();
  const decision = options.provider ? { via: "provider" as const, provider: options.provider }
    : decideRoute(options.skillName, routing, options.mainModel ? { mainModel: true } : {});
  if (decision.via === "blocked") return { ok: false, blocker: { code: decision.code, message: decision.message }, audit: {} };
  const provider = decision.via === "provider" ? decision.provider : undefined;
  // A stronger look is a cost the person did not ask for: in economy mode the Skill keeps its own route.
  const wanted = provider ? { model: provider.model }
    : options.tier && spendMode === "normal" && process.env.CROSSLINE_MODEL_ROUTING?.trim().toLowerCase() !== "off"
    ? { ...tierRoutes()[options.tier] } : routeForSkill(options.skillName, process.env, spendMode);
  // Fitted to the models this account is offered (a ChatGPT Free account has no `gpt-5.6-sol`); a provider's model is its own.
  const route = provider ? wanted : fitRoute(wanted, options.tier ?? tierForSkill(options.skillName), await accountModels(client));
  const webTools = provider ? options.webTools ?? routing?.webTools : undefined;
  // The conformance check (`options.provider`) measures a provider and offers whatever its case needs.
  const functionCalls = !provider || Boolean(options.provider) || routing?.functionCalls === true;
  const context: RunContext = { route, spendMode, usage: createUsageCollector(), client, ...(provider ? { provider } : {}), ...(webTools ? { webTools } : {}), extraSkills: [], functionCalls };
  // The skills this run holds on (its own and the library skills named for it); each is released after the run.
  const holding: string[] = [];
  const extras: string[] = [];
  let result: SkillRunResult<T>;
  try {
    await underConfigLock(client, async () => {
      const found = await findNativeSkill(client, options.skillName, options.cwd);
      await holdSkill(client, found);
      holding.push(found.path);
      for (const name of options.extraSkills ?? []) {
        const extra = await findNativeSkill(client, name, options.cwd).catch(() => undefined);
        if (!extra) continue;
        await holdSkill(client, extra);
        holding.push(extra.path);
        extras.push(name);
      }
    });
    context.extraSkills = extras;
    result = await body(context);
    if (extras.length) result.audit.skills = context.extraSkills;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    result = skillBlocker<T>(/^SKILL_(LIST_FAILED|MISSING|CONFIG_FAILED)$/.test(errorMessage) ? errorMessage : "SKILL_CONFIG_FAILED");
  }
  for (const path of holding.reverse()) {
    try { await underConfigLock(client, () => releaseSkill(client, path)); }
    catch { result = skillBlocker<T>("SKILL_CONFIG_FAILED", result.audit); }
  }
  reportUsage({
    skillName: options.skillName, ...(tierForSkill(options.skillName) ? { tier: tierForSkill(options.skillName)! } : {}),
    ...(context.route ? { model: context.route.model, ...(context.route.effort ? { effort: context.route.effort } : {}) } : {}),
    spendMode, ...(result.audit.threadId ? { threadId: result.audit.threadId } : {}), ok: result.ok,
    ...(result.ok ? {} : { errorCode: result.blocker.code }), repairs: result.audit.repairs ?? 0, turns: context.usage.turns(),
    durationMs: Date.now() - startedAt, at: new Date(startedAt).toISOString(), turnSeconds: context.usage.turnSeconds(), ...context.usage.total()
  });
  // Where the time went (docs/model-scheduling.md): waiting before the gate (the assistant's line, a thread's earlier turn), at the gate,
  // and the run itself, with how much of the input the provider served from its cache. Summed per Skill by the diagnose job.
  const tokens = context.usage.total();
  console.info(JSON.stringify({ type: "skill.run", skill: options.skillName, ok: result.ok, provider: provider ? "provider" : "codex",
    ...(context.route?.model ? { model: context.route.model } : {}), ...(context.plugins ? { plugins: context.plugins } : {}),
    ...(timing.runtime && timing.runtime !== "server" ? { runtime: timing.runtime } : {}),
    laneMs: timing.laneMs, gateMs: timing.gateMs, serviceMs: Date.now() - startedAt,
    input: tokens.inputTokens, cached: tokens.cachedInputTokens, output: tokens.outputTokens }));
  return result;
}

/**
 * Installs one plugin of the person's skill library (`crossline-mine`, `crossline-public`), or installs it again after a skill in it was
 * rewritten: the runtime copies a plugin into its own cache, so the copy it serves changes only on install. Its skills are then switched
 * off, so each is on only for the runs that name it (`extraSkills`), not listed to every Skill run. Returns the skills it now holds.
 */
export async function installLibraryPlugin(client: CodexRpcBoundary, plugin: { marketplacePath: string; name: string; cwd: string }): Promise<string[]> {
  return underConfigLock(client, async () => {
    try { await client.request("plugin/install", { marketplacePath: plugin.marketplacePath, pluginName: plugin.name }); }
    catch { fail("SKILL_LIBRARY_INSTALL_FAILED"); }
    let response: unknown;
    try { response = await client.request("skills/list", { cwds: [plugin.cwd], forceReload: true }); }
    catch { fail("SKILL_LIST_FAILED"); }
    const entries = record(response)?.data;
    const skills = (Array.isArray(entries) ? entries : []).flatMap((entry) => {
      const listed = record(entry)?.skills;
      return Array.isArray(listed) ? listed.map(record).filter((skill): skill is Record<string, unknown> => Boolean(skill)) : [];
    }).filter((skill) => typeof skill.name === "string" && skill.name.startsWith(`${plugin.name}:`) && typeof skill.path === "string");
    // A skill a run is holding on stays on until that run lets go (`releaseSkill` switches it off then).
    const held = heldOn(client);
    for (const skill of skills.filter((item) => item.enabled === true && !held.has(String(item.path)))) await setNativeSkill(client, String(skill.path), false);
    for (const skill of skills) { const entry = held.get(String(skill.path)); if (entry) entry.restore = true; }
    return [...new Set(skills.map((skill) => String(skill.name)))].sort();
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
    message: said()(code === "SKILL_MISSING" ? "Skill 未安装；请恢复 Crossline plugin 后重试。"
      : code === "SKILL_LIST_FAILED" ? "无法读取 Codex Skill 状态；请恢复运行时后重试。"
      : "无法隔离启用该 Skill；未开始运行。")
  },
  audit
});

/** Narrower than `SkillRunOptions`: a continued turn reuses an already-started thread, so there is no
 * `developerInstructions`/`allowWebSearch`/`prepareInput` to set up — those only ever apply at
 * `thread/start`, which this path never calls. */
export type ContinueTurnOptions<T> = {
  skillName: string;
  cwd: string;
  /** Local image files the person attached to this message (a screenshot), shown with it. */
  images?: string[];
  outputSchema: unknown;
  /** The thread's language, as `SkillRunOptions.locale`: the output schema's length limits and the blocker the person reads follow it. */
  locale?: Locale;
  validateOutput: (output: unknown) => T;
  onAudit: (audit: AnalysisAudit) => void;
  onProgress?: (progress: SkillProgress) => void;
  onQueued?: (ahead: number) => void;
  priority?: ModelPriority;
  tenant?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleMs?: number;
  /** As `SkillRunOptions.softAccept`: keep part of an answer the repairs could not fix, when the problem is about content quality. */
  softAccept?: (rejection: Error, output: unknown) => T | undefined;
  /** As `SkillRunOptions.keepEarly`. */
  keepEarly?: (rejection: Error, output: unknown) => T | undefined;
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
  // `thread/resume` of a thread whose rollout is gone (a guest home deleted at sign-out) says it differently.
  return /thread not found|no rollout found/i.test(text);
}

/**
 * The runtime went away under a pending request: the local app-server exited or was stopped, or a compute node's connection
 * dropped. All three are the same interruption as `crossline/runtimeDisconnected` mid-turn, so they get its code and are retried;
 * a dropped node used to surface as its own code, which the assistant's retry rule read as a dead end.
 */
const RUNTIME_GONE = new Set(["CODEX_APP_SERVER_EXITED", "CODEX_APP_SERVER_STOPPED", "CROSSLINE_NODE_DISCONNECTED"]);

/** The blocker code for whatever ended a run. */
export function skillErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (RUNTIME_GONE.has(message)) return "SKILL_RUNTIME_EXITED";
  if (/^[A-Z][A-Z_]{2,}$/.test(message)) return message;
  return isThreadLost(error) ? "SKILL_THREAD_LOST" : "SKILL_RUNTIME_FAILED";
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
    dispose: () => stopWaiting(),
    client
  };
}
type Scope = ReturnType<typeof openScope>;

/**
 * The plugins a structured run keeps (found on the hosted beta, 2026-10-21). The runtime starts every MCP server of every active plugin
 * for each thread, and a ChatGPT account carries OpenAI's curated `codex-security` plugin: an ~80 MB node process per thread. During a
 * model measurement sixteen of them held the worker at its memory ceiling, the kernel killed the owner's runtime and the worker restarted,
 * three times in an hour, so the measurement started over each time. A structured run needs only Crossline's own plugins: its thread turns
 * every other plugin off (`plugins._default.enabled = false`) and each of ours on. The ids are read from the runtime's own settings
 * (`config/read`), where installing a plugin writes `[plugins."<name>@<marketplace>"] enabled = true`; `plugin/installed`, tried first,
 * lists only OpenAI's remote plugins and none from a local marketplace. When the settings hold none of ours, nothing is changed.
 */
const OWN_MARKETPLACES = ["crossline-local", "crossline-library"];
const pluginsLogged = new WeakSet<object>();
/** Crossline's own plugins switched on in the runtime's settings, or undefined when the main one is not among them. */
export function ownPluginsIn(config: Record<string, unknown>): string[] | undefined {
  const plugins = record(config.plugins) ?? {};
  const own = Object.keys(plugins).filter((id) => record(plugins[id])?.enabled === true
    && OWN_MARKETPLACES.some((marketplace) => id.endsWith(`@${marketplace}`))).sort();
  return own.some((id) => id.endsWith(`@${OWN_MARKETPLACES[0]}`)) ? own : undefined;
}
/**
 * The thread settings that leave only these plugins on: none when the list is unknown, or when a skill the run names (`plugin:skill`)
 * belongs to a plugin the list does not hold, which turning the rest off would take away from it.
 */
export function onlyOwnPlugins(ids: string[] | undefined, skills: string[] = []): Record<string, unknown> {
  if (!ids) return {};
  const names = new Set(ids.map((id) => id.split("@")[0]));
  if (!skills.every((skill) => !skill.includes(":") || names.has(skill.split(":")[0]))) return {};
  return { "plugins._default.enabled": false, ...Object.fromEntries(ids.map((id) => [`plugins.${id}.enabled`, true])) };
}

async function requireLogin(scope: Scope, context: RunContext): Promise<void> {
  // A provider routed through the gateway has its key there; there is no Codex account to be signed in to.
  if (context.provider) return;
  const account = record(await scope.rpc("account/read", { refreshToken: false }));
  // A provider that takes its key from the environment (`requires_openai_auth = false`) has no account to sign in to.
  if (!record(account?.account) && account?.requiresOpenaiAuth !== false) fail("SKILL_UNAUTHENTICATED");
}

/** What `thread/resume` takes of a thread's start parameters: the settings, never `dynamicTools` (kept with the thread on disk). */
const RESUMED_PARAMS = ["cwd", "sandbox", "approvalPolicy", "approvalsReviewer", "developerInstructions", "model", "modelProvider"] as const;

/**
 * Starts a thread, or resumes `resumeId` with the same settings (a resumed thread is given them again: a thread loaded from disk takes
 * them, one still loaded and idle is reloaded with them).
 *
 * The flag list is written against the newest runtime, but `--strict-config` rejects the whole call over one field an older runtime
 * never defined. A field this runtime does not know names a feature this runtime does not have, so dropping it removes no protection;
 * the real guarantees are the sandbox, the untrusted approval policy and the tool-call guard. A value it rejects cannot be dropped,
 * because that would silently turn off what was asked for: it fails as SKILL_CONFIG_REJECTED with the runtime's own diagnostics (config
 * text, never model output), which used to hide behind a bare SKILL_RUNTIME_FAILED.
 */
async function openThread(scope: Scope, threadParams: Record<string, unknown>, config: Record<string, unknown>, resumeId: string | undefined): Promise<Record<string, unknown> | undefined> {
  for (;;) {
    try {
      return record(resumeId
        ? await scope.rpc("thread/resume", { threadId: resumeId, excludeTurns: true, config,
          ...Object.fromEntries(RESUMED_PARAMS.filter((key) => threadParams[key] !== undefined).map((key) => [key, threadParams[key]])) })
        : await scope.rpc("thread/start", { ...threadParams, config }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const field = /unknown configuration field `([^`]+)`/.exec(message)?.[1];
      const dropped = field ? Object.keys(config).filter((key) => key === field || key.startsWith(`${field}.`)) : [];
      // The sandbox is never dropped to get a thread started: a runtime that cannot take the profile does not run the shell at all.
      if (dropped.some((key) => ["default_permissions", "permissions", "shell_environment_policy"].includes(key))) throw withDetail(new Error("SKILL_SANDBOX_UNSUPPORTED"), message.slice(0, 400));
      if (!dropped.length) {
        if (!isThreadLost(error) && /configuration|unknown variant/i.test(message)) throw withDetail(new Error("SKILL_CONFIG_REJECTED"), message.slice(0, 400));
        throw error;
      }
      for (const key of dropped) delete config[key];
    }
  }
}

/**
 * The assistant's thread: full access to the person's account, in the task's own directory, with every tool the runtime has. The
 * approval policy is still `untrusted`, so each command that is not on the runtime's own short list of harmless ones comes to
 * `agent.answer` first — that is the hook the guard rails hang on — and `web_search` is live. Nothing here is a sandbox; see
 * `agent-guard.ts` for what the guard is and is not.
 */
async function startAgentThread<T>(scope: Scope, options: SkillRunOptions<T>, context: RunContext, resumeId?: string): Promise<string> {
  const agent = options.agent!;
  // On a provider (only ever measured by the evaluation matrix; routing never sends the assistant there) the hosted search does not
  // exist: it is off, and `withWebTools` has given the thread Crossline's own search functions instead.
  const hosted = !context.provider;
  const config: Record<string, unknown> = {
    web_search: hosted ? "live" : "disabled", include_environment_context: true,
    // No Codex memory for the assistant either (2026-10-21, docs/token-economy.md §2): what it needs from earlier runs is given to it.
    "memories.use_memories": false, "memories.generate_memories": false, "features.memories": false,
    "features.shell_tool": true, "features.web_search": hosted, "features.standalone_web_search": hosted, "features.plugins": true,
    "features.view_image": true,
    // The runtime's plan tool (each update reaches `onPlan`, shown while the run works) and the person's ChatGPT connectors, read-only.
    ...(options.onPlan ? { "tools.update_plan.enabled": true } : {}),
    ...(options.connectors ? { "features.apps": true, ...CONNECTORS_READ_ONLY } : {}),
    ...(options.askPerson ? ASK_PERSON_CONFIG : {}),
    ...(context.provider ? { [`model_providers.${context.provider.id}`]: context.provider.definition, ...contextWindowConfig(context.provider) } : {}),
    // In the sandbox: a named permission profile (writes in the task directory, reads only what it is given, no network) and a
    // command environment that carries none of the worker's own variables.
    ...(agent.sandbox ? { default_permissions: SANDBOX_PROFILE, permissions: sandboxProfile(agent.sandbox),
      shell_environment_policy: { inherit: "core", set: { HOME: agent.sandbox.writable, TMPDIR: `${agent.sandbox.writable}/.tmp`, ...(agent.sandbox.env ?? {}) } } } : {})
  };
  const threadParams = {
    cwd: agent.cwd, ...(agent.sandbox ? {} : { sandbox: "danger-full-access" }), approvalPolicy: "untrusted", approvalsReviewer: "user",
    // Tools Crossline answers itself (reading a site behind the person's login, so the assistant never holds the browser profile).
    dynamicTools: (options.tools?.specs ?? []).map((spec) => ({ type: "function", name: spec.name, description: spec.description, inputSchema: spec.inputSchema })),
    ephemeral: false, experimentalRawEvents: false,
    developerInstructions: `${options.developerInstructions}\n\n${agentLanguageLine(runLocale(options.locale, currentUsageWorkspace()))}`,
    ...(context.route ? { model: context.route.model } : {}),
    ...(context.provider ? { modelProvider: context.provider.id } : {})
  };
  const started = await openThread(scope, threadParams, config, resumeId);
  const threadId = record(started?.thread)?.id;
  if (!identifier(threadId) || (resumeId && threadId !== resumeId)) fail("SKILL_PROTOCOL_INVALID");
  // The thread must really be running with the approval policy the guard hangs on; with `never` nothing would ever ask.
  if (started?.approvalPolicy !== "untrusted") fail("SKILL_PERMISSION_DENIED");
  // And, sandboxed, under the profile it was given: anything else (full access, the runtime's default) is refused before a turn.
  if (agent.sandbox && (record(started?.activePermissionProfile)?.id !== SANDBOX_PROFILE || record(started?.sandbox)?.type === "dangerFullAccess")) fail("SKILL_SANDBOX_UNSUPPORTED");
  return threadId;
}

/**
 * Starts the one thread a fresh run uses, with everything that makes it safe to run unattended: read-only sandbox, the
 * `untrusted` approval policy, no tools but the one granted, no instruction files, no MCP servers. Returns its id.
 */
async function startIsolatedThread<T>(scope: Scope, options: SkillRunOptions<T>, context: RunContext, resumeId?: string): Promise<string> {
  const runtimeConfig = record(record(await scope.rpc("config/read", { includeLayers: false }))?.config);
  if (!runtimeConfig) fail("SKILL_PROTOCOL_INVALID");
  const mcp = record(runtimeConfig.mcp_servers) ?? {};
  if (options.agent) return startAgentThread(scope, options, context, resumeId);
  // A run with connectors or the image tool may use what another plugin brings, so it keeps them all.
  const own = options.connectors || options.allowImageGeneration ? undefined : ownPluginsIn(runtimeConfig);
  if (!pluginsLogged.has(scope.client)) {
    pluginsLogged.add(scope.client);
    // Plugin ids only, once per runtime: what a structured run keeps, for reading why one kept every plugin.
    console.info(JSON.stringify({ type: "skill.plugins", own: ownPluginsIn(runtimeConfig) ?? null, configured: Object.keys(record(runtimeConfig.plugins) ?? {}).length }));
  }
  const ownOnly = onlyOwnPlugins(own, [options.skillName, ...context.extraSkills]);
  context.plugins = Object.keys(ownOnly).length ? "own" : "all";
  const config: Record<string, unknown> = {
    // "live", not "enabled": this runtime's `web_search` takes `disabled | cached | live`, and the
    // wrong variant made the whole thread/start fail — so the one Skill granted the web could never
    // start at all. A scout that must cite what it read needs `live` rather than `cached`.
    web_search: options.allowWebSearch ? "live" : "disabled", project_doc_max_bytes: 0, include_environment_context: false,
    // No Codex memory, generated or used (the owner's decision of 2026-10-21, docs/token-economy.md §1–2; it had been on by his
    // earlier choice). Every idle thread cost a stage-1 summary on the account's own quota and the consolidation another, neither
    // counted in `model_usage`; 510 summaries from 2026-10-20 were never used once (a structured run has no shell to read MEMORY.md
    // and its JSON never cites it); the memory block changed each run's opening and so missed the prompt cache; and several accounts'
    // runs were mixed into the one memory of the owner's runtime. What a run should know from earlier runs comes from the ledger.
    "memories.use_memories": false, "memories.generate_memories": false,
    "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
    "features.plugins": true, "features.memories": false,
    // Goals are off too: a goal the model set would start turns of its own after this run had its answer (they are on by default).
    ...Object.fromEntries(["shell_tool", "multi_agent", "multi_agent_v2", "apps", "hooks", "codex_hooks", "plugin_hooks", "web_search", "standalone_web_search", "image_generation", "view_image", "request_permissions_tool", "tool_suggest", "token_budget", "current_time_reminder", "sleep_tool", "send_message_to_user_async", "js_repl", "code_mode", "deferred_executor", "goals"]
      .map((key) => [`features.${key}`, (Boolean(options.allowWebSearch) && (key === "web_search" || key === "standalone_web_search"))
        || (Boolean(options.allowImageGeneration) && key === "image_generation")
        // Not through another provider yet: the conformance cases have not measured `exec` there.
        || (Boolean(options.codeMode && options.tools && !context.provider) && key === "code_mode")
        || (Boolean(options.connectors) && key === "apps")])),
    ...(options.connectors ? CONNECTORS_READ_ONLY : {}),
    ...(options.onPlan ? { "tools.update_plan.enabled": true } : {}),
    ...(options.askPerson ? ASK_PERSON_CONFIG : {}),
    ...Object.fromEntries(Object.keys(mcp).map((key) => [`mcp_servers.${key}.enabled`, false])),
    ...ownOnly,
    // Another provider: defined for this thread only (memories are off above for every run).
    ...(context.provider ? { [`model_providers.${context.provider.id}`]: context.provider.definition, ...contextWindowConfig(context.provider),
      // The catalog of every skill on this runtime is not needed (the run names its own) and changes with what other runs hold on, which
      // would make each request's opening differ and miss the provider's cache.
      "skills.include_instructions": false } : {})
  };
  const threadParams = {
    environments: [], runtimeWorkspaceRoots: [], sandbox: "read-only", approvalPolicy: "untrusted", approvalsReviewer: "user",
    dynamicTools: (options.tools?.specs ?? []).map((spec) => ({ type: "function", name: spec.name, description: spec.description, inputSchema: spec.inputSchema })),
    ephemeral: false, experimentalRawEvents: false,
    developerInstructions: `${options.developerInstructions}\n\n${styleInstructions(runLocale(options.locale, currentUsageWorkspace()), options.secondPerson)}`,
    // Left unset for a Skill with no route, so an unlisted job still runs on the runtime's default.
    ...(context.route ? { model: context.route.model } : {}),
    ...(context.provider ? { modelProvider: context.provider.id } : {})
  };
  const started = await openThread(scope, threadParams, config, resumeId);
  const threadId = record(started?.thread)?.id;
  if (!identifier(threadId) || (resumeId && threadId !== resumeId)) fail("SKILL_PROTOCOL_INVALID");
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
  skillName: string; threadId: string; outputSchema: unknown; allowedItemTypes: string[];
  /** One text, or several sent as the parts of one message in this order (`firstPromptTexts`). */
  firstPrompt: string | string[];
  /** Local image files shown with the first prompt (a payment or meal screenshot the person attached); never resent with a repair. */
  images?: string[];
  onPlan?: SkillRunOptions<unknown>["onPlan"];
  validate: (output: unknown) => T; onAudit: (audit: AnalysisAudit) => void; idleMs?: number; agent?: AgentMode;
  soften?: (rejection: Error, output: unknown) => T | undefined;
  keepEarly?: (rejection: Error, output: unknown) => T | undefined;
  onImage?: (image: { base64: string; revisedPrompt: string }) => void;
  onProgress?: (progress: SkillProgress) => void;
}): Promise<T> {
  audit.threadId = run.threadId;
  let finalText: string | undefined;
  // The answer as it streams in, for `onProgress` only.
  let streamed = "";
  let reportedAt = 0;
  // Writing is throttled against the previous write only, so the first words show at once.
  const progress = (phase: SkillProgress["phase"]) => {
    if (!run.onProgress) return;
    if (phase === "writing") { if (Date.now() - reportedAt < 500) return; reportedAt = Date.now(); }
    try { run.onProgress({ phase, text: streamed, repairs: audit.repairs ?? 0, stalls: audit.stalls ?? 0 }); } catch { /* a screen's bookkeeping must never fail the work */ }
  };
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
    if (message.method === "thread/tokenUsage/updated") { context.usage.note(params); noteContext(client, run.threadId, params); return; }
    if (message.method === "turn/plan/updated") {
      const steps = Array.isArray(params.plan) ? params.plan.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({ step: String(item.step ?? "").slice(0, 200), status: String(item.status ?? "") })) : [];
      try { run.onPlan?.({ explanation: typeof params.explanation === "string" ? params.explanation.slice(0, 300) : "", steps: steps.slice(0, 30) }); } catch { /* the caller's display */ }
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      if (typeof params.delta === "string" && streamed.length < 200_000) { streamed += params.delta; progress("writing"); }
      return;
    }
    if (message.method === "item/completed" || message.method === "item/started") {
      const item = record(params.item);
      if (item?.type === "agentMessage" && message.method === "item/completed" && (item.phase === "final_answer" || item.phase === null)) {
        if (typeof item.text !== "string" || item.text.length > 100_000) settle?.reject(new Error("SKILL_SCHEMA_INVALID"));
        else finalText = item.text;
      } else if (run.agent) {
        // The assistant is meant to use tools; what it did is recorded, not refused here (the guard answers each request).
        if (item) { try { run.agent.onItem(item, message.method === "item/started" ? "started" : "completed"); } catch { /* the audit must never fail the work */ } }
      } else if (item?.type === "mcpToolCall" && !run.allowedItemTypes.includes("mcpToolCall")
        && (message.method === "item/started" || item.status === "failed" || item.error)) {
        // A model on another provider sometimes calls a tool this run never offered (2026-10-19: two sponsor candidates' interview turn
        // 1). The runtime finds no such server and hands the model an error, so nothing ran: the turn goes on. Only a call that completed
        // is refused below.
        if (message.method === "item/completed") console.info(JSON.stringify({ type: "skill.tool_call_refused", skill: run.skillName,
          server: String(item.server ?? ""), tool: String(item.tool ?? ""), at: new Date().toISOString() }));
      } else if (item?.type === "mcpToolCall" && RUNTIME_RESOURCE_TOOLS.has(String(item.tool ?? ""))) {
        if (message.method === "item/completed") console.info(JSON.stringify({ type: "skill.resource_tool_used", skill: run.skillName,
          tool: String(item.tool), at: new Date().toISOString() }));
      } else if (item && !run.allowedItemTypes.includes(String(item.type)) && !HARMLESS_ITEM_TYPES.has(String(item.type))) {
        console.info(JSON.stringify({ type: "skill.item_forbidden", skill: run.skillName, item: String(item.type),
          ...(item.type === "mcpToolCall" ? { server: String(item.server ?? ""), tool: String(item.tool ?? "") } : {}), at: new Date().toISOString() }));
        settle?.reject(withDetail(new Error("SKILL_TOOL_FORBIDDEN"), `item:${String(item.type)}`));
      }
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
  const runTurn = async (text: string | string[], images: string[] = []): Promise<string> => {
    finalText = undefined;
    streamed = "";
    reportedAt = 0;
    progress("thinking");
    lastEventAt = Date.now();
    // Cleared so the handler's "events can precede the turn/start response" guard arms again.
    delete audit.turnId;
    const completed = new Promise<string | undefined>((resolve, reject) => { settle = { resolve, reject }; });
    // Attach a rejection handler immediately, including events that beat the RPC response.
    void completed.catch(() => {});
    const route = context.route;
    const turn = record(record(await scope.rpc("turn/start", {
      threadId: run.threadId, ...(run.agent ? {} : { environments: [] }), input: [...(Array.isArray(text) ? text : [text]).map((part) => ({ type: "text", text: part, text_elements: [] })), ...images.map((path) => ({ type: "localImage", path }))], outputSchema: run.outputSchema,
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
    streamed = answer;
    progress("checking");
    return answer;
  };

  /** Models routinely wrap JSON in a ```json fence even when told to return JSON only: a transport habit, not invented content. */
  const parse = (answer: string): unknown => {
    try { return cleanAnswerStrings(JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""))); }
    catch { throw withDetail(new Error("SKILL_SCHEMA_INVALID"), "the answer was not valid JSON (cut off, or it repeated itself); return the complete JSON object once"); }
  };

  /** A silent turn is interrupted and the same prompt sent again, a couple of times; every other failure ends the run as before. */
  const runTurnOrRetryStall = async (prompt: string | string[], images: string[] = []): Promise<string> => {
    for (let stalls = 0; ; stalls += 1) {
      try { return await runTurn(prompt, images); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "SKILL_STALLED" || stalls >= MAX_STALL_RETRIES) throw error;
        if (audit.turnId) abandoned.add(audit.turnId);
        if (audit.threadId && audit.turnId) void client.request("turn/interrupt", { threadId: audit.threadId, turnId: audit.turnId }).catch(() => {});
        audit.stalls = (audit.stalls ?? 0) + 1;
        run.onAudit({ ...audit });
        // A resent turn is the one thing a person feels as a long wait; the log says so, so the cause can be read without guessing.
        console.log(JSON.stringify({ type: "skill.stalled", skill: run.skillName, stalls: audit.stalls, idleMinutes: Math.round(idleMs / 60_000) }));
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
          + "explain, apologise, or add commentary outside the JSON.", attempt === 0 ? run.images ?? [] : []);
      let parsed: unknown;
      try {
        parsed = parse(answer);
        return run.validate(parsed);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
        const detail = (rejection as Detailed).detail ?? "";
        // What the receiving layer refused, so the cause of slow turns can be read from the log (codes and a short detail, never the answer).
        console.log(JSON.stringify({ type: "skill.rejected", skill: run.skillName, attempt, code: rejection.message.slice(0, 80), detail: detail.slice(0, 240) }));
        if (parsed !== undefined && run.keepEarly && !/_BLOCKED$/.test(rejection.message)) {
          const kept = run.keepEarly(rejection, parsed);
          if (kept !== undefined) {
            audit.warnings = [{ code: rejection.message, detail }];
            run.onAudit({ ...audit });
            return kept;
          }
        }
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
function failureResult<T>(client: CodexRpcBoundary, error: unknown, audit: AnalysisAudit, locale?: Locale): SkillRunResult<T> {
  const t = said(locale);
  if (audit.threadId && audit.turnId) void client.request("turn/interrupt", { threadId: audit.threadId, turnId: audit.turnId }).catch(() => {});
  const code = skillErrorCode(error);
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
  if (code === "SKILL_TURN_FAILED") return { ok: false, blocker: { code, message: turnFailureAdvice(detail, runLocale(locale, currentUsageWorkspace())), ...(detail ? { detail: shownDetail(detail) } : {}) }, audit };
  if (code === "SKILL_TOOL_FORBIDDEN") return { ok: false, blocker: { code, message: t("模型这一轮用了此处不允许的功能，已拦下；可以重试。"), ...(detail ? { detail } : {}) }, audit };
  return { ok: false, blocker: { code, message: advice[code] ? t(advice[code]) : detail ?? t("这一轮没有完成；可以重试。"), ...(detail && advice[code] ? { detail: shownDetail(detail) } : {}) }, audit };
}

/**
 * One more turn on a thread a previous `runCodexSkill` call already started — the conversational follow-up path. There is no
 * thread to start, so no instructions, web grant or input preparation: those only ever apply at `thread/start`.
 */
export async function continueSkillTurn<T>(client: CodexRpcBoundary, threadId: string, message: string,
  options: ContinueTurnOptions<T>): Promise<SkillRunResult<T>> {
  const onChatgpt = decideRoute(options.skillName, currentProviderRouting()).via === "codex";
  const result = await continueOnThread(client, threadId, message, options);
  // ChatGPT's quota refused the turn: once the developer's model serves this Skill the conversation is rebuilt there, the way a
  // thread the runtime lost is (the thread itself stays on the provider it was started on).
  if (!onChatgpt || result.ok || result.blocker.code !== "SKILL_USAGE_LIMIT") return result;
  noteChatgptUsageLimit();
  if (decideRoute(options.skillName, currentProviderRouting()).via !== "provider") return result;
  return { ok: false, blocker: { code: "SKILL_THREAD_LOST", message: said(options.locale)("ChatGPT 额度已用尽，这段对话改由开发者提供的模型接着进行。") }, audit: result.audit };
}

function continueOnThread<T>(client: CodexRpcBoundary, threadId: string, message: string,
  options: ContinueTurnOptions<T>): Promise<SkillRunResult<T>> {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, blocker: { code: "SKILL_CANCELED", message: said(options.locale)("已取消；未开始运行。") }, audit: {} });
  return inLane(threadLanes, `${runtimeKey(client)}:${threadId}`, () => executeSkill(client, { ...options, threadId }, async (context): Promise<SkillRunResult<T>> => {
    // The runtime the thread lives on (a compute node's, if it was started there).
    const client = context.client;
    const audit: AnalysisAudit = { threadId };
    holdThread(client, threadId);
    const scope = openScope(client, options);
    const unregister = options.tools ? registerAgentThread(client, threadId, toolAnswerer(options.tools)) : undefined;
    try {
      if (threadRouteMoved(client, threadId, context)) fail("SKILL_THREAD_LOST");
      await requireLogin(scope, context);
      await resubscribe(client, scope, threadId);
      const output = await runTurnsUntilValid(client, scope, context, audit, {
        skillName: options.skillName, threadId, outputSchema: schemaForLocale(options.outputSchema, runLocale(options.locale, currentUsageWorkspace())),
        allowedItemTypes: ["agentMessage", "reasoning", "userMessage", ...(options.tools ? ["dynamicToolCall"] : [])],
        firstPrompt: message, ...(options.images?.length ? { images: options.images } : {}),
        validate: options.validateOutput, onAudit: options.onAudit, ...(options.idleMs ? { idleMs: options.idleMs } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.softAccept ? { soften: options.softAccept } : {}),
        ...(options.keepEarly ? { keepEarly: options.keepEarly } : {})
      });
      return { ok: true, output, audit };
    } catch (error) { return failureResult<T>(client, error, audit, options.locale); }
    finally { unregister?.(); scope.dispose(); releaseThread(client, threadId, THREAD_KEEP_MS); queueCompaction(client, threadId, options.skillName); }
  }));
}

export async function runCodexSkill<T>(client: CodexRpcBoundary, input: unknown, options: SkillRunOptions<T>): Promise<SkillRunResult<T>> {
  if (options.signal?.aborted) return { ok: false, blocker: { code: "SKILL_CANCELED", message: said(options.locale)("已取消；未开始运行。") }, audit: {} };
  const onChatgpt = !options.provider && decideRoute(options.skillName, currentProviderRouting()).via === "codex";
  let first = await executeSkill(client, options, (context) => runSkillTurn(context.client, input, options, context));
  // The account's ChatGPT quota refused the run: the worker marks it spent, and where the developer's model now serves this Skill the
  // run goes there once (2026-10-21). Nothing else changes about the run.
  if (onChatgpt && !first.ok && first.blocker.code === "SKILL_USAGE_LIMIT" && !options.signal?.aborted) {
    noteChatgptUsageLimit();
    if (decideRoute(options.skillName, currentProviderRouting()).via === "provider") {
      console.log(JSON.stringify({ type: "skill.rerun_on_sponsor", skill: options.skillName }));
      first = await executeSkill(client, options, (context) => runSkillTurn(context.client, input, options, context));
    }
  }
  if (!options.redoOnRepair || options.mainModel || !first.ok || !first.audit.repairs || !onSkillModel(options)) return first;
  console.log(JSON.stringify({ type: "skill.redo_on_main_model", skill: options.skillName, repairs: first.audit.repairs }));
  const main = { ...options, mainModel: true };
  const second = await executeSkill(client, main, (context) => runSkillTurn(context.client, input, main, context));
  return second.ok ? { ...second, audit: { ...second.audit, redone: { repairs: first.audit.repairs } } } : first;
}

/** Whether this run goes to a model the provider keeps for this Skill rather than its own (what `redoOnRepair` redoes). */
function onSkillModel<T>(options: SkillRunOptions<T>): boolean {
  if (options.provider) return false;
  const routing = currentProviderRouting();
  const decision = decideRoute(options.skillName, routing);
  return decision.via === "provider" && Boolean(routing) && decision.provider.model !== routing!.provider.model;
}

/**
 * Releasing threads (found on the hosted beta, 2026-10-16). The runtime keeps a thread loaded — and with it every MCP server its plugins
 * start, a ChatGPT account's curated `codex-security` plugin among them, a 79 MB node process each — for as long as a client is
 * subscribed, and this client never left one: twelve of them filled the worker's 600 MB. Unsubscribing lets the runtime unload the
 * thread (and stop its servers) a minute later. A one-off run's thread is released when the run ends; a conversation's after
 * `THREAD_KEEP_MS` without a turn.
 */
export const THREAD_KEEP_MS = Math.max(60_000, (Number(process.env.CROSSLINE_THREAD_KEEP_MINUTES) || 10) * 60_000);
const releaseTimers = new WeakMap<object, Map<string, ReturnType<typeof setTimeout>>>();
/** Threads this client unsubscribed from: a later turn on one must subscribe again first (`resubscribe`). */
const releasedThreads = new WeakMap<object, Set<string>>();
function releasedOf(client: CodexRpcBoundary): Set<string> {
  let released = releasedThreads.get(client);
  if (!released) { released = new Set(); releasedThreads.set(client, released); }
  return released;
}
function timersOf(client: CodexRpcBoundary): Map<string, ReturnType<typeof setTimeout>> {
  let timers = releaseTimers.get(client);
  if (!timers) { timers = new Map(); releaseTimers.set(client, timers); }
  return timers;
}
/** A turn is about to use this thread: it must not be released under it. */
function holdThread(client: CodexRpcBoundary, threadId: string): void {
  const timers = timersOf(client);
  const timer = timers.get(threadId);
  if (timer) clearTimeout(timer);
  timers.delete(threadId);
}
export function releaseThread(client: CodexRpcBoundary, threadId: string, afterMs = 0): void {
  holdThread(client, threadId);
  const release = () => {
    timersOf(client).delete(threadId);
    releasedOf(client).add(threadId);
    // Best effort: a runtime that is gone or restarted has unloaded the thread already.
    void Promise.resolve().then(() => client.request("thread/unsubscribe", { threadId })).catch(() => undefined);
  };
  if (afterMs <= 0) { release(); return; }
  const timer = setTimeout(release, afterMs);
  (timer as { unref?: () => void }).unref?.();
  timersOf(client).set(threadId, timer);
}

/**
 * Subscribes this client to a thread it let go of, before another turn on it (found on the hosted beta, 2026-10-17). An unsubscribed
 * thread stays loaded until the runtime's idle unload, and `turn/start` on it runs — but the runtime sends this connection none of the
 * turn's events, since only `thread/start` and `thread/resume` attach a listener. An interview round sent eleven minutes after the
 * previous one sat silent until the 20-minute stall check resent it, and the person waited 26 minutes for an answer the model had
 * long finished. A thread that is still loaded is resumed (warm, keeping the settings it was started with); one the runtime has
 * already unloaded is reported lost, so the caller rebuilds it from the conversation (`SKILL_THREAD_LOST`) instead of a cold resume
 * that would not carry those settings.
 */
async function resubscribe(client: CodexRpcBoundary, scope: Scope, threadId: string): Promise<void> {
  const released = releasedOf(client);
  if (!released.has(threadId)) return;
  let loaded = false;
  let cursor: string | undefined;
  for (let page = 0; page < 10 && !loaded; page += 1) {
    const listed = record(await scope.rpc("thread/loaded/list", cursor ? { cursor } : {}));
    const ids = Array.isArray(listed?.data) ? listed.data : [];
    loaded = ids.includes(threadId);
    cursor = typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
    if (!cursor) break;
  }
  if (!loaded) { released.delete(threadId); throw new Error(`thread not found: ${threadId}`); }
  await scope.rpc("thread/resume", { threadId, excludeTurns: true });
  released.delete(threadId);
}

/**
 * The prepared input with its stable keys first (`SkillRunOptions.stableKeys`), then every other key in the order the runner wrote it.
 * Only the order moves: the same keys and values, so the Skill reads the same object.
 */
export function cacheOrderedInput(prepared: unknown, stableKeys: readonly string[] = []): unknown {
  const object = record(prepared);
  if (!object || !stableKeys.length) return prepared;
  const first = stableKeys.filter((key, index) => Object.hasOwn(object, key) && stableKeys.indexOf(key) === index);
  return Object.fromEntries([...first, ...Object.keys(object).filter((key) => !first.includes(key))].map((key) => [key, object[key]]));
}

/** How the run note is introduced, so the model reads it as part of its instructions for this run. */
export const RUN_NOTE_LEAD = "Instructions for this run only (they extend the developer instructions):";

/**
 * A fresh run's first message, in parts, ordered for the prompt cache (docs/token-economy.md §2.5). The runtime records the whole message
 * first and the `<skill>` blocks of the skills it names only after it (vendor/codex core/src/session/turn.rs: the message is recorded by
 * `run_hooks_and_record_inputs`, the blocks `build_skills_and_plugins` made are recorded after it), so on this path no Skill text can
 * come before the input; what can be ordered is the message itself: the target Skill's name and the input with its stable keys first,
 * then what changes from run to run — the library skills named (they follow the line and the task; a name is read from any part,
 * skills/src/selection.rs `collect_explicit_skill_mentions`) and the run note.
 */
export function firstPromptTexts(skillName: string, extraSkills: readonly string[], prepared: unknown,
  options: { stableKeys?: readonly string[] | undefined; runNote?: string | undefined } = {}): string[] {
  const note = options.runNote?.trim();
  return [`$${skillName}\n\n${JSON.stringify(cacheOrderedInput(prepared, options.stableKeys))}`,
    ...(extraSkills.length ? [extraSkills.map((name) => `$${name}`).join(" ")] : []),
    ...(note ? [`${RUN_NOTE_LEAD}\n${note}`] : [])];
}

async function runSkillTurn<T>(client: CodexRpcBoundary, given: unknown, wanted: SkillRunOptions<T>, context: RunContext): Promise<SkillRunResult<T>> {
  const { options: requested, input } = withOptionalTools(wanted, given, context);
  const options = withWebTools(requested, context);
  const audit: AnalysisAudit = {};
  // Web search is the only tool any Skill may use, and only when that Skill was granted it.
  const allowedItemTypes = ["agentMessage", "reasoning", "userMessage",
    ...(options.allowWebSearch ? ["webSearch", "webSearchCall"] : []), ...(options.allowImageGeneration ? ["imageGeneration"] : []),
    ...(options.tools ? ["dynamicToolCall"] : []), ...(options.connectors ? ["mcpToolCall"] : [])];
  let scope: Scope | undefined;
  let unregister: (() => void) | undefined;
  try {
    const prepared = options.prepareInput(input);
    scope = openScope(client, options);
    await requireLogin(scope, context);
    const threadId = await openRunThread(client, scope, options, context, audit);
    audit.threadId = threadId;
    rememberThreadRoute(client, threadId, context);
    options.onAudit({ ...audit });
    if (options.agent) {
      // One handler per thread: a tool call goes to the tools, everything else (approvals) to the guard.
      const agentAnswer = options.agent.answer;
      const tools = options.tools ? toolAnswerer(options.tools) : undefined;
      unregister = registerAgentThread(client, threadId, withPersonQuestions(options.askPerson,
        (method, params) => method === "item/tool/call" && tools ? tools(method, params) : agentAnswer(method, params)));
    }
    else if (options.tools) unregister = registerAgentThread(client, threadId, withPersonQuestions(options.askPerson, toolAnswerer(options.tools)));
    // A connector tool that is not read-only comes as an approval request: refused (an error answer denies the call).
    else if (options.connectors || options.askPerson) unregister = registerAgentThread(client, threadId, withPersonQuestions(options.askPerson, refuseAll));
    const output = await runTurnsUntilValid(client, scope, context, audit, {
      skillName: options.skillName, threadId, outputSchema: schemaForLocale(options.outputSchema, runLocale(options.locale, currentUsageWorkspace())), allowedItemTypes, ...(options.onImage ? { onImage: options.onImage } : {}),
      ...(options.onPlan ? { onPlan: options.onPlan } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      firstPrompt: firstPromptTexts(options.skillName, context.extraSkills, prepared, options),
      ...(options.images?.length ? { images: options.images } : {}),
      validate: (answer) => options.validateOutput(answer, prepared), onAudit: options.onAudit, ...(options.idleMs ? { idleMs: options.idleMs } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.softAccept ? { soften: (rejection: Error, answer: unknown) => options.softAccept!(rejection, answer, prepared) } : {}),
      ...(options.keepEarly ? { keepEarly: (rejection: Error, answer: unknown) => options.keepEarly!(rejection, answer, prepared) } : {})
    });
    return { ok: true, output, audit };
  } catch (error) { return failureResult<T>(client, error, audit, options.locale); }
  finally {
    unregister?.(); scope?.dispose();
    if (audit.threadId) releaseThread(client, audit.threadId, options.keepThread ? THREAD_KEEP_MS : 0);
    if (audit.threadId && options.keepThread) queueCompaction(client, audit.threadId, options.skillName);
  }
}

/** The run's thread: a new one, or `resumeThreadId` gone on with — and a new one when the runtime no longer has it. */
async function openRunThread<T>(client: CodexRpcBoundary, scope: Scope, options: SkillRunOptions<T>, context: RunContext, audit: AnalysisAudit): Promise<string> {
  const resumeId = options.resumeThreadId;
  if (!resumeId) return startIsolatedThread(scope, options, context);
  try {
    const threadId = await startIsolatedThread(scope, options, context, resumeId);
    // Subscribed again: a later release of it is a fresh one.
    releasedOf(client).delete(threadId);
    audit.resumed = true;
    return threadId;
  } catch (error) {
    if (!isThreadLost(error)) throw error;
    console.info(JSON.stringify({ type: "skill.resume_lost", skill: options.skillName, threadId: resumeId }));
    audit.resumed = false;
    return startIsolatedThread(scope, options, context);
  }
}

/**
 * Explicit compaction of a long conversation (Codex `thread/compact/start`, 2026-10-20). The runtime already compacts by itself when a
 * turn would overflow the window, but it does so at the start of the person's next turn, which then waits for it — the moment a tester's
 * long interview turned slow. A conversation that keeps its thread (the interview's dialogue, the input box, the milestone architect) is
 * compacted between turns instead, as soon as the context reported by the last turn (`thread/tokenUsage/updated`: `last.totalTokens`
 * against `modelContextWindow`, which for a provider is what `contextWindowConfig` told the runtime) passes `COMPACT_AT` of the window.
 * It waits in the thread's own line, so no turn is sent while it runs, and in the model gate at the Skill's own priority.
 */
export const COMPACT_AT = (() => { const value = Number(process.env.CROSSLINE_COMPACT_AT); return value > 0 && value < 1 ? value : 0.6; })();
const COMPACT_TIMEOUT_MS = 10 * 60_000;
const threadContexts = new WeakMap<object, Map<string, { used: number; window: number }>>();
function contextsOf(client: CodexRpcBoundary): Map<string, { used: number; window: number }> {
  let contexts = threadContexts.get(client);
  if (!contexts) { contexts = new Map(); threadContexts.set(client, contexts); }
  return contexts;
}
/** How full a thread's context was after its last model call, from a `thread/tokenUsage/updated` notification. */
function noteContext(client: CodexRpcBoundary, threadId: string, params: Record<string, unknown>): void {
  const usage = record(params.tokenUsage);
  const used = Number(record(usage?.last)?.totalTokens);
  const window = Number(usage?.modelContextWindow);
  if (used > 0 && window > 0) contextsOf(client).set(threadId, { used, window });
}
/** Whether the thread's context has filled past `COMPACT_AT` of its window, and how far. */
export function compactionDue(client: CodexRpcBoundary, threadId: string): { used: number; window: number } | undefined {
  const context = contextsOf(client).get(threadId);
  return context && context.used >= context.window * COMPACT_AT ? context : undefined;
}
/** Queues a compaction behind the thread's current turn when one is due; the next turn on the thread waits for it. */
function queueCompaction(client: CodexRpcBoundary, threadId: string, skillName: string): void {
  if (!compactionDue(client, threadId)) return;
  void inLane(threadLanes, `${runtimeKey(client)}:${threadId}`, () => compactThread(client, threadId, skillName)).catch(() => undefined);
}

/** Compacts one thread now, if still due. Resolves true when the runtime reported the compaction done; logged as `skill.compacted`. */
export async function compactThread(client: CodexRpcBoundary, threadId: string, skillName: string): Promise<boolean> {
  const before = compactionDue(client, threadId);
  if (!before) return false;
  holdThread(client, threadId);
  const startedAt = Date.now();
  let outcome: { ok: boolean; code?: string; tokens?: number } = { ok: false, code: "SKILL_CANCELED" };
  try {
    outcome = await withModelSlot({ skill: `${skillName}#compact`, priority: priorityForSkill(skillName), tenant: tenantOf(currentUsageWorkspace()) ?? "-" }, async () => {
      markClientBusy(client, 1);
      try { return await runCompaction(client, threadId, skillName); } finally { markClientBusy(client, -1); }
    }) ?? outcome;
  } catch (error) {
    outcome = { ok: false, code: skillErrorCode(error) };
  } finally {
    // Kept for the conversation as after any turn.
    releaseThread(client, threadId, THREAD_KEEP_MS);
  }
  if (outcome.ok) contextsOf(client).delete(threadId);
  console.info(JSON.stringify({ type: "skill.compacted", skill: skillName, threadId, ok: outcome.ok, ...(outcome.code ? { code: outcome.code } : {}),
    beforeTokens: before.used, window: before.window, ...(outcome.tokens ? { tokens: outcome.tokens } : {}), ms: Date.now() - startedAt }));
  return outcome.ok;
}

/** `thread/compact/start`, then the compaction turn's own events: a `contextCompaction` item and the turn's completion. */
async function runCompaction(client: CodexRpcBoundary, threadId: string, skillName: string): Promise<{ ok: boolean; code?: string; tokens?: number }> {
  const scope = openScope(client, { timeoutMs: COMPACT_TIMEOUT_MS });
  const usage = createUsageCollector();
  let turnId: string | undefined;
  let settle: (value: { ok: boolean; code?: string }) => void = () => {};
  const done = new Promise<{ ok: boolean; code?: string }>((resolve) => { settle = resolve; });
  const unsubscribe = client.onNotification((message) => {
    if (message.method === "crossline/runtimeDisconnected") return settle({ ok: false, code: "SKILL_RUNTIME_EXITED" });
    const params = record(message.params);
    if (!params || params.threadId !== threadId) return;
    const turn = record(params.turn);
    const id = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : undefined;
    // The compaction is a turn of its own: the first one this thread starts after the request (the line holds every other turn back).
    if (!turnId && (message.method === "turn/started" || (message.method === "item/started" && record(params.item)?.type === "contextCompaction"))) turnId = id;
    if (!turnId || id !== turnId) return;
    if (message.method === "thread/tokenUsage/updated") usage.note(params);
    if (message.method === "turn/completed") settle(turn?.status === "completed" ? { ok: true } : { ok: false, code: turn?.status === "interrupted" ? "SKILL_CANCELED" : "SKILL_TURN_FAILED" });
  });
  const startedAt = Date.now();
  try {
    await resubscribe(client, scope, threadId);
    await scope.rpc("thread/compact/start", { threadId });
    const limit = scope.window();
    try {
      const result = await Promise.race([done, limit.promise]);
      return { ...result, tokens: usage.total().totalTokens };
    } catch (error) {
      // A compaction still going when the line moves on would take the next turn as input to steer it: it is stopped first.
      if (turnId) void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      throw error;
    } finally { limit.clear(); }
  } finally {
    unsubscribe(); scope.dispose();
    // What compacting cost is the conversation's own cost (Settings → 模型用量 counts it under the Skill).
    if (usage.turns()) reportUsage({ skillName, spendMode: "normal", threadId, ok: true, repairs: 0, turns: usage.turns(),
      durationMs: Date.now() - startedAt, at: new Date(startedAt).toISOString(), ...usage.total() });
  }
}
