import type { WebSearchBackend } from "@crossline/connectors";
import { expect, test } from "vitest";
import { createWebTools, WEB_SEARCHES_PER_RUN } from "./web-tools";

const backend: WebSearchBackend = { id: "fake", search: async (query) => [{ title: query, url: "https://example.com/a", snippet: "s" }] };
const page = (async () => new Response("<html><title>Page A</title><body><p>WAL default is 1000 pages.</p><script>x()</script></body></html>",
  { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;

test("web_search answers from the backend and stops at the per-run cap", async () => {
  const tools = createWebTools(backend, { fetchImpl: page, isPublicHost: async () => true });
  expect(JSON.parse(await tools.call("web_search", { query: "wal" }))).toEqual({ query: "wal", results: [{ title: "wal", url: "https://example.com/a", snippet: "s" }] });
  for (let i = 1; i < WEB_SEARCHES_PER_RUN; i += 1) await tools.call("web_search", { query: "q" });
  await expect(tools.call("web_search", { query: "one more" })).rejects.toThrow(/搜索次数已用完/);
  expect(tools.used().searches).toBe(WEB_SEARCHES_PER_RUN);
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
