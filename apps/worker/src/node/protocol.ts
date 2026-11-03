// i18n-exempt: the compute node's own words, shown by the standalone node program (bundled alone, without the catalogues; Chinese only)
import path from "node:path";

/**
 * The compute node's wire (docs/compute-node.md). One WebSocket from the person's computer to the hosted worker carries JSON frames:
 *
 * - `hello` (node → server, first): the node's Codex runtime version, platform, host name, kind (a linked device or the standalone node)
 *   and how many runs it takes at once;
 * - `welcome` (server → node): what the server's paths and model gateway look like, so the node can map them onto its own;
 * - `rpc`: one JSON-RPC line of the node's `codex app-server`, either way, unchanged except where the node rewrites a request (below);
 * - `files` (node asks, server answers): a directory under the server's skill roots, mirrored on the node before a plugin is installed;
 * - `image` (node asks, server answers): a picture a turn hands the model by its server path (a screenshot in the input box, a favourite's
 *   picture), copied to the node first;
 * - `gw*`: an HTTP request a provider thread made to the model gateway, relayed to the server's gateway, which adds the key;
 * - `browser` (server asks, node answers with `browser-answer`, a large picture or video first in `browser-chunk`s): one operation of a
 *   reader's browser on the person's computer (browser.ts), offered only by a node whose `hello` says `browser`;
 * - `task` (server asks, node answers with `task-answer`): one operation on the shell assistant's task directories (task-files.ts), offered
 *   only by a node whose `hello` says `shell` (the person's own switch on this computer, off by default).
 *
 * The node does not trust the server blindly: only the methods the runners use pass (`ALLOWED_METHODS`), and a thread may not ask for a
 * shell, full access or a permission profile (`refusal`), nor change them on a turn. The one exception is the person's own: with 「允许在这台
 * 电脑上执行命令」 on, the server's assistant may start a thread with the shell and full access in one of this computer's task directories,
 * under the `untrusted` approval policy, so every command not on the runtime's own short harmless list comes back to the server's guard.
 */
export const NODE_PROTOCOL = 1;

export type NodeFrame =
  | { t: "hello"; protocol: number; codex: string; platform: string; host: string; role?: "device" | "standalone"; capacity?: number; browser?: boolean;
      /** The shell assistant may run here (the person's switch), in task directories under `tasks`; `home` is this computer's user folder (for the guard). */
      shell?: boolean; tasks?: string; home?: string }
  | { t: "welcome"; workspaceId: string; roots: string[]; gateway?: string }
  | { t: "rpc"; line: string }
  | { t: "files"; id: number; dir: string }
  | { t: "files-answer"; id: number; files?: Array<{ rel: string; data: string }>; error?: string }
  | { t: "image"; id: number; path: string }
  | { t: "image-answer"; id: number; data?: string; error?: string }
  | { t: "gw"; id: number; method: string; path: string; headers: Record<string, string>; body?: string }
  | { t: "gw-head"; id: number; status: number; headers: Record<string, string> }
  | { t: "gw-data"; id: number; data: string }
  | { t: "gw-end"; id: number; error?: string }
  | { t: "browser"; id: number; request: Record<string, unknown> }
  | { t: "browser-chunk"; id: number; data: string }
  | { t: "browser-answer"; id: number; result?: unknown; error?: string }
  | { t: "task"; id: number; request: Record<string, unknown> }
  | { t: "task-answer"; id: number; result?: unknown; error?: string };
/** A picture or video goes back in pieces of this size (each frame stays under the socket's limit). */
export const BROWSER_CHUNK_BYTES = 8 * 1_048_576;

export function parseFrame(raw: string): NodeFrame | undefined {
  try {
    const frame = JSON.parse(raw) as { t?: unknown };
    return frame && typeof frame === "object" && typeof frame.t === "string" ? frame as NodeFrame : undefined;
  } catch { return undefined; }
}

/** The most runs one node is given at once, whatever it says (its own default, `nodeCapacity`, stays within it too). */
export const NODE_CAPACITY_MAX = 16;

