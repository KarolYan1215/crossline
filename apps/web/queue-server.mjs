/**
 * `next start` with a line in front of it (decided 2026-10-16, hosted beta). Ten signed-in people opening pages at once on the 280 MB
 * web container meant ten server renders holding the person's whole board in memory together: the container was killed for memory
 * twice and Caddy answered 502 to a fifth of the pages (`scripts/load-app.ts`). Slower is acceptable, falling over is not, so:
 *
 * - At most `CROSSLINE_WEB_CONCURRENCY` (4) page renders and GET API reads at once; the rest wait, pages before the APIs pages poll in
 *   the background, each in arrival order. Static files,
 *   images and every write (POST and the like — a person's action, or a wait on the worker that holds little memory) never wait.
 * - While the process holds more than `CROSSLINE_WEB_HIGH_WATER` (80%) of its container's memory, nothing new starts until a request
 *   in flight ends; with none in flight the next one goes anyway, so a reading that never drops cannot stop the site.
 *
 *   node queue-server.mjs --hostname 127.0.0.1 --port 3210
 *
 * Once a minute it logs `web.timing`: per route, how long requests waited and how long serving took (p50/p95), the busiest first.
 *
 * Used by the hosted beta (deploy/server/run.sh); everywhere else `next start` runs as before.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import next from "next";

const argument = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : fallback; };
const hostname = argument("hostname", "127.0.0.1");
const port = Number(argument("port", "3210"));
const limit = Math.max(1, Number(process.env.CROSSLINE_WEB_CONCURRENCY) || 4);
const highWater = Number(process.env.CROSSLINE_WEB_HIGH_WATER) > 0 && Number(process.env.CROSSLINE_WEB_HIGH_WATER) < 1 ? Number(process.env.CROSSLINE_WEB_HIGH_WATER) : 0.8;

/** Files Next serves as they are: never queued. */
const STATIC = /^\/(_next\/(static|image)|mediapipe|fonts|pwa-icon|favicon|icon|apple-icon|manifest|sw\.js|robots\.txt)|\.(js|css|png|jpe?g|svg|ico|webp|woff2?|wasm|map|txt|json)$/;
const waits = (request) => (request.method === "GET" || request.method === "HEAD") && !STATIC.test((request.url ?? "/").split("?")[0]);

function read(file) { try { return readFileSync(file, "utf8").trim(); } catch { return undefined; } }
/** The container's ceiling (cgroup v2, else v1); none on a machine without one, and then memory never holds a request back. */
const ceiling = (() => {
  const v2 = read("/sys/fs/cgroup/memory.max");
  const value = Number(v2 && v2 !== "max" ? v2 : read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  return Number.isFinite(value) && value > 0 && value < 2 ** 50 ? value : undefined;
})();
const memoryHigh = () => ceiling !== undefined && process.memoryUsage().rss / ceiling >= highWater;

let active = 0;
/** Two lines: what a person is looking at a blank page for (a page or its RSC payload) goes before what a page polls in the background. */
const lines = { page: [], poll: [] };
let timer;
let logged = 0;

function pump() {
  while ((lines.page.length || lines.poll.length) && active < limit) {
    if (memoryHigh() && active > 0) { if (!timer) timer = setTimeout(() => { timer = undefined; pump(); }, 250); return; }
    const next = lines.page.shift() ?? lines.poll.shift();
    active += 1;
    next();
  }
}

/** Per route (ids folded to `:id`) for the last minute: how long requests waited in line and how long serving them took. */
let stats = new Map();
const routeOf = (url) => (url ?? "/").split("?")[0].replace(/\/[A-Za-z0-9_-]{16,}|\/\d[\w-]*/g, "/:id");
function record(route, waitedMs, servedMs) {
  const entry = stats.get(route) ?? { n: 0, wait: [], serve: [] };
  entry.n += 1; entry.wait.push(waitedMs); entry.serve.push(servedMs);
  stats.set(route, entry);
}
const p = (values, at) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(at * sorted.length) - 1)] ?? 0; };
setInterval(() => {
  if (!stats.size) return;
  const routes = [...stats].sort((a, b) => b[1].serve.reduce((x, y) => x + y, 0) - a[1].serve.reduce((x, y) => x + y, 0)).slice(0, 12)
    .map(([route, entry]) => ({ route, n: entry.n, waitP50: p(entry.wait, 0.5), waitP95: p(entry.wait, 0.95), serveP50: p(entry.serve, 0.5), serveP95: p(entry.serve, 0.95) }));
  console.info(JSON.stringify({ type: "web.timing", rssMb: Math.round(process.memoryUsage().rss / 1048576), routes }));
  stats = new Map();
}, 60_000).unref();

/** A slot a request still holds after this goes back to the pool, so no request — however it ends, or fails to — can stop the line. */
const SLOT_MAX_MS = 120_000;

/**
 * Runs `work` once a slot is free (pages before polls) and frees the slot when the response ends or the person goes away. A person
 * who leaves while still waiting leaves the line at once: the first version attached its listeners only when the turn came, after the
 * connection had already closed, so each such slot was never freed and four of them stopped the site (2026-10-16).
 */
function inLine(request, response, work) {
  const queuedAt = Date.now();
  const route = routeOf(request.url);
  const kind = route.startsWith("/api/") ? "poll" : "page";
  let started = false;
  const turn = () => {
    started = true;
    let freed = false;
    const startedAt = Date.now();
    const free = () => {
      if (freed) return;
      freed = true; active -= 1;
      clearTimeout(watchdog);
      record(route, startedAt - queuedAt, Date.now() - startedAt);
      pump();
    };
    const watchdog = setTimeout(free, SLOT_MAX_MS);
    watchdog.unref?.();
    // Gone while waiting (a closed tab, a timed-out client): nothing to render, the slot goes straight back.
    if (response.destroyed || response.writableEnded) { free(); return; }
    response.once("close", free);
    response.once("finish", free);
    const waited = startedAt - queuedAt;
    // A wait worth knowing about, at most once a minute so a busy minute is one line.
    if (waited > 2_000 && Date.now() - logged > 60_000) {
      logged = Date.now();
      console.info(JSON.stringify({ type: "web.queue", waitedMs: waited, waiting: lines.page.length + lines.poll.length, active, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
    }
    Promise.resolve().then(work).catch((error) => {
      console.error(JSON.stringify({ type: "web.request_failed", error: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent && !response.destroyed) { response.statusCode = 500; response.end(); }
      free();
    });
  };
  lines[kind].push(turn);
  response.once("close", () => {
    if (started) return;
    const at = lines[kind].indexOf(turn);
    if (at >= 0) lines[kind].splice(at, 1);
  });
  pump();
}

const app = next({ dev: false, hostname, port, dir: import.meta.dirname });
const handle = app.getRequestHandler();
await app.prepare();
createServer((request, response) => {
  // A request whose person already left before its turn is dropped from the line rather than rendered for nobody.
  if (!waits(request)) {
    const startedAt = Date.now();
    const route = routeOf(request.url);
    if (!STATIC.test(route)) response.once("finish", () => record(route, 0, Date.now() - startedAt));
    Promise.resolve(handle(request, response)).catch(() => { if (!response.headersSent) { response.statusCode = 500; response.end(); } });
    return;
  }
  inLine(request, response, () => handle(request, response));
}).listen(port, hostname, () => {
  console.info(JSON.stringify({ type: "web.listening", hostname, port, concurrency: limit, ceilingMb: ceiling ? Math.round(ceiling / 1048576) : null }));
});
