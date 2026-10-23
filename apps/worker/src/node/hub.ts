import { createServer, type IncomingMessage, type Server } from "node:http";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { JsonLineRpcClient, type CodexRpcBoundary } from "@crossline/codex";
import { codexVersionOf, IMAGE_FILE, IMAGE_MAX_BYTES, NODE_PROTOCOL, parseFrame, underRoots, type NodeFrame } from "./protocol";

/**
 * The hosted worker's end of the compute node (docs/compute-node.md): the person's computer connects out to `wss://<site>/node` (Caddy
 * hands it to this port on loopback) with its device token, and while it is connected and ready the owner's model runs take its Codex
 * runtime (`clientFor`) instead of this server's. Nothing here starts on its own: a node is accepted only for a workspace whose owner
 * switched it on (`allowed`), and with no node connected every run stays on the server exactly as before.
 *
 * What the node asks of the server is held to the server's skill roots (`files`: a plugin's directory to mirror before installing it) and
 * to its model gateway (`gw`: a provider thread's request, given the key here). The runtime's lines pass through unchanged.
 */
export type NodeStatus = { state: "connected" | "ready" | "refused" | "offline"; host?: string; codex?: string; at: string; message?: string };

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
};

export type NodeHub = {
  /** The node's runtime for this workspace while it is connected and prepared; undefined otherwise. */
  clientFor: (workspaceId: string) => CodexRpcBoundary | undefined;
  status: (workspaceId: string) => NodeStatus | undefined;
  port: number;
  close: () => Promise<void>;
};

/** A node may mirror no more than this of one directory. */
export const MIRROR_MAX_FILES = 800;
export const MIRROR_MAX_BYTES = 40 * 1_048_576;

type Connection = { socket: WebSocket; workspaceId: string; client?: JsonLineRpcClient; ready: boolean; alive: boolean; host: string; codex: string };

export async function createNodeHub(options: NodeHubOptions): Promise<NodeHub> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetch ?? fetch;
  const readTree = options.readTree ?? readDirectory;
  const connections = new Map<string, Connection>();
  const statuses = new Map<string, NodeStatus>();
  const setStatus = (workspaceId: string, status: Omit<NodeStatus, "at">) => {
    const full = { ...status, at: now().toISOString() };
    statuses.set(workspaceId, full);
    try { options.onStatus?.(workspaceId, full); } catch { /* the record is a courtesy */ }
  };
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
      setStatus(workspaceId, { state: "refused", message: "网页版没有开启「作为算力节点」" });
      reject(403, "Forbidden");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, workspaceId));
  });

  function accept(socket: WebSocket, workspaceId: string): void {
    const connection: Connection = { socket, workspaceId, ready: false, alive: true, host: "", codex: "" };
    const hello = setTimeout(() => socket.close(4001, "NODE_HELLO_MISSING"), 15_000);
    const pendingGw = new Map<number, AbortController>();
    socket.on("pong", () => { connection.alive = true; });
    socket.on("message", (raw) => {
      const frame = parseFrame(raw.toString());
      if (!frame) return;
      if (frame.t === "hello") { clearTimeout(hello); void greet(connection, frame); return; }
      if (connections.get(workspaceId) !== connection) return;
      if (frame.t === "rpc") {
        try { connection.client?.receiveLine(frame.line); } catch (error) { log({ type: "node.bad_line", workspaceId, message: error instanceof Error ? error.message : "" }); }
        return;
      }
      if (frame.t === "files") { answerFiles(socket, workspaceId, frame.id, frame.dir); return; }
      if (frame.t === "image") { answerImage(socket, workspaceId, frame.id, frame.path); return; }
      if (frame.t === "gw") { void relay(socket, frame, pendingGw); return; }
    });
    socket.on("close", (code, reason) => {
      clearTimeout(hello);
      for (const controller of pendingGw.values()) controller.abort();
      if (connections.get(workspaceId) !== connection) return;
      connections.delete(workspaceId);
      connection.client?.disconnect(new Error("CROSSLINE_NODE_DISCONNECTED"));
      setStatus(workspaceId, { state: "offline", host: connection.host, codex: connection.codex, message: reason.toString() || String(code) });
      log({ type: "node.disconnected", workspaceId, code, reason: reason.toString() });
    });
    socket.on("error", () => { /* the close that follows says it */ });
  }

  async function greet(connection: Connection, hello: Extract<NodeFrame, { t: "hello" }>): Promise<void> {
    const { socket, workspaceId } = connection;
    connection.host = String(hello.host ?? "").slice(0, 60);
    connection.codex = codexVersionOf({ userAgent: hello.codex });
    const server = codexVersionOf({ userAgent: options.serverCodex() });
    if (hello.protocol !== NODE_PROTOCOL) { refuse(connection, 4002, "NODE_PROTOCOL", `节点程序的版本（${hello.protocol}）与网页版（${NODE_PROTOCOL}）不同，请更新本机 Crossline`); return; }
    if (!connection.codex || connection.codex !== server) {
      refuse(connection, 4009, "NODE_CODEX_VERSION", `本机 Codex ${connection.codex || "未知"} 与服务器 ${server || "未知"} 不同，节点暂不接活`);
      return;
    }
    // One node per workspace: a new connection replaces the old one (the computer reconnected after sleep).
    const previous = connections.get(workspaceId);
    connections.set(workspaceId, connection);
    if (previous) previous.socket.close(4000, "NODE_REPLACED");
    send(socket, { t: "welcome", workspaceId, roots: options.roots(workspaceId), ...(options.gateway() ? { gateway: options.gateway()! } : {}) });
    connection.client = new JsonLineRpcClient((line) => send(socket, { t: "rpc", line: line.replace(/\n$/, "") }));
    setStatus(workspaceId, { state: "connected", host: connection.host, codex: connection.codex });
    log({ type: "node.connected", workspaceId, host: connection.host, codex: connection.codex });
    try {
      await options.prepare(connection.client, workspaceId);
      if (connections.get(workspaceId) !== connection) return;
      connection.ready = true;
      setStatus(workspaceId, { state: "ready", host: connection.host, codex: connection.codex });
      log({ type: "node.ready", workspaceId, host: connection.host });
    } catch (error) {
      refuse(connection, 4010, "NODE_PREPARE_FAILED", `节点准备失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`);
    }
  }

  function refuse(connection: Connection, code: number, reason: string, message: string): void {
    setStatus(connection.workspaceId, { state: "refused", host: connection.host, codex: connection.codex, message });
    log({ type: "node.refused", workspaceId: connection.workspaceId, reason, message });
    if (connections.get(connection.workspaceId) === connection) {
      connections.delete(connection.workspaceId);
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
  // account switched it off is let go at the next beat.
  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (!options.allowed(connection.workspaceId)) { refuse(connection, 4003, "NODE_SWITCHED_OFF", "网页版已关闭「作为算力节点」"); continue; }
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false;
      try { connection.socket.ping(); } catch { /* terminated next round */ }
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();

  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    clientFor: (workspaceId) => { const connection = connections.get(workspaceId); return connection?.ready ? connection.client : undefined; },
    status: (workspaceId) => statuses.get(workspaceId),
    close: async () => {
      clearInterval(heartbeat);
      for (const connection of connections.values()) connection.socket.close(1001, "NODE_HUB_CLOSING");
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
