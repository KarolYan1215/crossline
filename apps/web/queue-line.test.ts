import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BUSY_BODY, createLine } from "./queue-line.mjs";

/** Enough of a ServerResponse for the line: status, headers, end, close. */
class FakeResponse extends EventEmitter {
  statusCode = 200; headers: Record<string, string> = {}; body = ""; headersSent = false; destroyed = false; writableEnded = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  end(body?: string) { this.body = body ?? ""; this.writableEnded = true; this.emit("finish"); this.emit("close"); return this; }
  leave() { this.destroyed = true; this.emit("close"); }
}
const fakeResponse = () => new FakeResponse();
const asResponse = (response: FakeResponse) => response as unknown as ServerResponse;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test("a full line answers 503 at once, a page waiting too long is answered 503, and one who leaves frees their place", async () => {
  const line = createLine({ limit: 1, maxQueued: 2, maxWaitMs: 30_000 });
  const rendering = fakeResponse();
  line.inLine({ url: "/" }, asResponse(rendering), () => undefined);
  const a = fakeResponse(), b = fakeResponse(), c = fakeResponse();
  line.inLine({ url: "/plan" }, asResponse(a), () => a.end("a"));
  line.inLine({ url: "/tasks" }, asResponse(b), () => b.end("b"));
  expect(line.state()).toEqual({ active: 1, waiting: 2 });

  line.inLine({ url: "/milestones" }, asResponse(c), () => c.end("c"));
  expect(c.statusCode).toBe(503);
  expect(c.headers["retry-after"]).toBe("5");
  expect(c.body).toBe(BUSY_BODY);

  // A person who closes the tab while waiting leaves the line; the rest keep their place.
  a.leave();
  expect(line.state()).toEqual({ active: 1, waiting: 1 });

  await vi.advanceTimersByTimeAsync(30_001);
  expect(b.statusCode).toBe(503);
  expect(line.state()).toEqual({ active: 1, waiting: 0 });

  // The render in flight finishing frees its slot; the next page is served at once.
  rendering.end("done");
  const d = fakeResponse();
  line.inLine({ url: "/" }, asResponse(d), () => d.end("d"));
  await vi.advanceTimersByTimeAsync(0);
  expect(d.body).toBe("d");
  expect(line.state()).toEqual({ active: 0, waiting: 0 });
});

test("a page whose turn comes in time is served, not timed out", async () => {
  const line = createLine({ limit: 1, maxQueued: 5, maxWaitMs: 30_000 });
  const first = fakeResponse();
  line.inLine({ url: "/" }, asResponse(first), () => undefined);
  const second = fakeResponse();
  line.inLine({ url: "/" }, asResponse(second), () => second.end("ok"));
  await vi.advanceTimersByTimeAsync(10_000);
  first.end("first");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(second.statusCode).toBe(200);
  expect(second.body).toBe("ok");
});

test("a page someone opened goes before pages the router fetched ahead on hover", async () => {
  const line = createLine({ limit: 1, maxQueued: 5, maxWaitMs: 30_000 });
  const rendering = fakeResponse();
  line.inLine({ url: "/" }, asResponse(rendering), () => undefined);
  const served: string[] = [];
  const prefetch = fakeResponse(), opened = fakeResponse();
  line.inLine({ url: "/plan", headers: { "next-router-prefetch": "1" } }, asResponse(prefetch), () => { served.push("prefetch"); prefetch.end(); });
  line.inLine({ url: "/workbench" }, asResponse(opened), () => { served.push("opened"); opened.end(); });
  rendering.end("done");
  await vi.advanceTimersByTimeAsync(0);
  expect(served).toEqual(["opened", "prefetch"]);
});
