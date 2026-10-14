import { APP_PAGES, sanitizeTelemetryBatch } from "../../../packages/core/src/telemetry";
import { dashboardData, renderDashboard } from "./dashboard";

/**
 * The owner's collector for installed copies (docs/local-installer.md, 接收端), a Cloudflare Worker over one D1 database.
 *
 *   POST /v1/events      a batch of usage metadata; passed through the same whitelist the sender used (`sanitizeTelemetryBatch`)
 *                        before anything is stored, so a tampered or buggy client cannot put more into the table than the
 *                        whitelist allows
 *   POST /v1/snapshots   a gzipped diagnostic snapshot the person previewed and sent from Settings
 *   GET  /dashboard      the owner's view, only behind Cloudflare Access (the JWT is verified here too, never trusted by header)
 *
 * Writes are limited per install and per request size. Install ids are random and the installer is public, so anyone can post:
 * the limits bound what one id can cost, and nothing posted is ever shown to anyone but the owner.
 */
export type D1Value = string | number | null | Uint8Array;
export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface D1 { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<unknown[]> }
export type Env = { DB: D1; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };

const PAGES = new Set<string>(APP_PAGES);
const INSTALL = /^[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(-[a-z0-9.]{1,20})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const EVENTS_MAX_BYTES = 512 * 1024;
export const SNAPSHOT_MAX_BYTES = 2_000_000;
/** A snapshot unpacks to at most this much; a body that would grow past it is refused rather than decompressed. */
export const SNAPSHOT_MAX_UNPACKED = 64 * 1024 * 1024;
export const REQUESTS_PER_HOUR = 30;
export const SNAPSHOTS_PER_DAY = 5;
const FEEDBACK_MAX_CHARS = 4000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readLimited(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * One row per install: when it was first and last seen, and the two counters that limit it — requests this hour and snapshots
 * today. Returns false (and changes nothing) when this request is over either limit.
 */
async function admit(db: D1, install: string, account: string | undefined, version: string, now: Date, snapshot: boolean): Promise<boolean> {
  const at = now.toISOString(), hour = at.slice(0, 13), day = at.slice(0, 10);
  const row = await db.prepare("SELECT window_start, window_requests, snapshot_day, snapshot_count FROM installs WHERE install = ?").bind(install)
    .first<{ window_start: string; window_requests: number; snapshot_day: string; snapshot_count: number }>();
  const requests = row && row.window_start === hour ? Number(row.window_requests) + 1 : 1;
  const sameDay = row?.snapshot_day === day;
  const snapshots = (sameDay ? Number(row!.snapshot_count) : 0) + (snapshot ? 1 : 0);
  if (requests > REQUESTS_PER_HOUR || (snapshot && snapshots > SNAPSHOTS_PER_DAY)) return false;
  if (!row) await db.prepare(`INSERT INTO installs (install, account, version, first_seen, last_seen, window_start, window_requests, snapshot_day, snapshot_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(install, account ?? null, version, at, at, hour, requests, day, snapshots).run();
  else await db.prepare(`UPDATE installs SET account = COALESCE(?, account), version = ?, last_seen = ?, window_start = ?, window_requests = ?,
    snapshot_day = ?, snapshot_count = ? WHERE install = ?`).bind(account ?? null, version, at, hour, requests, day, snapshots, install).run();
  return true;
}

export async function receiveEvents(request: Request, env: Env, now = new Date()): Promise<Response> {
  const bytes = await readLimited(request.body, EVENTS_MAX_BYTES);
  if (!bytes) return json({ ok: false, code: "BODY_TOO_LARGE" }, 413);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { return json({ ok: false, code: "BODY_NOT_JSON" }, 400); }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.events) || typeof raw.install !== "string" || typeof raw.version !== "string"
    || typeof raw.sentAt !== "string") return json({ ok: false, code: "BATCH_INVALID" }, 400);
  const batch = sanitizeTelemetryBatch({ install: raw.install, version: raw.version, sentAt: raw.sentAt, events: raw.events,
    ...(typeof raw.account === "string" ? { account: raw.account } : {}) }, PAGES);
  if (!batch) return json({ ok: false, code: "BATCH_INVALID" }, 400);
  if (!await admit(env.DB, batch.install, batch.account, batch.version, now, false)) return json({ ok: false, code: "RATE_LIMITED" }, 429);
  const received = now.toISOString();
  const insert = `INSERT INTO events (install, received_at, type, at, version, page, stage, skill, code, entity, ms, repairs, stalls, ok,
    input_tokens, cached_tokens, output_tokens, counts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const statements = batch.events.map((event) => env.DB.prepare(insert).bind(batch.install, received, event.type, event.at, event.version,
    event.page ?? null, event.stage ?? null, event.skill ?? null, event.code ?? null, event.entity ?? null, event.ms ?? null, event.repairs ?? null,
    event.stalls ?? null, event.ok === undefined ? null : event.ok ? 1 : 0, event.tokens?.input ?? null, event.tokens?.cached ?? null,
    event.tokens?.output ?? null, event.counts ? JSON.stringify(event.counts) : null));
  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true, accepted: statements.length });
}

export async function receiveSnapshot(request: Request, env: Env, now = new Date()): Promise<Response> {
  const install = request.headers.get("x-crossline-install") ?? "";
  if (!INSTALL.test(install)) return json({ ok: false, code: "INSTALL_INVALID" }, 400);
  const bytes = await readLimited(request.body, SNAPSHOT_MAX_BYTES);
  if (!bytes) return json({ ok: false, code: "BODY_TOO_LARGE" }, 413);
  let unpacked: Uint8Array | undefined;
  try { unpacked = await readLimited(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), SNAPSHOT_MAX_UNPACKED); }
  catch { return json({ ok: false, code: "BODY_NOT_GZIP" }, 400); }
  if (!unpacked) return json({ ok: false, code: "BODY_TOO_LARGE" }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(new TextDecoder().decode(unpacked)) as Record<string, unknown>; } catch { return json({ ok: false, code: "BODY_NOT_JSON" }, 400); }
  const snapshot = body?.snapshot as { format?: unknown } | undefined;
  const account = typeof body?.account === "string" && SHA256.test(body.account) ? body.account : undefined;
  if (body?.install !== install || typeof body.version !== "string" || !VERSION.test(body.version) || typeof body.createdAt !== "string"
    || !ISO.test(body.createdAt) || typeof body.feedback !== "string" || snapshot?.format !== "crossline.diagnostic-snapshot.v1")
    return json({ ok: false, code: "SNAPSHOT_INVALID" }, 400);
  if (!await admit(env.DB, install, account, body.version, now, true)) return json({ ok: false, code: "RATE_LIMITED" }, 429);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO snapshots (id, install, account, version, created_at, received_at, feedback, bytes, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, install, account ?? null, body.version, body.createdAt, now.toISOString(),
    body.feedback.slice(0, FEEDBACK_MAX_CHARS), bytes.byteLength, bytes).run();
  return json({ ok: true, id });
}

// ---- Cloudflare Access ------------------------------------------------------------------------------------------------------

const base64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)),
  (char) => char.charCodeAt(0));
