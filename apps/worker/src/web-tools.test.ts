import type { WebSearchBackend } from "@crossline/connectors";
import { expect, test } from "vitest";
import { createWebTools, REPEATS_ALLOWED, WEB_SEARCHES_PER_RUN } from "./web-tools";

const backend: WebSearchBackend = { id: "fake", search: async (query) => [{ title: query, url: "https://example.com/a", snippet: "s" }] };
const page = (async () => new Response("<html><title>Page A</title><body><p>WAL default is 1000 pages.</p><script>x()</script></body></html>",
  { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;

test("web_search answers from the backend, refuses a query repeated past the loop guard, and stops only at the loop ceiling", async () => {
  const tools = createWebTools(backend, { fetchImpl: page, isPublicHost: async () => true });
  expect(JSON.parse(await tools.call("web_search", { query: "wal" }))).toEqual({ query: "wal", results: [{ title: "wal", url: "https://example.com/a", snippet: "s" }] });
  for (let i = 1; i < REPEATS_ALLOWED; i += 1) await tools.call("web_search", { query: "WAL" });
  await expect(tools.call("web_search", { query: "wal" })).rejects.toThrow(/已经搜过/);
  // Far more distinct lookups than any old per-run budget allowed are fine.
  for (let i = 0; i < 40; i += 1) await tools.call("web_search", { query: `q${i}` });
  expect(tools.used().searches).toBe(REPEATS_ALLOWED + 40);
  for (let i = 40; tools.used().searches < WEB_SEARCHES_PER_RUN; i += 1) await tools.call("web_search", { query: `q${i}` });
  await expect(tools.call("web_search", { query: "one more" })).rejects.toThrow(/陷入了循环/);
});

test("web_fetch returns the page's text and title, records what was opened, and refuses a private address", async () => {
  const tools = createWebTools(backend, { fetchImpl: page, isPublicHost: async (host) => host !== "intranet.example.com" });
  const fetched = JSON.parse(await tools.call("web_fetch", { url: "https://example.com/a" })) as { url: string; title: string; text: string };
  expect(fetched).toMatchObject({ url: "https://example.com/a", title: "Page A" });
  expect(fetched.text).toContain("WAL default is 1000 pages.");
  expect(fetched.text).not.toContain("x()");
  expect(tools.used().fetched).toEqual(["https://example.com/a"]);
  await expect(tools.call("web_fetch", { url: "https://intranet.example.com/" })).rejects.toThrow(/非公开地址/);
  await expect(tools.call("web_fetch", { url: "http://example.com/" })).rejects.toThrow();
});
