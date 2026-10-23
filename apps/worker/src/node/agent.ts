import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { CLOSE_WORDS, NODE_CAPACITY_MAX, marketplaceRoot, nodePath, NODE_PROTOCOL, parseFrame, refusal, rewriteParams, turnImages, underRoots, withLocalImages, type NodeFrame } from "./protocol";

/**
 * The computer's end of the compute node (docs/compute-node.md). On the person's switch (the local `/device` page) a linked device also
 * offers its own Codex runtime to the hosted site: it connects out to `wss://<site>/node` with the device token, starts `codex app-server`
 * for each connection, and relays the runtime's JSON-RPC lines to and from the hosted worker. It plans nothing and starts no run itself;
 * every request comes from the hosted worker, which spends the account's quota exactly as it would on its own runtime.
 *
 * What it does not take on trust: methods outside the runners' set and any shell or full access are refused (`refusal`), server paths are
 * mapped into this computer's mirror and work directories (`rewriteParams`), and a plugin's files are fetched from the server's skill roots
 * only, before it is installed.
 */
/** `codex app-server` as raw JSON lines: the linked device's (`local-runtime.ts`) or the standalone node's own (`standalone.ts`). */
export type AppServerLines = { write: (line: string) => void; onLine: (handler: (line: string) => void) => void; onExit: (handler: () => void) => void; stop: () => void };

export type NodeAgentStatus = { state: "off" | "connecting" | "ready" | "waiting" | "refused"; code?: string; message?: string; since: string; runs?: number };

export type NodeAgentOptions = {
  /** The hosted site's origin (`https://app.crossline.lol`). */
  url: string;
  token: string;
  /** Where the mirror of the server's skill directories and the runs' working directory live. */
  dir: string;
  spawn: () => AppServerLines;
  log?: (event: Record<string, unknown>) => void;
  host?: string;
  /** What kind of node this is: a linked device (ranked first) or the standalone 「Crossline 节点」. */
  role: "device" | "standalone";
  /** Runs it takes at once; by default from this computer's cores and memory (`nodeCapacity`). */
  capacity?: number;
  /** Waits between attempts; a refusal (other Codex version, switched off on the site) waits longer. */
  backoffMs?: number[];
  refusedWaitMs?: number;
};

/**
 * How many runs this computer takes at once. A person's computer is far stronger than the hosted server (2 CPUs, 3.5 GB for everything),
 * and a model turn mostly waits on the model: one run per logical core, at most one per GB of memory, between 4 and `NODE_CAPACITY_MAX`
 * (16 on a 16-core, 32 GB machine). `CROSSLINE_NODE_CAPACITY` sets it outright (the owner's own choice, same bounds).
 */
export function nodeCapacity(cores = cpus().length, memoryBytes = totalmem(), env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.CROSSLINE_NODE_CAPACITY);
  const measured = Math.min(cores, Math.floor(memoryBytes / 1024 ** 3));
  return Math.max(4, Math.min(NODE_CAPACITY_MAX, Number.isFinite(set) && set > 0 ? Math.floor(set) : measured));
}