type Jwk = JsonWebKey & { kid?: string };
let certs: { team: string; at: number; keys: Jwk[] } | undefined;

/**
 * Access puts a signed JWT on every request it lets through. It is verified here as well — signature against the team's published
 * keys, audience, issuer and expiry — so a request that reached the Worker some other way (its workers.dev address) is refused.
 */
export async function verifyAccessJwt(token: string, team: string, audience: string, now = Date.now(),
  fetcher: typeof fetch = fetch): Promise<boolean> {
  const [head, payload, signature] = token.split(".");
  if (!head || !payload || !signature) return false;
  let header: { alg?: string; kid?: string }, claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(base64url(head))) as typeof header;
    claims = JSON.parse(new TextDecoder().decode(base64url(payload))) as typeof claims;
  } catch { return false; }
  if (header.alg !== "RS256") return false;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience) || claims.iss !== team || typeof claims.exp !== "number" || claims.exp * 1000 <= now
    || (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000)) return false;
  if (!certs || certs.team !== team || now - certs.at > 10 * 60_000) {
    const response = await fetcher(`${team}/cdn-cgi/access/certs`).catch(() => undefined);
    if (!response?.ok) return false;
    certs = { team, at: now, keys: ((await response.json()) as { keys?: Jwk[] }).keys ?? [] };
  }
  const jwk = certs.keys.find((key) => key.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(signature), new TextEncoder().encode(`${head}.${payload}`));
}

async function ownerOnly(request: Request, env: Env): Promise<Response | undefined> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, ""), audience = env.ACCESS_AUD;
  // Never served open: an unconfigured collector has no dashboard at all.
  if (!team || !audience || team.includes("<") || audience.includes("<")) return new Response("ACCESS_NOT_CONFIGURED", { status: 503 });
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !await verifyAccessJwt(token, team, audience)) return new Response("FORBIDDEN", { status: 403 });
  return undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/v1/events") return receiveEvents(request, env);
    if (request.method === "POST" && pathname === "/v1/snapshots") return receiveSnapshot(request, env);
    if (request.method === "GET" && (pathname === "/dashboard" || pathname.startsWith("/dashboard/"))) {
      const refused = await ownerOnly(request, env);
      if (refused) return refused;
      const snapshot = /^\/dashboard\/snapshots\/([0-9a-f-]{36})$/.exec(pathname)?.[1];
      if (snapshot) {
        const row = await env.DB.prepare("SELECT body FROM snapshots WHERE id = ?").bind(snapshot).first<{ body: ArrayBuffer | Uint8Array }>();
        if (!row) return new Response("NOT_FOUND", { status: 404 });
        return new Response(new Uint8Array(row.body), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="snapshot-${snapshot}.json.gz"` } });
      }
      if (pathname !== "/dashboard") return new Response("NOT_FOUND", { status: 404 });
      return new Response(renderDashboard(await dashboardData(env.DB)), { headers: { "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cache-control": "no-store" } });
    }
    return new Response("NOT_FOUND", { status: 404 });
  }
};
