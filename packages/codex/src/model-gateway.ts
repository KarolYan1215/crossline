import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createChatStreamTranslator, responsesToChat, sseEvent, upstreamFailure, type BridgeUpstream } from "./chat-bridge";

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
export type GatewayUpstream = BridgeUpstream & { kind: "chat" | "responses"; key?: string };
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
}): Promise<ModelGateway> {
  const send = options.fetch ?? fetch;
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
    const headers: Record<string, string> = { "content-type": "application/json", ...(upstream.key ? { authorization: `Bearer ${upstream.key}` } : {}) };
    const base = upstream.baseUrl.replace(/\/+$/, "");

    if (match[2] === "models") {
      // Codex asks for the model list on start; a provider without one is simply "no list".
      try {
        const answer = await send(`${base}/models`, { headers });
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
    const forward = upstream.kind === "chat" ? responsesToChat(parsed, upstream) : undefined;
    if (forward) {
      dumpRequest(parsed, forward.body);
      if (forward.dropped.length) options.onDropped?.(route.workspaceId, route.providerId, forward.dropped);
    }
    let answer: Response;
    try {
      answer = await send(`${base}/${forward ? "chat/completions" : "responses"}`, { method: "POST", signal: abort.signal,
        headers: forward ? headers : { ...headers, accept: "text/event-stream" }, body: forward ? JSON.stringify(forward.body) : raw! });
    } catch (error) {
      return json(response, 502, { error: { message: `upstream unreachable: ${error instanceof Error ? error.message : "?"}` } });
    }
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
