import { expect, test } from "vitest";
import { bochaSearch, tavilySearch, webSearchFromEnv } from "./web-search";

const answering = (body: unknown, seen: Array<{ url: string; init: RequestInit | undefined }> = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;

test("Bocha: key in the header only, results read from data.webPages.value, non-https results dropped", async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const backend = bochaSearch("secret-key", answering({ data: { webPages: { value: [
    { name: "SQLite WAL", url: "https://sqlite.org/wal.html", summary: "default 1000 pages", datePublished: "2025-01-01", siteName: "SQLite" },
    { name: "plain", url: "http://example.com", summary: "x" }] } } }, seen));
  const hits = await backend.search("wal autocheckpoint", { freshness: "year" });
  expect(hits).toEqual([{ title: "SQLite WAL", url: "https://sqlite.org/wal.html", snippet: "default 1000 pages", published: "2025-01-01", site: "SQLite" }]);
  expect(seen[0]!.url).toBe("https://api.bochaai.com/v1/web-search");
  expect(JSON.parse(String(seen[0]!.init?.body))).toMatchObject({ query: "wal autocheckpoint", freshness: "oneYear", summary: true });
  expect(String(seen[0]!.init?.body)).not.toContain("secret-key");
});

test("Tavily: results read from results[]", async () => {
  const hits = await tavilySearch("k", answering({ results: [{ title: "HiGHS", url: "https://highs.dev", content: "Edinburgh" }] })).search("highs");
  expect(hits).toEqual([{ title: "HiGHS", url: "https://highs.dev", snippet: "Edinburgh" }]);
});

test("a refusal names the status, never the key; no key means no backend", async () => {
  const failing = (async () => new Response("quota exhausted", { status: 429 })) as typeof fetch;
  await expect(bochaSearch("secret-key", failing).search("x")).rejects.toThrow(/SEARCH_API_429: quota exhausted/);
  expect(webSearchFromEnv({})).toBeUndefined();
  expect(webSearchFromEnv({ TAVILY_API_KEY: "t" })?.id).toBe("tavily");
  expect(webSearchFromEnv({ CROSSLINE_SEARCH_PROVIDER: "tavily", BOCHA_API_KEY: "b" })).toBeUndefined();
});
