import type { SkillTools } from "@crossline/codex";
import type { WebSearchBackend } from "@crossline/connectors";
import { extractText } from "./extract";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";

/** Per run: enough for a diligence report, few enough that a looping model cannot run up the search bill. */
export const WEB_SEARCHES_PER_RUN = 12;
export const WEB_FETCHES_PER_RUN = 24;
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
        if (searches >= WEB_SEARCHES_PER_RUN) throw new Error(`本次运行的搜索次数已用完（${WEB_SEARCHES_PER_RUN} 次），请用已有结果作答。`);
        const query = typeof input.query === "string" ? input.query.trim().slice(0, 300) : "";
        if (!query) throw new Error("query 不能为空");
        searches += 1;
        const freshness = ["day", "week", "month", "year"].includes(String(input.freshness)) ? input.freshness as "day" | "week" | "month" | "year" : undefined;
        const hits = await backend.search(query, { count: 8, ...(freshness ? { freshness } : {}) });
        return JSON.stringify({ query, results: hits });
      }
      if (name === "web_fetch") {
        if (fetched.length >= WEB_FETCHES_PER_RUN) throw new Error(`本次运行打开网页的次数已用完（${WEB_FETCHES_PER_RUN} 次）。`);
        const url = typeof input.url === "string" ? input.url.trim() : "";
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
