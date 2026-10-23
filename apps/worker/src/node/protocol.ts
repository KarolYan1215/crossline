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
 * - `gw*`: an HTTP request a provider thread made to the model gateway, relayed to the server's gateway, which adds the key.
 *
 * The node does not trust the server blindly: only the methods the runners use pass (`ALLOWED_METHODS`), and a thread may not ask for a
 * shell, full access or a permission profile (`refusal`). The hosted worker's own shell assistant never comes here; it uses the server's
 * runtime directly.
 */
export const NODE_PROTOCOL = 1;

export type NodeFrame =
  | { t: "hello"; protocol: number; codex: string; platform: string; host: string; role?: "device" | "standalone"; capacity?: number }
  | { t: "welcome"; workspaceId: string; roots: string[]; gateway?: string }
  | { t: "rpc"; line: string }
  | { t: "files"; id: number; dir: string }
  | { t: "files-answer"; id: number; files?: Array<{ rel: string; data: string }>; error?: string }
  | { t: "image"; id: number; path: string }
  | { t: "image-answer"; id: number; data?: string; error?: string }
  | { t: "gw"; id: number; method: string; path: string; headers: Record<string, string>; body?: string }
  | { t: "gw-head"; id: number; status: number; headers: Record<string, string> }
  | { t: "gw-data"; id: number; data: string }
  | { t: "gw-end"; id: number; error?: string };

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
  NODE_RUNTIME_EXITED: "本机 Codex 意外退出"
};
/** The site no longer accepts this node's token: a standalone node goes back to pairing. */
export const TOKEN_GONE = new Set(["NODE_TOKEN_INVALID", "NODE_TOKEN_REVOKED"]);

/** What the server's runners send to a runtime (skill-runner.ts, model-catalog.ts, cost.ts, the plugin install); nothing else reaches the node's. */
export const ALLOWED_METHODS = new Set([
  "thread/start", "thread/resume", "thread/loaded/list", "thread/unsubscribe", "thread/compact/start", "turn/start", "turn/interrupt",
  "config/read", "skills/list", "skills/config/write", "plugin/install", "plugin/installed", "plugin/list",
  "model/list", "account/read", "account/rateLimits/read", "app/installed", "app/read", "mcpServer/tool/call"
]);

/** Why the node refuses a request, or undefined when it may run. */
export function refusal(method: string, params: unknown): string | undefined {
  if (!ALLOWED_METHODS.has(method)) return `NODE_METHOD_REFUSED: ${method}`;
  if (method !== "thread/start" && method !== "thread/resume") return undefined;
  const value = (params ?? {}) as { sandbox?: unknown; config?: Record<string, unknown> };
  if (value.sandbox === "danger-full-access" || value.sandbox === "workspace-write") return "NODE_SHELL_REFUSED: sandbox";
  const config = value.config ?? {};
  if (config["features.shell_tool"] === true || config.default_permissions !== undefined || config.permissions !== undefined) return "NODE_SHELL_REFUSED: shell";
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
export function rewriteParams(params: unknown, map: { roots: string[]; mirror: string; work: string; gateway?: string; relay?: string }): unknown {
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === "string") {
      if (key === "base_url" && map.gateway && map.relay && value.startsWith(map.gateway)) return map.relay + value.slice(map.gateway.length);
      return PATH_KEYS.has(key) && value.startsWith("/") ? nodePath(value, map.roots, map.mirror, map.work) : value;
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
