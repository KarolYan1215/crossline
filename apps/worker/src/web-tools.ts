import type { SkillTools } from "@crossline/codex";
import type { WebSearchBackend } from "@crossline/connectors";
import { extractText } from "./extract";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";

/**
 * No budget on how much a run looks up (the owner, 2026-11-12: 「不要限制工具使用」), only a guard against a loop: the same query or page
 * asked for again past `REPEATS_ALLOWED` times is refused, and a run past these ceilings is taken to be stuck. They sit far above what any
 * Skill has needed (a diligence report used 12 searches); they exist so a looping model cannot run up the search bill without end.
 */
export const WEB_SEARCHES_PER_RUN = 200;
export const WEB_FETCHES_PER_RUN = 400;
export const REPEATS_ALLOWED = 2;
const PAGE_TEXT_LIMIT = 20_000;

/**
 * `web_search` and `web_fetch` as Codex dynamic tools, for a Skill granted the web while it runs on a provider that has no hosted search
 * (docs/beta-launch.md §10.4). The search goes through the configured search API; a fetch goes through `safeGet` (public https only,
 * re-checked at every redirect, size-capped), the same door every page the Skills cite already passes. Nothing here trusts the model:
 * what a Skill cites is still opened and checked afterwards by its own verifier. Made fresh for each run, so the caps are per run.
 */
export function createWebTools(backend: WebSearchBackend, deps: SafeGetDeps = defaultSafeGetDeps()): SkillTools & { used: () => { searches: number; fetches: number; fetched: string[] } } {
  let searches = 0;
  const fetched: string[] = [];
  const asked = new Map<string, number>();
  /** Counts one more ask of `key`; true when it has now been asked more often than a loop-free run would. */
  const looping = (key: string) => { const times = (asked.get(key) ?? 0) + 1; asked.set(key, times); return times > REPEATS_ALLOWED; };
  return {
    used: () => ({ searches, fetches: fetched.length, fetched: [...fetched] }),
    specs: [
      { name: "web_search", description: "Search the public web. Returns up to 8 results: title, url, snippet, published date.",
        inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: {
          query: { type: "string", description: "What to search for, in the language the pages are likely written in." },
          freshness: { type: "string", enum: ["day", "week", "month", "year"], description: "Only pages from this recent period." } } } },
      { name: "web_fetch", description: "Open one public https page (or PDF) and return its text, up to 20,000 characters.",
        inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" } } } }
    ],
    // The tool's errors are answers to the model, not the person.
    /* i18n-ignore-start */
    async call(name, args) {
      const input = (args ?? {}) as { query?: unknown; freshness?: unknown; url?: unknown };
      if (name === "web_search") {
        if (searches >= WEB_SEARCHES_PER_RUN) throw new Error(`本次运行已搜索 ${WEB_SEARCHES_PER_RUN} 次，像是陷入了循环，请用已有结果作答。`);
        const query = typeof input.query === "string" ? input.query.trim().slice(0, 300) : "";
        if (!query) throw new Error("query 不能为空");
        if (looping(`q:${query.toLowerCase()}`)) throw new Error(`「${query}」已经搜过 ${REPEATS_ALLOWED} 次，换一个查询或用已有结果作答。`);
        searches += 1;
        const freshness = ["day", "week", "month", "year"].includes(String(input.freshness)) ? input.freshness as "day" | "week" | "month" | "year" : undefined;
        const hits = await backend.search(query, { count: 8, ...(freshness ? { freshness } : {}) });
        return JSON.stringify({ query, results: hits });
      }
      if (name === "web_fetch") {
        if (fetched.length >= WEB_FETCHES_PER_RUN) throw new Error(`本次运行已打开 ${WEB_FETCHES_PER_RUN} 个网页，像是陷入了循环，请用已有内容作答。`);
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (looping(`u:${url}`)) throw new Error(`${url} 已经打开过 ${REPEATS_ALLOWED} 次，用已经读到的内容。`);
        const page = await safeGet(url, deps, { maxBytes: 5_000_000, timeoutMs: 20_000 });
        if (!page.ok) throw new Error(`打不开 ${url}：${page.reason}`);
        fetched.push(page.finalUrl);
        const raw = page.contentType === "application/pdf" ? (await extractText(page.bytes, "pdf")).text
          : page.contentType.includes("html") ? htmlToText(new TextDecoder().decode(page.bytes)) : new TextDecoder().decode(page.bytes);
        const title = page.contentType.includes("html") ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(new TextDecoder().decode(page.bytes))?.[1]?.trim().slice(0, 200) ?? "" : "";
        return JSON.stringify({ url: page.finalUrl, title, text: raw.slice(0, PAGE_TEXT_LIMIT), truncated: raw.length > PAGE_TEXT_LIMIT });
      }
      throw new Error(`没有名为 ${name} 的工具`);
    }
    /* i18n-ignore-end */
  };
}
