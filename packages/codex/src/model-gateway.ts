import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createChatStreamTranslator, responsesToChat, sseEvent, upstreamFailure, type BridgeUpstream } from "./chat-bridge";
import { priorityForSkill } from "./model-gate";

/**
 * The one local listener every third-party provider is reached through (R7, decided 2026-10-13). Codex is given
 * `base_url = http://127.0.0.1:<port>/<route>` and no key at all; this gateway adds the key to each request as it forwards it.
 *
 *  - `chat`: a Chat-Completions-only provider (DeepSeek, Kimi, GLM, Qwen, and Claude and Gemini through their OpenAI-compatible
 *    endpoints). Each Responses request is translated (`chat-bridge.ts`) and the stream translated back.
 *  - `responses`: a provider that speaks Responses itself (OpenAI API, OpenRouter, a local Ollama). Passed through unchanged.
 *
 * Why the key is added here rather than given to Codex through `env_key`: it then never sits in a runtime's environment, config,
 * thread settings or rollout files, and a key that changes (a refreshed Sign in with ChatGPT token) is read fresh on the next request,
 * with no runtime restart. The route segment is an HMAC of the workspace and provider under a secret made at start, so it is stable
 * for one run of the worker, cannot be guessed, and a stale one written down anywhere dies with the process. The upstream address is
 * resolved from the route, never from the request.
 */
export type GatewayUpstream = BridgeUpstream & { kind: "chat" | "responses"; key?: string;
  /**
   * Models to try, best first, when the request's model is refused as overloaded (429, 503, 「满载」) and a person is waiting on the
   * run; the developer's model offers the other candidates that passed this Skill's checks. Background work waits and retries instead.
   */
  fallback?: (skill: string, model: string) => string[];
  /**
   * A route nobody waits on whatever its Skill (the developer's model while it is measured): a refusal for load is waited out like
   * background work, since a measurement that fails on the provider's rate limit says nothing about the model.
   */
  patient?: boolean;
  /**
   * Why this route may not be forwarded now (the provider's name no longer resolves to a public address, or a loopback address where
   * the server does not allow one); answered as an error without contacting anything.
   */
  refused?: string };

/**
 * Requests in flight per upstream model, adapted to what the upstream accepts (2026-10-19, docs/model-scheduling.md): every account on the
 * developer's key shares one provider limit per model (SiliconFlow counts requests and tokens per account and per model), and each Codex
 * request carries the whole thread, so a few long runs at once can hit it. The limit starts at `CROSSLINE_UPSTREAM_CONCURRENCY` (6),
 * halves on each refusal and grows by one after as many successes as the limit (additive increase, multiplicative decrease, as in
 * Netflix's concurrency-limits); a person's request waits ahead of background ones.
 */
type Limiter = { limit: number; inFlight: number; successes: number; until: number; timer?: ReturnType<typeof setTimeout> | undefined;
  waiting: Array<{ interactive: boolean; grant: () => void }> };
const MAX_UPSTREAM_CONCURRENCY = 16;
type Outcome = "ok" | "overloaded" | "error";

/** A refusal for load, not for the request: retry later, or elsewhere. */
export function overloaded(status: number, text: string): boolean {
  if (status === 429 || status === 503 || status === 529) return true;
  return status >= 500 && /busy|overload|capacity|too many|rate.?limit|满载|繁忙|过载|限流/i.test(text);
}
const retryAfterMs = (answer: Response): number | undefined => {
  const value = answer.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};
