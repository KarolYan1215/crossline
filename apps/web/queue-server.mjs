/**
 * `next start` with a line in front of it (decided 2026-10-16, hosted beta). Ten signed-in people opening pages at once on the 280 MB
 * web container meant ten server renders holding the person's whole board in memory together: the container was killed for memory
 * twice and Caddy answered 502 to a fifth of the pages (`scripts/load-app.ts`). Slower is acceptable, falling over is not, so:
 *
 * - At most `CROSSLINE_WEB_CONCURRENCY` (2) page renders at once; the rest wait in arrival order. Node renders on one thread, so four
 *   at once only took four times as long each for the same throughput; two still overlap the waits on the ledger and the worker.
 *   The APIs pages poll, static files,
 *   images and every write (POST and the like — a person's action, or a wait on the worker that holds little memory) never wait.
 * - While the process holds more than `CROSSLINE_WEB_HIGH_WATER` (80%) of its container's memory, nothing new starts until a request
 *   in flight ends; with none in flight the next one goes anyway, so a reading that never drops cannot stop the site.
 * - The line is bounded (2026-10-27): past 50 waiting, or after 30 s in it, a page is answered 503 with `Retry-After: 5`.
 *
 *   node queue-server.mjs --hostname 127.0.0.1 --port 3210
 *
 * Once a minute it logs `web.timing`: per route, how long requests waited and how long serving took (p50/p95), the busiest first; and
 * `web.sections`: the pages' own named loaders (apps/web/lib/sections.ts), the most total time first.
 *
 * Used by the hosted beta (deploy/server/run.sh); everywhere else `next start` runs as before.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import next from "next";
import { createLine } from "./queue-line.mjs";

const argument = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : fallback; };
const hostname = argument("hostname", "127.0.0.1");
const port = Number(argument("port", "3210"));
const limit = Math.max(1, Number(process.env.CROSSLINE_WEB_CONCURRENCY) || 2);
const highWater = Number(process.env.CROSSLINE_WEB_HIGH_WATER) > 0 && Number(process.env.CROSSLINE_WEB_HIGH_WATER) < 1 ? Number(process.env.CROSSLINE_WEB_HIGH_WATER) : 0.8;

/** Files Next serves as they are: never queued. */
const STATIC = /^\/(_next\/(static|image)|mediapipe|fonts|pwa-icon|favicon|icon|apple-icon|manifest|sw\.js|robots\.txt)|\.(js|css|png|jpe?g|svg|ico|webp|woff2?|wasm|map|txt|json)$/;
/**
 * Only page renders wait: they hold a person's whole board while they run (2–5 s each with four at once, measured 2026-10-16). The APIs
 * pages poll answer in 20–400 ms and hold little, yet waited 6–45 s behind the pages, so they go straight through.
 */
const waits = (request) => {
  const path = (request.url ?? "/").split("?")[0];
  return (request.method === "GET" || request.method === "HEAD") && !STATIC.test(path) && !path.startsWith("/api/");
};

function read(file) { try { return readFileSync(file, "utf8").trim(); } catch { return undefined; } }
/** The container's ceiling (cgroup v2, else v1); none on a machine without one, and then memory never holds a request back. */
const ceiling = (() => {
  const v2 = read("/sys/fs/cgroup/memory.max");
  const value = Number(v2 && v2 !== "max" ? v2 : read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  return Number.isFinite(value) && value > 0 && value < 2 ** 50 ? value : undefined;
})();
const memoryHigh = () => ceiling !== undefined && process.memoryUsage().rss / ceiling >= highWater;

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
  // The pages' own named sections (apps/web/lib/sections.ts), the most total time first.
  const sections = globalThis.__crosslineSections;
  if (sections?.size) {
    const rows = [...sections].map(([name, list]) => ({ name, n: list.length, p50: Math.round(p(list, 0.5)), p95: Math.round(p(list, 0.95)),
      total: Math.round(list.reduce((x, y) => x + y, 0)) })).sort((a, b) => b.total - a.total).slice(0, 20);
    console.info(JSON.stringify({ type: "web.sections", rows }));
    sections.clear();
  }
}, 60_000).unref();

/**
 * The line itself (queue-line.mjs): pages before polls, a slot freed when the response ends or the person goes away (a person who
 * leaves while still waiting leaves the line at once — the first version leaked a slot per abandoned request and four stopped the site,
 * 2026-10-16), no slot held past two minutes, and at most `CROSSLINE_WEB_QUEUE_MAX` (50) waiting for at most
 * `CROSSLINE_WEB_QUEUE_WAIT_MS` (30 s) before a 503 with `Retry-After: 5`.
 */
const { inLine } = createLine({
  limit,
  memoryHigh,
  maxQueued: Math.max(1, Number(process.env.CROSSLINE_WEB_QUEUE_MAX) || 50),
  maxWaitMs: Math.max(1_000, Number(process.env.CROSSLINE_WEB_QUEUE_WAIT_MS) || 30_000),
  record,
  routeOf,
  log: (event) => {
    const line = JSON.stringify(event.type === "web.queue" ? { ...event, rssMb: Math.round(process.memoryUsage().rss / 1048576) } : event);
    if (event.type === "web.request_failed") console.error(line); else console.info(line);
  }
});

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