export function nodeUrl(site: string): string {
  const url = new URL("/node", site);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

export function startNodeAgent(options: NodeAgentOptions): { stop: () => void; status: () => NodeAgentStatus } {
  const log = options.log ?? (() => {});
  const spawn = options.spawn;
  const backoff = options.backoffMs ?? [5_000, 15_000, 60_000, 300_000];
  const mirror = path.join(options.dir, "mirror");
  const work = path.join(options.dir, "work");
  mkdirSync(work, { recursive: true });
  let status: NodeAgentStatus = { state: "connecting", since: new Date().toISOString() };
  const setStatus = (state: NodeAgentStatus["state"], message?: string, code?: string) => {
    status = { state, since: new Date().toISOString(), ...(code ? { code } : {}), ...(message ? { message } : {}) };
  };
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: { socket: WebSocket; end: () => void } | undefined;

  const schedule = (ms: number) => { if (!stopped) timer = setTimeout(connect, ms); };

  function connect(): void {
    if (stopped) return;
    setStatus("connecting");
    const socket = new WebSocket(nodeUrl(options.url), { headers: { authorization: `Bearer ${options.token}` }, maxPayload: 64 * 1_048_576 });
    let runtime: AppServerLines | undefined;
    let relay: Server | undefined;
    let roots: string[] = [];
    let gateway: string | undefined;
    let relayOrigin: string | undefined;
    let relayReady: Promise<void> = Promise.resolve();
    let refusedFor: string | undefined;
    let nextId = 0;
    const files = new Map<number, (answer: Extract<NodeFrame, { t: "files-answer" }>) => void>();
    const images = new Map<number, (answer: Extract<NodeFrame, { t: "image-answer" }>) => void>();
    const gw = new Map<number, { response: import("node:http").ServerResponse }>();
    const send = (frame: NodeFrame) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };
    const toServer = (line: string) => send({ t: "rpc", line });
    let chain = Promise.resolve();
    let initialized: ((agent: string) => void) | undefined;

    const end = () => {
      runtime?.stop();
      runtime = undefined;
      relay?.close();
      relay = undefined;
      for (const pending of gw.values()) { try { pending.response.destroy(); } catch { /* gone */ } }
      gw.clear();
    };
    current = { socket, end };

    socket.on("unexpected-response", (_request, response) => {
      refusedFor = response.statusCode === 401 ? "NODE_TOKEN_INVALID" : response.statusCode === 403 ? "NODE_NOT_ALLOWED" : `HTTP_${response.statusCode}`;
      socket.terminate();
    });
    socket.on("open", () => {
      attempt = 0;
      runtime = spawn();
      runtime.onLine((line) => {
        let message: { id?: unknown; result?: { userAgent?: unknown } } | undefined;
        try { message = JSON.parse(line) as typeof message; } catch { return; }
        if (message?.id === "node-init") { initialized?.(String(message.result?.userAgent ?? "")); return; }
        toServer(line);
      });
      runtime.onExit(() => { if (socket.readyState === WebSocket.OPEN) socket.close(4011, "NODE_RUNTIME_EXITED"); });
      // The runtime is initialized here, once per connection, with ids the server's client never uses.
      void new Promise<string>((resolve) => { initialized = resolve;
        runtime!.write(JSON.stringify({ id: "node-init", method: "initialize", params: { clientInfo: { name: "crossline", title: "Crossline", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false } } })); })
        .then((agent) => {
          runtime?.write(JSON.stringify({ method: "initialized" }));
          send({ t: "hello", protocol: NODE_PROTOCOL, codex: agent, platform: process.platform, host: (options.host ?? hostname()).slice(0, 60),
            role: options.role, capacity: options.capacity ?? nodeCapacity() });
        });
    });
    socket.on("message", (raw) => {
      const frame = parseFrame(raw.toString());
      if (!frame) return;
      if (frame.t === "welcome") {
        roots = Array.isArray(frame.roots) ? frame.roots.filter((root) => typeof root === "string" && root.startsWith("/")) : [];
        gateway = frame.gateway;
        if (gateway) relayReady = startRelay();
        setStatus("ready");
        log({ type: "node.agent_ready", roots: roots.length, gateway: Boolean(gateway) });
        return;
      }
      if (frame.t === "rpc") { chain = chain.then(() => fromServer(frame.line)).catch(() => undefined); return; }
      if (frame.t === "files-answer") { files.get(frame.id)?.(frame); files.delete(frame.id); return; }
      if (frame.t === "image-answer") { images.get(frame.id)?.(frame); images.delete(frame.id); return; }
      if (frame.t === "gw-head") { const pending = gw.get(frame.id); pending?.response.writeHead(frame.status, frame.headers); return; }
      if (frame.t === "gw-data") { gw.get(frame.id)?.response.write(Buffer.from(frame.data, "base64")); return; }
      if (frame.t === "gw-end") {
        const pending = gw.get(frame.id);
        gw.delete(frame.id);
        if (!pending) return;
        if (frame.error && !pending.response.headersSent) pending.response.writeHead(502, { "content-type": "text/plain" });
        pending.response.end(frame.error && !pending.response.headersSent ? frame.error : undefined);
      }
    });
    socket.on("close", (code, reason) => {
      end();
      if (current?.socket === socket) current = undefined;
      const why = refusedFor ?? reason.toString();
      const words = CLOSE_WORDS[why] ?? (why.startsWith("HTTP_") ? `网页版回答 ${why.slice(5)}` : why);
      // Refused for something only the person can change (switched off on the site, another Codex version, the token): try again later.
      const refused = Boolean(refusedFor) || code === 4002 || code === 4003 || code === 4004 || code === 4009 || code === 4010;
      if (refused) setStatus("refused", words || String(code), why || undefined); else setStatus("waiting", words || `连接断开（${code}）`, why || undefined);
      log({ type: "node.agent_closed", code, reason: why });
      schedule(refused ? options.refusedWaitMs ?? 10 * 60_000 : backoff[Math.min(attempt++, backoff.length - 1)]!);
    });
    socket.on("error", () => { /* the close that follows decides */ });

    /** A line from the hosted worker: a request is checked and mapped before the runtime sees it; an answer to the runtime passes. */
    async function fromServer(line: string): Promise<void> {
      if (!runtime) return;
      let message: { id?: unknown; method?: unknown; params?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      if (typeof message.method !== "string") { runtime.write(line); return; }
      // Notifications from the server have nothing to say to this runtime (it was initialized here).
      if (message.id === undefined) return;
      const why = refusal(message.method, message.params);
      if (why) { toServer(JSON.stringify({ id: message.id, error: { code: -32601, message: why } })); log({ type: "node.refused_request", method: message.method, why }); return; }
      const params = (message.params ?? {}) as { marketplacePath?: unknown };
      if (message.method === "plugin/install" && typeof params.marketplacePath === "string" && underRoots(params.marketplacePath, roots)) {
        const mirrored = await mirrorDir(marketplaceRoot(params.marketplacePath));
        if (mirrored) { toServer(JSON.stringify({ id: message.id, error: { code: -32000, message: mirrored } })); return; }
      }
      // Pictures the turn hands the model are on the server: each is copied here first.
      let turnParams = message.params;
      if (message.method === "turn/start" && turnImages(message.params).length) {
        const copies = new Map<string, string>();
        for (const image of turnImages(message.params)) {
          const copied = await copyImage(image);
          if (!copied.ok) { toServer(JSON.stringify({ id: message.id, error: { code: -32000, message: copied.error } })); return; }
          copies.set(image, copied.file);
        }
        turnParams = withLocalImages(message.params, copies);
      }
      await relayReady;
      if (!runtime) return;
      runtime.write(JSON.stringify({ id: message.id, method: message.method,
        params: rewriteParams(turnParams, { roots, mirror, work, ...(gateway ? { gateway } : {}), ...(relayOrigin ? { relay: relayOrigin } : {}) }) }));
    }

    /** A picture from the server, kept in the work directory under its content's hash. */
    function copyImage(serverPath: string): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
      const id = ++nextId;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => { images.delete(id); resolve({ ok: false, error: "NODE_IMAGE_TIMEOUT" }); }, 60_000);
        images.set(id, (answer) => {
          clearTimeout(timeout);
          if (!answer.data) { resolve({ ok: false, error: answer.error ?? "NODE_IMAGE_FAILED" }); return; }
          const bytes = Buffer.from(answer.data, "base64");
          const dir = path.join(work, "images");
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}${path.posix.extname(serverPath).toLowerCase()}`);
          writeFileSync(file, bytes);
          resolve({ ok: true, file });
        });
        send({ t: "image", id, path: serverPath });
      });
    }

    /** The server's directory into this computer's mirror, replaced whole; returns why not, or undefined when done. */
    function mirrorDir(dir: string): Promise<string | undefined> {
      const id = ++nextId;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => { files.delete(id); resolve("NODE_MIRROR_TIMEOUT"); }, 60_000);
        files.set(id, (answer) => {
          clearTimeout(timeout);
          if (answer.error || !answer.files) { resolve(answer.error ?? "NODE_MIRROR_FAILED"); return; }
          const target = nodePath(dir, roots, mirror, work);
          if (!target.startsWith(mirror + path.sep)) { resolve("NODE_PATH_REFUSED"); return; }
          rmSync(target, { recursive: true, force: true });
          for (const file of answer.files) {
            const out = path.join(target, ...file.rel.split("/").filter((part) => part && part !== ".." && part !== "."));
            if (!out.startsWith(target + path.sep)) continue;
            mkdirSync(path.dirname(out), { recursive: true });
            writeFileSync(out, Buffer.from(file.data, "base64"));
          }
          resolve(undefined);
        });
        send({ t: "files", id, dir });
      });
    }

    /** A provider thread's requests to the model gateway, which lives on the server: carried there over this connection. */
    function startRelay(): Promise<void> {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const id = ++nextId;
          gw.set(id, { response });
          const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>;
          const body = Buffer.concat(chunks);
          send({ t: "gw", id, method: request.method ?? "GET", path: request.url ?? "/", headers, ...(body.length ? { body: body.toString("base64") } : {}) });
        });
      });
      relay = server;
      return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { relayOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); }));
    }
  }

  connect();
  return {
    stop: () => { stopped = true; if (timer) clearTimeout(timer); current?.end(); current?.socket.close(1000, "NODE_STOPPED"); setStatus("off"); },
    status: () => status
  };
}