/** Why the hub closed a connection (the WebSocket close reason), in the words the node shows. */
export const CLOSE_WORDS: Record<string, string> = {
  NODE_TOKEN_INVALID: "令牌无效或已撤销",
  NODE_TOKEN_REVOKED: "令牌已撤销或已换新",
  NODE_SWITCHED_OFF: "网页版已关闭「作为算力节点」",
  NODE_NOT_ALLOWED: "网页版没有开启「作为算力节点」",
  NODE_CODEX_VERSION: "本机 Codex 与服务器版本不同",
  NODE_PROTOCOL: "节点程序版本与网页版不同，请更新",
  NODE_PREPARE_FAILED: "节点准备失败",
  NODE_REPLACED: "同一账号的另一台节点连上了",
  NODE_RUNTIME_EXITED: "本机 Codex 意外退出",
  NODE_SERVER_STARTING: "网页版刚重启，稍后自动重连"
};
/** The site no longer accepts this node's token: a standalone node goes back to pairing. */
export const TOKEN_GONE = new Set(["NODE_TOKEN_INVALID", "NODE_TOKEN_REVOKED"]);

/** What the server's runners send to a runtime (skill-runner.ts, model-catalog.ts, cost.ts, the plugin install); nothing else reaches the node's. */
export const ALLOWED_METHODS = new Set([
  "thread/start", "thread/resume", "thread/loaded/list", "thread/unsubscribe", "thread/compact/start", "turn/start", "turn/interrupt",
  "config/read", "skills/list", "skills/config/write", "plugin/install", "plugin/installed", "plugin/list",
  "model/list", "account/read", "account/rateLimits/read", "app/installed", "app/read", "mcpServer/tool/call"
]);

/** What a turn may not change about its thread: the thread's settings were checked when it started, and stay as they were. */
const TURN_FIXED = ["cwd", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "permissions", "runtimeWorkspaceRoots"];
/** Configuration keys that would set the sandbox or approval policy through the back door. */
const CONFIG_FIXED = ["sandbox_mode", "approval_policy", "sandbox_workspace_write", "approvals_reviewer"];
const bool = (value: unknown) => typeof value === "boolean";
const off = (value: unknown) => value === false;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** A provider defined for one thread, as `threadProvider` writes it: no command, no key, never the node's own OpenAI sign-in. */
const PROVIDER_KEYS: Record<string, (value: unknown) => boolean> = {
  name: (value) => typeof value === "string", base_url: (value) => typeof value === "string", wire_api: (value) => value === "responses" || value === "chat",
  requires_openai_auth: off, supports_websockets: bool, stream_idle_timeout_ms: count, request_max_retries: count, stream_max_retries: count,
  http_headers: (value) => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string")
};
const providerDefinition = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.entries(value).every(([key, item]) => PROVIDER_KEYS[key]?.(item) === true);
/**
 * The configuration keys the server's runners send (skill-runner.ts: `startIsolatedThread`, `startAgentThread`, a provider's thread,
 * `contextWindowConfig`, `onlyOwnPlugins`, connectors, code mode), each with the values they send; any other key is refused (the review of
 * 2026-11-03: a denylist missed `sandbox_workspace_write.*`, `permissions.*`, `mcp_servers.*`, `features.unified_exec`, `shell_environment_policy.*`).
 * What turns a capability on that the node must never give is allowed only off.
 */
