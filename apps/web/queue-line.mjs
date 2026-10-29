/**
 * The line page renders wait in (queue-server.mjs), kept apart so it can be tested without starting Next. Pages go before polls; a
 * person who leaves while waiting leaves the line at once; a slot is never held past `slotMaxMs`. The line is also bounded: past
 * `maxQueued` waiting, or after `maxWaitMs` in it, a request is answered 503 with `Retry-After` instead of waiting without end — a burst
 * that outruns the renders used to grow the line (and the memory each waiting socket holds) until the container was killed.
 */
export const BUSY_BODY = "页面正忙，请稍后几秒再刷新。\n";

export function busy(response) {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "5", "cache-control": "no-store" });
  response.end(BUSY_BODY);
}

export function createLine({ limit, memoryHigh = () => false, maxQueued = 50, maxWaitMs = 30_000, slotMaxMs = 120_000,
  record = () => {}, log = () => {}, routeOf = (url) => (url ?? "/").split("?")[0] }) {
  let active = 0;
  /** Two lines, kept for routes that may queue later: pages first, then anything polled. */
  const lines = { page: [], poll: [] };
  let timer;
  let logged = 0;
  const waiting = () => lines.page.length + lines.poll.length;

  function pump() {
    while (waiting() && active < limit) {
      if (memoryHigh() && active > 0) { if (!timer) timer = setTimeout(() => { timer = undefined; pump(); }, 250); return; }
      const next = lines.page.shift() ?? lines.poll.shift();
      active += 1;
      next();
    }
  }

  /** Runs `work` once a slot is free and frees the slot when the response ends or the person goes away. */
  function inLine(request, response, work) {
    const queuedAt = Date.now();
    const route = routeOf(request.url);
    // A request the router marks as a prefetch (`next-router-prefetch`: the route tree it asks for when a link is hovered, 2026-10-28)
    // waits behind a page someone opened.
    const kind = route.startsWith("/api/") || request.headers?.["next-router-prefetch"] ? "poll" : "page";
    // A full line: told to come back rather than added to it (a free slot still takes the request at once).
    if (active >= limit && waiting() >= maxQueued) {
      log({ type: "web.queue_full", waiting: waiting(), active });
      busy(response);
      return;
    }
    let started = false;
    let expiry;
    const leave = () => {
      const at = lines[kind].indexOf(turn);
      if (at >= 0) lines[kind].splice(at, 1);
    };
    const turn = () => {
      started = true;
      clearTimeout(expiry);
      let freed = false;
      const startedAt = Date.now();
      const free = () => {
        if (freed) return;
        freed = true; active -= 1;
        clearTimeout(watchdog);
        record(route, startedAt - queuedAt, Date.now() - startedAt);
        pump();
      };
      const watchdog = setTimeout(free, slotMaxMs);
      watchdog.unref?.();
      // Gone while waiting (a closed tab, a timed-out client): nothing to render, the slot goes straight back.
      if (response.destroyed || response.writableEnded) { free(); return; }
      response.once("close", free);
      response.once("finish", free);
      const waited = startedAt - queuedAt;
      // A wait worth knowing about, at most once a minute so a busy minute is one line.
      if (waited > 2_000 && Date.now() - logged > 60_000) {
        logged = Date.now();
        log({ type: "web.queue", waitedMs: waited, waiting: waiting(), active });
      }
      Promise.resolve().then(work).catch((error) => {
        log({ type: "web.request_failed", error: error instanceof Error ? error.message : String(error) });
        if (!response.headersSent && !response.destroyed) { response.statusCode = 500; response.end(); }
        free();
      });
    };
    lines[kind].push(turn);
    expiry = setTimeout(() => {
      if (started) return;
      leave();
      log({ type: "web.queue_timeout", waitedMs: Date.now() - queuedAt });
      busy(response);
    }, maxWaitMs);
    expiry.unref?.();
    response.once("close", () => {
      if (started) return;
      clearTimeout(expiry);
      leave();
    });
    pump();
  }

  return { inLine, state: () => ({ active, waiting: waiting() }) };
}