export type ModelGateway = { urlFor: (workspaceId: string, providerId: string) => string; port: number; close: () => Promise<void> };

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Writes both sides of a translated request to `CROSSLINE_BRIDGE_DUMP_DIR` when set — a diagnostic, like `CROSSLINE_RECORD_DIR`. */
function dumpRequest(responses: unknown, chat: unknown): void {
  const dir = process.env.CROSSLINE_BRIDGE_DUMP_DIR?.trim();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `request-${Date.now()}.json`), JSON.stringify({ responses, chat }, null, 2), "utf8");
  } catch { /* a diagnostic never fails a run */ }
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export async function startModelGateway(options: {
  resolve: (workspaceId: string, providerId: string) => GatewayUpstream | undefined | Promise<GatewayUpstream | undefined>;
  port?: number;
  fetch?: typeof fetch;
  /** What a translated request had no Chat Completions form for, so a run can say which capability was missing. */
  onDropped?: (workspaceId: string, providerId: string, dropped: string[]) => void;
  /** Waits before each retry of a refused background request (tests shorten them); a refusal's own Retry-After is used when longer. */
  backoffMs?: number[];
  /** The one quick retry of a refused request a person waits on, before another model is tried. */
  quickRetryMs?: number;
  initialConcurrency?: number;
  log?: (event: Record<string, unknown>) => void;
}): Promise<ModelGateway> {
  // Every request is sent with `redirect: "manual"`: a redirect would carry the key to an address nobody saved and nobody checked.
  const send = options.fetch ?? fetch;
  const backoff = options.backoffMs ?? [5_000, 15_000, 45_000, 90_000];
  const quickRetry = options.quickRetryMs ?? 2_000;
  const initial = options.initialConcurrency ?? (Number(process.env.CROSSLINE_UPSTREAM_CONCURRENCY) > 0 ? Number(process.env.CROSSLINE_UPSTREAM_CONCURRENCY) : 6);
  const log = options.log ?? ((event: Record<string, unknown>) => console.info(JSON.stringify(event)));
  const limiters = new Map<string, Limiter>();
  const limiterFor = (key: string): Limiter => {
    let limiter = limiters.get(key);
    if (!limiter) { limiter = { limit: initial, inFlight: 0, successes: 0, until: 0, waiting: [] }; limiters.set(key, limiter); }
    return limiter;
  };
  const pumpLimiter = (limiter: Limiter) => {
    const now = Date.now();
    if (now < limiter.until) {
      if (!limiter.timer) limiter.timer = setTimeout(() => { limiter.timer = undefined; pumpLimiter(limiter); }, limiter.until - now);
      return;
    }
    while (limiter.waiting.length && limiter.inFlight < limiter.limit) { limiter.inFlight += 1; limiter.waiting.shift()!.grant(); }
  };
  /** A place in the upstream model's limit; the returned function gives it back with how the request went. */
  const acquire = (key: string, interactive: boolean, signal: AbortSignal) => new Promise<(outcome: Outcome, waitMs?: number) => void>((resolve, reject) => {
    const limiter = limiterFor(key);
    let done = false;
    const release = (outcome: Outcome, waitMs?: number) => {
      if (done) return;
      done = true;
      limiter.inFlight = Math.max(0, limiter.inFlight - 1);
      if (outcome === "ok" && ++limiter.successes >= limiter.limit) { limiter.limit = Math.min(MAX_UPSTREAM_CONCURRENCY, limiter.limit + 1); limiter.successes = 0; }
      if (outcome === "overloaded") {
        limiter.limit = Math.max(1, Math.floor(limiter.limit / 2));
        limiter.successes = 0;
        if (waitMs) limiter.until = Math.max(limiter.until, Date.now() + waitMs);
      }
      pumpLimiter(limiter);
    };
    const entry = { interactive, grant: () => { signal.removeEventListener("abort", onAbort); resolve(release); } };
    function onAbort() {
      const index = limiter.waiting.indexOf(entry);
      if (index >= 0) limiter.waiting.splice(index, 1);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const at = interactive ? limiter.waiting.findIndex((other) => !other.interactive) : -1;
    if (at < 0) limiter.waiting.push(entry); else limiter.waiting.splice(at, 0, entry);
    pumpLimiter(limiter);
  });
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const secret = randomBytes(32);
  const routes = new Map<string, { workspaceId: string; providerId: string }>();
  const routeOf = (workspaceId: string, providerId: string) => {
    const id = createHmac("sha256", secret).update(`${workspaceId}\n${providerId}`).digest("hex").slice(0, 32);
    routes.set(id, { workspaceId, providerId });
    return id;
  };
  let counter = 0;

  const server = createServer(async (request, response) => {
    const match = /^\/([a-f0-9]{32})\/(responses|models)$/.exec((request.url ?? "").split("?")[0] ?? "");
    const route = match ? routes.get(match[1]!) : undefined;
    const upstream = route ? await options.resolve(route.workspaceId, route.providerId) : undefined;
    if (!match || !route || !upstream) return json(response, 404, { error: { message: "unknown route" } });
    if (upstream.refused) return json(response, 502, { error: { message: upstream.refused, code: "upstream_refused" } });
    const headers: Record<string, string> = { "content-type": "application/json", ...(upstream.key ? { authorization: `Bearer ${upstream.key}` } : {}) };
    const base = upstream.baseUrl.replace(/\/+$/, "");

    if (match[2] === "models") {
      // Codex asks for the model list on start; a provider without one is simply "no list".
      try {
        const answer = await send(`${base}/models`, { headers, redirect: "manual" });
        return answer.ok ? json(response, 200, await answer.json()) : json(response, 404, { data: [] });
      } catch { return json(response, 404, { data: [] }); }
    }
    if (request.method !== "POST") return json(response, 405, { error: { message: "POST only" } });
    const raw = await readBody(request, 32 * 1024 * 1024);
    let parsed: Record<string, unknown> | undefined;
    try { const value: unknown = raw === undefined ? undefined : JSON.parse(raw); parsed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
    catch { parsed = undefined; }
    if (!parsed) return json(response, 400, { error: { message: "request is not a JSON object" } });

    const abort = new AbortController();
    response.on("close", () => { if (!response.writableEnded) abort.abort(); });
    // Which Skill sent it (the thread's provider definition carries the header), so a person's turn is told apart from background work.
    const skill = String(request.headers["x-crossline-skill"] ?? "");
    const interactive = !upstream.patient && Boolean(skill) && priorityForSkill(skill) === "interactive";
    let model = typeof parsed.model === "string" ? parsed.model : "";
    const tried = new Set([model]);
    let forward: ReturnType<typeof responsesToChat> | undefined;
    let answer: Response;
    let release: (outcome: Outcome, waitMs?: number) => void;
    let quickRetried = false;
    let attempt = 0;
    // Refused for load: background work waits (the refusal's Retry-After, else growing pauses) and tries the same model again; a person's
    // turn tries again once at once, then the next model that passed this Skill's checks. Anything else is answered as it came.
    for (;;) {
      const asked = model === parsed.model ? parsed : { ...parsed, model };
      forward = upstream.kind === "chat" ? responsesToChat(asked, upstream) : undefined;
      if (forward && attempt === 0) {
        dumpRequest(parsed, forward.body);
        if (forward.dropped.length) options.onDropped?.(route.workspaceId, route.providerId, forward.dropped);
      }
      try { release = await acquire(`${base}|${model}`, interactive, abort.signal); }
      catch { return; }
      try {
        answer = await send(`${base}/${forward ? "chat/completions" : "responses"}`, { method: "POST", signal: abort.signal, redirect: "manual",
          headers: forward ? headers : { ...headers, accept: "text/event-stream" }, body: forward ? JSON.stringify(forward.body) : asked === parsed ? raw! : JSON.stringify(asked) });
      } catch (error) {
        release("error");
        return json(response, 502, { error: { message: `upstream unreachable: ${error instanceof Error ? error.message : "?"}` } });
      }
      if (answer.ok || answer.status === 401 || answer.status === 403) break;
      const text = await answer.text().catch(() => "");
      if (!overloaded(answer.status, text)) { release("error"); answer = new Response(text, { status: answer.status, headers: answer.headers }); break; }
      const waitMs = retryAfterMs(answer);
      release("overloaded", waitMs);
      const next = interactive && quickRetried ? upstream.fallback?.(skill, model).find((candidate) => !tried.has(candidate)) : undefined;
      const pause = interactive ? (quickRetried ? 0 : Math.min(waitMs ?? quickRetry, quickRetry)) : Math.max(waitMs ?? 0, backoff[attempt] ?? -1);
      const action = interactive ? (!quickRetried ? "retry" : next ? "fallback" : "gave_up") : attempt < backoff.length ? "retry" : "gave_up";
      log({ type: "gateway.overloaded", model, status: answer.status, interactive, action, ...(next ? { to: next } : {}),
        limit: limiterFor(`${base}|${model}`).limit });
      if (action === "gave_up") { answer = new Response(text, { status: answer.status, headers: answer.headers }); break; }
      attempt += 1;
      if (action === "fallback") { model = next!; tried.add(model); }
      else { if (interactive) quickRetried = true; await sleep(pause, abort.signal); }
      if (abort.signal.aborted) return;
    }
    let settled = false;
    const finish = (outcome: Outcome) => { if (!settled) { settled = true; release(outcome); } };
    response.on("close", () => finish(answer.ok ? "ok" : "error"));
    if (answer.status === 401 || answer.status === 403) {
      // A status, not a stream event, so Codex reports a sign-in problem rather than a model failure.
      return json(response, 401, { error: { message: upstreamFailure(answer.status, await answer.text()).message, code: "invalid_api_key" } });
    }

    if (!forward) {
      // Passthrough: the provider's own status, headers that matter, and bytes.
      response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-store" });
      if (!answer.body) { response.end(); return; }
      try { for await (const piece of answer.body as unknown as AsyncIterable<Uint8Array>) response.write(piece); }
      catch { /* the caller hung up or the upstream broke; Codex sees the stream end and retries */ }
      response.end();
      return;
    }

    const responseId = `resp_gw_${Date.now().toString(36)}_${(counter += 1)}`;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const translator = createChatStreamTranslator(responseId, forward.tools);
    for (const line of translator.start(parsed.model)) response.write(line);
    if (!answer.ok || !answer.body) {
      const failure = upstreamFailure(answer.status, await answer.text().catch(() => ""));
      response.end(sseEvent("response.failed", { response: { id: responseId, status: "failed", error: failure } }));
      return;
    }
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const piece of answer.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(piece, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let chunk: Record<string, unknown> | undefined;
          try { const value: unknown = JSON.parse(data); chunk = value && typeof value === "object" ? value as Record<string, unknown> : undefined; } catch { continue; }
          if (!chunk) continue;
          if (chunk.error) {
            response.end(sseEvent("response.failed", { response: { id: responseId, status: "failed", error: upstreamFailure(400, JSON.stringify(chunk)) } }));
            return;
          }
          for (const out of translator.push(chunk)) response.write(out);
        }
      }
      for (const out of translator.end()) response.write(out);
      response.end();
    } catch (error) {
      if (!response.writableEnded) response.end(sseEvent("response.failed", { response: { id: responseId, status: "failed",
        error: { code: "server_error", message: `upstream stream broke: ${error instanceof Error ? error.message : "?"}` } } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    urlFor: (workspaceId, providerId) => `http://127.0.0.1:${port}/${routeOf(workspaceId, providerId)}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}
