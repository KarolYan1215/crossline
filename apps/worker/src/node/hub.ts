import { createServer, type IncomingMessage, type Server } from "node:http";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { JsonLineRpcClient, type CodexRpcBoundary, type PoolMember } from "@crossline/codex";
import { codexVersionOf, IMAGE_FILE, IMAGE_MAX_BYTES, NODE_CAPACITY_MAX, NODE_PROTOCOL, parseFrame, underRoots, type NodeFrame } from "./protocol";

/**
 * The hosted worker's end of the compute node (docs/compute-node.md): the person's computers connect out to `wss://<site>/node` (Caddy
 * hands it to this port on loopback) with a device or node token, and while they are connected and ready the owner's model runs are
 * spread over them and this server's own runtime (`members`, runtime-pool.ts). Nothing here starts on its own: a node is accepted only for
 * a workspace whose owner switched it on (`allowed`), and with no node connected every run stays on the server exactly as before.
 *
 * Several nodes of one account work at once: a linked device and the standalone node, or two computers. Each is known by its kind and host
 * (`key`); the same computer reconnecting (after sleep) replaces its own earlier connection, never another's. A linked device ranks above
 * the standalone node (the owner: the device-mode computer is the stronger one); each says how many runs it takes at once (`capacity`).
 *
 * What a node asks of the server is held to the server's skill roots (`files`: a plugin's directory to mirror before installing it), its
 * image roots (`image`) and its model gateway (`gw`: a provider thread's request, given the key here). The runtime's lines pass through
 * unchanged.
 */
export type NodeRole = "device" | "standalone";
export type NodeEntry = { key: string; host: string; role: NodeRole; codex: string; capacity: number; state: "connected" | "ready" | "refused" | "offline";
  at: string; message?: string };
/** The account's nodes as the card shows them: the best state among them, the strongest ready one's host and Codex, and each node. */
export type NodeStatus = { state: "connected" | "ready" | "refused" | "offline"; host?: string; codex?: string; at: string; message?: string; nodes?: NodeEntry[] };

export type NodeHubOptions = {
  port: number;
  host?: string;
  /** The workspace a device token belongs to, if any. */
  authenticate: (token: string) => string | undefined;
  /** Whether this workspace may connect a node now (the runtime owner, switched on). */
  allowed: (workspaceId: string) => boolean;
  /** The server's directories a node may mirror for this workspace (the Crossline marketplace, the workspace's skill library). */
  roots: (workspaceId: string) => string[];
  /** Where the pictures a turn hands the model live on the server (the input box's typed copies, the data directory). */
  imageRoots?: (workspaceId: string) => string[];
  /** The server's model gateway origin (`http://127.0.0.1:<port>`), which a provider thread's `base_url` starts with. */
  gateway: () => string | undefined;
  /** The server runtime's Codex version: a node must run the same one. */
  serverCodex: () => string;
  /** Run once a node is connected, before any run is given to it (installs the Crossline plugin through the node's runtime). */
  prepare: (client: CodexRpcBoundary, workspaceId: string) => Promise<void>;
  onStatus?: (workspaceId: string, status: NodeStatus) => void;
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
  /** Reading a directory to send (tests replace it). */
  readTree?: (dir: string) => Array<{ rel: string; data: Buffer }>;
  readFile?: (file: string) => Buffer;
  fetch?: typeof fetch;
  heartbeatMs?: number;
  /** A node silent this long (no pong) is let go; longer than one beat, so a pong late under load never drops a working node. */
  deadAfterMs?: number;
};