const CONFIG_ALLOWED: Array<[RegExp, (value: unknown) => boolean]> = [
  [/^web_search$/, (value) => value === "live" || value === "cached" || value === "disabled"],
  [/^project_doc_max_bytes$/, (value) => value === 0],
  [/^include_environment_context$/, bool],
  [/^memories\.(use_memories|generate_memories)$/, off],
  [/^tools\.(update_plan|experimental_request_user_input)\.enabled$/, bool],
  [/^features\.(shell_tool|multi_agent|multi_agent_v2|apps|web_search|standalone_web_search|image_generation|view_image|tool_suggest|token_budget|current_time_reminder|sleep_tool|send_message_to_user_async|code_mode|deferred_executor|goals|plugins|memories|default_mode_request_user_input)$/, bool],
  [/^features\.(hooks|codex_hooks|plugin_hooks|js_repl|request_permissions_tool)$/, off],
  [/^apps\._default\.default_tools_approval_mode$/, (value) => value === "writes"],
  [/^apps\._default\.destructive_enabled$/, off],
  [/^mcp_servers\.[^.]+\.enabled$/, off],
  [/^plugins\._default\.enabled$/, bool],
  [/^plugins\.[A-Za-z0-9_-]+@[A-Za-z0-9_-]+\.enabled$/, bool],
  [/^model_providers\.[A-Za-z0-9_-]+$/, providerDefinition],
  [/^(model_context_window|model_auto_compact_token_limit)$/, count],
  [/^skills\.include_instructions$/, bool]
];
const configAllowed = (key: string, value: unknown) => CONFIG_ALLOWED.some(([pattern, check]) => pattern.test(key) && check(value));

/** Whether a path names `..` anywhere: refused in every path field, so no resolving can walk out of where it seems to point. */
const climbs = (value: string) => value.split(/[\\/]+/).includes("..");
/** The path fields of a request, at any depth (`cwd`, `cwds`, a marketplace path, workspace roots). */
function pathValues(value: unknown, key = ""): string[] {
  if (typeof value === "string") return PATH_KEYS.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => pathValues(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([name, item]) => pathValues(item, name));
  return [];
}

/** Whether `cwd` is one of this computer's task directories: a direct child of `tasksRoot` with a plain name. */
export function inTaskDir(cwd: unknown, tasksRoot: string): boolean {
  if (typeof cwd !== "string" || !tasksRoot) return false;
  const local = path.isAbsolute(tasksRoot) ? path : path.posix;
  const resolved = local.resolve(cwd);
  return local.dirname(resolved) === local.resolve(tasksRoot) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(local.basename(resolved)) && !local.basename(resolved).includes("..");
}

/**
 * Why the node refuses a request, or undefined when it may run. `shell` is given only when the person switched the shell on here: then
 * (and only then) a thread may have the shell and full access, in a task directory, with the `untrusted` approval policy answered by the user.
 */
export function refusal(method: string, params: unknown, shell?: { tasksRoot: string }): string | undefined {
  if (!ALLOWED_METHODS.has(method)) return `NODE_METHOD_REFUSED: ${method}`;
  if (pathValues(params).some(climbs)) return "NODE_PATH_REFUSED: ..";
  const value = (params ?? {}) as { sandbox?: unknown; config?: Record<string, unknown>; cwd?: unknown; approvalPolicy?: unknown; approvalsReviewer?: unknown;
    environments?: unknown } & Record<string, unknown>;
  if (method === "turn/start") {
    if (TURN_FIXED.some((key) => value[key] !== undefined)) return "NODE_TURN_REFUSED: settings";
    if (value.environments !== undefined && !(Array.isArray(value.environments) && value.environments.length === 0)) return "NODE_TURN_REFUSED: environments";
    return undefined;
  }
  if (method !== "thread/start" && method !== "thread/resume") return undefined;
  const config = value.config ?? {};
  const features = (config.features ?? {}) as Record<string, unknown>;
  if (CONFIG_FIXED.some((key) => config[key] !== undefined)) return "NODE_SHELL_REFUSED: config";
  if (value.sandbox === "workspace-write" || config.default_permissions !== undefined || config.permissions !== undefined) return "NODE_SHELL_REFUSED: sandbox";
  const unknown = Object.entries(config).find(([key, item]) => !configAllowed(key, item));
  if (unknown) return `NODE_CONFIG_REFUSED: ${unknown[0]}`;
  const wantsShell = value.sandbox === "danger-full-access" || config["features.shell_tool"] === true || features.shell_tool === true;
  if (!wantsShell) return undefined;
  if (!shell) return "NODE_SHELL_REFUSED: shell";
  if (value.approvalPolicy !== "untrusted" || (value.approvalsReviewer !== undefined && value.approvalsReviewer !== "user")) return "NODE_SHELL_REFUSED: approval";
  if (!inTaskDir(value.cwd, shell.tasksRoot)) return "NODE_SHELL_REFUSED: cwd";
  return undefined;
}

