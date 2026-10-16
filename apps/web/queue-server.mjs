/**
 * `next start` with a line in front of it (decided 2026-10-16, hosted beta). Ten signed-in people opening pages at once on the 280 MB
 * web container meant ten server renders holding the person's whole board in memory together: the container was killed for memory
 * twice and Caddy answered 502 to a fifth of the pages (`scripts/load-app.ts`). Slower is acceptable, falling over is not, so:
 *
 * - At most `CROSSLINE_WEB_CONCURRENCY` (4) page renders and GET API reads at once; the rest wait in arrival order. Static files,
 *   images and every write (POST and the like — a person's action, or a wait on the worker that holds little memory) never wait.
 * - While the process holds more than `CROSSLINE_WEB_HIGH_WATER` (80%) of its container's memory, nothing new starts until a request
 *   in flight ends; with none in flight the next one goes anyway, so a reading that never drops cannot stop the site.
 *
 *   node queue-server.mjs --hostname 127.0.0.1 --port 3210
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
const line = [];
let timer;
let logged = 0;

function pump() {
  while (line.length && active < limit) {
    if (memoryHigh() && active > 0) { if (!timer) timer = setTimeout(() => { timer = undefined; pump(); }, 250); return; }
    const next = line.shift();
    active += 1;
    next();
  }
}

/** Runs `work` once a slot is free and frees the slot when the response ends or the person goes away. */
function inLine(response, work) {
  const queuedAt = Date.now();
  line.push(() => {
    let freed = false;
    const free = () => { if (freed) return; freed = true; active -= 1; pump(); };
    response.once("close", free);
    response.once("finish", free);
    const waited = Date.now() - queuedAt;
    // A wait worth knowing about, at most once a minute so a busy minute is one line.
    if (waited > 2_000 && Date.now() - logged > 60_000) {
      logged = Date.now();
      console.info(JSON.stringify({ type: "web.queue", waitedMs: waited, waiting: line.length, active, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
    }
    Promise.resolve().then(work).catch((error) => {
      console.error(JSON.stringify({ type: "web.request_failed", error: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent) { response.statusCode = 500; response.end(); }
      free();
    });
  });
  pump();
}

const app = next({ dev: false, hostname, port, dir: import.meta.dirname });
const handle = app.getRequestHandler();
await app.prepare();
createServer((request, response) => {
  // A request whose person already left before its turn is dropped from the line rather than rendered for nobody.
  if (!waits(request)) { Promise.resolve(handle(request, response)).catch(() => { if (!response.headersSent) { response.statusCode = 500; response.end(); } }); return; }
  inLine(response, () => response.destroyed ? undefined : handle(request, response));
}).listen(port, hostname, () => {
  console.info(JSON.stringify({ type: "web.listening", hostname, port, concurrency: limit, ceilingMb: ceiling ? Math.round(ceiling / 1048576) : null }));
});