/** A reader's browser on one of the account's computers: the operations of browser.ts, answered over its connection. */
export type NodeBrowserLink = { host: string; call: (request: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> };

export type NodeHub = {
  /** A ready node of the account that runs a reader's browser (strongest kind first), or undefined. */
  browserFor: (workspaceId: string) => NodeBrowserLink | undefined;
  /** The account's ready nodes as runtime-pool members: strongest kind first. */
  members: (workspaceId: string) => PoolMember[];
  /** How many runs the account's ready nodes take at once, together (the model gate adds them to the account's share). */
  capacity: (workspaceId: string) => number;
  /** The strongest ready node's runtime, or undefined. */
  clientFor: (workspaceId: string) => CodexRpcBoundary | undefined;
  status: (workspaceId: string) => NodeStatus | undefined;
  port: number;
  close: () => Promise<void>;
};

/** A node may mirror no more than this of one directory. */
export const MIRROR_MAX_FILES = 800;
export const MIRROR_MAX_BYTES = 40 * 1_048_576;
/** A node's rank by kind (its most runs at once is `NODE_CAPACITY_MAX`, protocol.ts). */
export const ROLE_PRIORITY: Record<NodeRole, number> = { device: 2, standalone: 1 };
/** Offline and refused nodes stay on the card this long, then leave it. */
const GONE_SHOWN_MS = 24 * 3_600_000;

type Connection = { socket: WebSocket; workspaceId: string; token: string; client?: JsonLineRpcClient; ready: boolean; heardAt: number;
  host: string; codex: string; role: NodeRole; capacity: number; key: string; browser: boolean;
  browsing: Map<number, { chunks: Buffer[]; resolve: (value: unknown) => void; reject: (error: Error) => void }> };
let browserIds = 0;

export async function createNodeHub(options: NodeHubOptions): Promise<NodeHub> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetch ?? fetch;
  const readTree = options.readTree ?? readDirectory;
  /** Per workspace, the live connections by key. */
  const connections = new Map<string, Map<string, Connection>>();
  /** Per workspace, what each node (by key) last did. */
  const entries = new Map<string, Map<string, NodeEntry>>();
  const statuses = new Map<string, NodeStatus>();
  const groupOf = (workspaceId: string) => { let group = connections.get(workspaceId); if (!group) { group = new Map(); connections.set(workspaceId, group); } return group; };
  const isCurrent = (connection: Connection) => connections.get(connection.workspaceId)?.get(connection.key) === connection;
  const all = () => [...connections.values()].flatMap((group) => [...group.values()]);
  const ready = (workspaceId: string) => [...(connections.get(workspaceId)?.values() ?? [])].filter((connection) => connection.ready && connection.client)
    .sort((a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role] || b.capacity - a.capacity);

  /** One node's new state, and the account's status built again from all of them. */
  const setStatus = (workspaceId: string, entry: Omit<NodeEntry, "at">) => {
    const at = now().toISOString();
    const nodes = entries.get(workspaceId) ?? new Map<string, NodeEntry>();
    entries.set(workspaceId, nodes);
    nodes.set(entry.key, { ...entry, at });
    // A refusal at the door (switched off) is no node of its own: it leaves the card once a node is in.
    if (entry.key !== "?" && (entry.state === "connected" || entry.state === "ready")) nodes.delete("?");
    for (const [key, node] of nodes) if (node.state !== "ready" && node.state !== "connected" && now().getTime() - Date.parse(node.at) > GONE_SHOWN_MS) nodes.delete(key);
    const list = [...nodes.values()].sort((a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role] || b.at.localeCompare(a.at));
    const best = list.find((node) => node.state === "ready") ?? list.find((node) => node.state === "connected");
    const latest = entry.state === "ready" || entry.state === "connected" ? undefined : { ...entry, at };
    const shown = best ?? latest ?? list[0]!;
    const status: NodeStatus = { state: shown.state, at, ...(shown.host ? { host: shown.host } : {}), ...(shown.codex ? { codex: shown.codex } : {}),
      ...(shown.message ? { message: shown.message } : {}), nodes: list };
    statuses.set(workspaceId, status);
    try { options.onStatus?.(workspaceId, status); } catch { /* the record is a courtesy */ }
  };
  const entryOf = (connection: Connection, state: NodeEntry["state"], message?: string): Omit<NodeEntry, "at"> => ({ key: connection.key, host: connection.host,
    role: connection.role, codex: connection.codex, capacity: connection.capacity, state, ...(message ? { message } : {}) });
  const send = (socket: WebSocket, frame: NodeFrame) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame)); };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1_048_576 });
  const server: Server = createServer((_request, response) => { response.writeHead(404).end(); });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number, text: string) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (new URL(request.url ?? "/", "http://node").pathname !== "/node") { reject(404, "Not Found"); return; }
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    const workspaceId = token ? options.authenticate(token) : undefined;
    if (!workspaceId) { reject(401, "Unauthorized"); return; }
    if (!options.allowed(workspaceId)) {
      setStatus(workspaceId, { key: "?", host: "", role: "device", codex: "", capacity: 0, state: "refused", message: "网页版没有开启「作为算力节点」" });
      reject(403, "Forbidden");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, workspaceId, token!));
  });

  function accept(socket: WebSocket, workspaceId: string, token: string): void {
    const connection: Connection = { socket, workspaceId, token, ready: false, heardAt: Date.now(), host: "", codex: "", role: "device", capacity: 2, key: "",
      browser: false, browsing: new Map() };
    const hello = setTimeout(() => socket.close(4001, "NODE_HELLO_MISSING"), 15_000);
    const pendingGw = new Map<number, AbortController>();
    socket.on("pong", () => { connection.heardAt = Date.now(); });
    socket.on("message", (raw) => {
      const frame = parseFrame(raw.toString());
      if (!frame) return;
      if (frame.t === "hello") { clearTimeout(hello); void greet(connection, frame); return; }
      if (!isCurrent(connection)) return;
      if (frame.t === "rpc") {
        try { connection.client?.receiveLine(frame.line); } catch (error) { log({ type: "node.bad_line", workspaceId, message: error instanceof Error ? error.message : "" }); }
        return;
      }
      if (frame.t === "files") { answerFiles(socket, workspaceId, frame.id, frame.dir); return; }
      if (frame.t === "image") { answerImage(socket, workspaceId, frame.id, frame.path); return; }
      if (frame.t === "gw") { void relay(socket, frame, pendingGw); return; }
      if (frame.t === "browser-chunk") { connection.browsing.get(frame.id)?.chunks.push(Buffer.from(frame.data, "base64")); return; }
      if (frame.t === "browser-answer") {
        const pending = connection.browsing.get(frame.id);
        connection.browsing.delete(frame.id);
        if (!pending) return;
        if (frame.error) { pending.reject(new Error(frame.error)); return; }
        const result = frame.result as { chunked?: boolean; contentType?: string } | null;
        pending.resolve(result && result.chunked ? { state: "ok", contentType: result.contentType ?? "", bytes: Buffer.concat(pending.chunks) } : result);
        return;
      }
    });
    socket.on("close", (code, reason) => {
      clearTimeout(hello);
      for (const controller of pendingGw.values()) controller.abort();
      for (const pending of connection.browsing.values()) pending.reject(new Error("NODE_DISCONNECTED"));
      connection.browsing.clear();
      if (!isCurrent(connection)) return;
      connections.get(workspaceId)?.delete(connection.key);
      connection.client?.disconnect(new Error("CROSSLINE_NODE_DISCONNECTED"));
      setStatus(workspaceId, entryOf(connection, "offline", reason.toString() || String(code)));
      log({ type: "node.disconnected", workspaceId, host: connection.host, role: connection.role, code, reason: reason.toString() });
    });
    socket.on("error", () => { /* the close that follows says it */ });
  }

  async function greet(connection: Connection, hello: Extract<NodeFrame, { t: "hello" }>): Promise<void> {
    const { socket, workspaceId } = connection;
    connection.host = String(hello.host ?? "").slice(0, 60);
    connection.codex = codexVersionOf({ userAgent: hello.codex });
    connection.role = hello.role === "standalone" ? "standalone" : "device";
    connection.capacity = Math.max(1, Math.min(NODE_CAPACITY_MAX, Math.floor(Number(hello.capacity) || 4)));
    connection.key = `${connection.role}:${connection.host}`;
    connection.browser = hello.browser === true;
    const server = codexVersionOf({ userAgent: options.serverCodex() });
    // The server's own runtime is not up yet (the worker just restarted and a node was quicker): come back in a moment, not in ten minutes.
    if (!server) { log({ type: "node.server_starting", workspaceId, host: connection.host }); socket.close(4006, "NODE_SERVER_STARTING"); return; }
    if (hello.protocol !== NODE_PROTOCOL) { refuse(connection, 4002, "NODE_PROTOCOL", `节点程序的版本（${hello.protocol}）与网页版（${NODE_PROTOCOL}）不同，请更新本机 Crossline`); return; }
    if (!connection.codex || connection.codex !== server) {
      refuse(connection, 4009, "NODE_CODEX_VERSION", `本机 Codex ${connection.codex || "未知"} 与服务器 ${server || "未知"} 不同，节点暂不接活`);
      return;
    }
    // The same computer coming back (after sleep, a restart) takes the place of its own earlier connection; other nodes are left alone.
    const group = groupOf(workspaceId);
    const previous = group.get(connection.key);
    group.set(connection.key, connection);
    if (previous) previous.socket.close(4000, "NODE_REPLACED");
    send(socket, { t: "welcome", workspaceId, roots: options.roots(workspaceId), ...(options.gateway() ? { gateway: options.gateway()! } : {}) });
    connection.client = new JsonLineRpcClient((line) => send(socket, { t: "rpc", line: line.replace(/\n$/, "") }));
    setStatus(workspaceId, entryOf(connection, "connected"));
    log({ type: "node.connected", workspaceId, host: connection.host, role: connection.role, capacity: connection.capacity, codex: connection.codex });
    try {
      await options.prepare(connection.client, workspaceId);
      if (!isCurrent(connection)) return;
      connection.ready = true;
      setStatus(workspaceId, entryOf(connection, "ready"));
      log({ type: "node.ready", workspaceId, host: connection.host, role: connection.role });
    } catch (error) {
      // A preparation cut short by the connection closing is that close, already recorded as offline; only a live one was refused.
      if (!isCurrent(connection)) return;
      refuse(connection, 4010, "NODE_PREPARE_FAILED", `节点准备失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`);
    }
  }

  function refuse(connection: Connection, code: number, reason: string, message: string): void {
    setStatus(connection.workspaceId, entryOf(connection, "refused", message));
    log({ type: "node.refused", workspaceId: connection.workspaceId, host: connection.host, reason, message });
    if (isCurrent(connection)) {
      connections.get(connection.workspaceId)?.delete(connection.key);
      connection.client?.disconnect(new Error("CROSSLINE_NODE_DISCONNECTED"));
    }
    connection.socket.close(code, reason);
  }

  function answerFiles(socket: WebSocket, workspaceId: string, id: number, dir: string): void {
    if (typeof dir !== "string" || !underRoots(dir, options.roots(workspaceId))) { send(socket, { t: "files-answer", id, error: "NODE_PATH_REFUSED" }); return; }
    try {
      const files = readTree(dir);
      if (files.length > MIRROR_MAX_FILES || files.reduce((sum, file) => sum + file.data.length, 0) > MIRROR_MAX_BYTES) {
        send(socket, { t: "files-answer", id, error: "NODE_MIRROR_TOO_LARGE" });
        return;
      }
      send(socket, { t: "files-answer", id, files: files.map((file) => ({ rel: file.rel, data: file.data.toString("base64") })) });
    } catch { send(socket, { t: "files-answer", id, error: "NODE_MIRROR_UNREADABLE" }); }
  }

  function answerImage(socket: WebSocket, workspaceId: string, id: number, file: string): void {
    if (typeof file !== "string" || !IMAGE_FILE.test(file) || !underRoots(file, options.imageRoots?.(workspaceId) ?? [])) {
      send(socket, { t: "image-answer", id, error: "NODE_PATH_REFUSED" });
      return;
    }
    try {
      const data = (options.readFile ?? readFileSync)(file);
      send(socket, data.length > IMAGE_MAX_BYTES ? { t: "image-answer", id, error: "NODE_IMAGE_TOO_LARGE" } : { t: "image-answer", id, data: data.toString("base64") });
    } catch { send(socket, { t: "image-answer", id, error: "NODE_IMAGE_UNREADABLE" }); }
  }

  /** A provider thread's request from the node, to this server's gateway (which adds the key); the answer streamed back. */
  async function relay(socket: WebSocket, frame: Extract<NodeFrame, { t: "gw" }>, pending: Map<number, AbortController>): Promise<void> {
    const gateway = options.gateway();
    if (!gateway || typeof frame.path !== "string" || !frame.path.startsWith("/") || frame.path.startsWith("//")) {
      send(socket, { t: "gw-end", id: frame.id, error: "NODE_GATEWAY_UNAVAILABLE" });
      return;
    }
    const controller = new AbortController();
    pending.set(frame.id, controller);
    try {
      const headers = Object.fromEntries(Object.entries(frame.headers ?? {}).filter(([name]) => !/^(host|content-length|connection|transfer-encoding)$/i.test(name)));
      const response = await fetchImpl(gateway + frame.path, { method: frame.method, headers, signal: controller.signal,
        ...(frame.body ? { body: Buffer.from(frame.body, "base64") } : {}) });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => { if (!/^(content-length|connection|transfer-encoding|content-encoding)$/i.test(name)) responseHeaders[name] = value; });
      send(socket, { t: "gw-head", id: frame.id, status: response.status, headers: responseHeaders });
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) send(socket, { t: "gw-data", id: frame.id, data: Buffer.from(chunk).toString("base64") });
      send(socket, { t: "gw-end", id: frame.id });
    } catch (error) {
      send(socket, { t: "gw-end", id: frame.id, error: error instanceof Error ? error.message.slice(0, 200) : "NODE_GATEWAY_FAILED" });
    } finally { pending.delete(frame.id); }
  }

  // A node that stops answering pings (a laptop asleep, a dropped network) is let go, so its runs fail over instead of hanging; one whose
  // account switched it off, or whose token was revoked or replaced (解除配对), is let go at the next beat.
  const heartbeat = setInterval(() => {
    for (const connection of all()) {
      if (options.authenticate(connection.token) !== connection.workspaceId) { refuse(connection, 4004, "NODE_TOKEN_REVOKED", "令牌已撤销或已换新"); continue; }
      if (!options.allowed(connection.workspaceId)) { refuse(connection, 4003, "NODE_SWITCHED_OFF", "网页版已关闭「作为算力节点」"); continue; }
      if (Date.now() - connection.heardAt > (options.deadAfterMs ?? 45_000)) { connection.socket.terminate(); continue; }
      try { connection.socket.ping(); } catch { /* terminated next round */ }
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();

  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    browserFor: (workspaceId) => {
      const connection = ready(workspaceId).find((item) => item.browser);
      if (!connection) return undefined;
      return { host: connection.host, call: (request, timeoutMs = 10 * 60_000) => new Promise<unknown>((resolve, reject) => {
        const id = ++browserIds;
        const timer = setTimeout(() => { connection.browsing.delete(id); reject(new Error("NODE_BROWSER_TIMEOUT")); }, timeoutMs);
        connection.browsing.set(id, { chunks: [], resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        send(connection.socket, { t: "browser", id, request });
      }) };
    },
    members: (workspaceId) => ready(workspaceId).map((connection) => ({ id: connection.key, client: connection.client!, capacity: connection.capacity,
      priority: ROLE_PRIORITY[connection.role] })),
    capacity: (workspaceId) => ready(workspaceId).reduce((sum, connection) => sum + connection.capacity, 0),
    clientFor: (workspaceId) => ready(workspaceId)[0]?.client,
    status: (workspaceId) => statuses.get(workspaceId),
    close: async () => {
      clearInterval(heartbeat);
      for (const connection of all()) connection.socket.close(1001, "NODE_HUB_CLOSING");
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** Every regular file under a directory, with its path relative to it (forward slashes); links are not followed. */
export function readDirectory(dir: string): Array<{ rel: string; data: Buffer }> {
  const out: Array<{ rel: string; data: Buffer }> = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !lstatSync(full).isSymbolicLink()) {
        out.push({ rel: path.relative(dir, full).split(path.sep).join("/"), data: readFileSync(full) });
        if (out.length > MIRROR_MAX_FILES) return;
      }
    }
  };
  walk(dir);
  return out;
}