/** Pictures a turn may hand the model, by extension; nothing else is served as an image. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
export const IMAGE_MAX_BYTES = 20 * 1_048_576;

/** The server paths of the pictures a `turn/start` hands the model (`localImage` input items). */
export function turnImages(params: unknown): string[] {
  const input = (params as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) ? input.flatMap((item) => {
    const value = item as { type?: unknown; path?: unknown };
    return value?.type === "localImage" && typeof value.path === "string" && value.path.startsWith("/") ? [value.path] : [];
  }) : [];
}

/** The same turn with each picture's server path replaced by the node's copy. */
export function withLocalImages(params: unknown, copies: Map<string, string>): unknown {
  const value = params as { input?: unknown[] };
  if (!Array.isArray(value?.input)) return params;
  return { ...value, input: value.input.map((item) => {
    const entry = item as { type?: unknown; path?: unknown };
    return entry?.type === "localImage" && typeof entry.path === "string" && copies.has(entry.path) ? { ...entry, path: copies.get(entry.path) } : item;
  }) };
}

/** The server's directory a plugin's marketplace file sits in: `<dir>/.agents/plugins/marketplace.json`. */
export function marketplaceRoot(marketplacePath: string): string {
  return path.posix.dirname(path.posix.dirname(path.posix.dirname(marketplacePath)));
}

/** Whether a server path lies under one of the server's skill roots (POSIX paths: the hosted worker runs on Linux). */
export function underRoots(serverPath: string, roots: string[]): boolean {
  if (!serverPath.startsWith("/") || serverPath.split("/").includes("..")) return false;
  return roots.some((root) => serverPath === root || serverPath.startsWith(`${root.replace(/\/$/, "")}/`));
}

/**
 * The node's path for a server path: the same path under the mirror directory. Paths outside the roots (a run's `cwd`, which on the server
 * is the repository) go to the node's own work directory, which exists and holds nothing.
 */
export function nodePath(serverPath: string, roots: string[], mirror: string, work: string): string {
  if (underRoots(serverPath, roots)) return path.join(mirror, ...serverPath.split("/").filter(Boolean));
  return work;
}

/** The fields that hold a path on the runtime's machine; nothing else is touched (a prompt that quotes a server path stays as it is). */
const PATH_KEYS = new Set(["cwd", "cwds", "marketplacePath", "runtimeWorkspaceRoots"]);

/**
 * A request as the node's runtime gets it: server paths mapped (`cwd`, `cwds`, a marketplace path, workspace roots), and a provider's
 * `base_url` pointed at the node's relay instead of the server's loopback gateway.
 */
export function rewriteParams(params: unknown, map: { roots: string[]; mirror: string; work: string; gateway?: string; relay?: string; keep?: string }): unknown {
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === "string") {
      if (key === "base_url" && map.gateway && map.relay && value.startsWith(map.gateway)) return map.relay + value.slice(map.gateway.length);
      // A path already on this computer (a shell run's task directory, checked by `refusal`) stays as it is — judged on the resolved path,
      // the way `refusal` judged it, and never with `..` in it.
      if (map.keep && PATH_KEYS.has(key) && !climbs(value) && path.isAbsolute(value)) {
        const resolved = path.resolve(value);
        const root = path.resolve(map.keep);
        if (resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return resolved;
      }
      // Any other absolute path (a server path, or one naming this computer's own folders) goes to the mirror or the empty work directory.
      return PATH_KEYS.has(key) && (value.startsWith("/") || path.isAbsolute(value)) ? nodePath(value, map.roots, map.mirror, map.work) : value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    return value;
  };
  return walk(params, "");
}

/** The Codex version in `initialize`'s `userAgent` ("crossline/0.163.0 (…)" → "0.163.0"); the node and the server must agree on it. */
export function codexVersionOf(initializeResult: unknown): string {
  const agent = (initializeResult as { userAgent?: unknown } | undefined)?.userAgent;
  return typeof agent === "string" ? /\/(\d+\.\d+\.\d+)/.exec(agent)?.[1] ?? agent : "";
}
