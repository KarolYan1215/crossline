/**
 * Web search for runs on a model provider other than the person's own Codex sign-in (docs/beta-launch.md §10.4). OpenAI's hosted
 * `web_search` exists only on a ChatGPT sign-in or an OpenAI key, so on any other model Crossline searches itself, through one of these
 * search APIs, and hands the results to the model as a tool answer. The model never gets the key and never reaches the search API.
 *
 * Chosen from the environment: `CROSSLINE_SEARCH_PROVIDER` = `bocha` | `tavily`, with that provider's key in `BOCHA_API_KEY` /
 * `TAVILY_API_KEY`. With neither, there is no backend and those Skills stay on the Codex sign-in, as before.
 */
export type SearchHit = { title: string; url: string; snippet: string; published?: string; site?: string };
export type SearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchBackend {
  readonly id: string;
  search(query: string, options?: { count?: number; freshness?: SearchFreshness; signal?: AbortSignal }): Promise<SearchHit[]>;
}

type Fetch = typeof fetch;
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const httpsOnly = (hits: SearchHit[]) => hits.filter((hit) => hit.title && /^https:\/\//i.test(hit.url));

async function postJson(fetchImpl: Fetch, url: string, key: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) {
    // The body names the cause (quota, a bad parameter); it never carries the key. Keep it short.
    const detail = (await response.text().catch(() => "")).slice(0, 160);
    throw new Error(`SEARCH_API_${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

/** 博查 (Bocha) Web Search: `POST /v1/web-search`, `{query, summary, freshness, count}`, results in `data.webPages.value`. */
export function bochaSearch(apiKey: string, fetchImpl: Fetch = fetch): WebSearchBackend {
  const FRESHNESS: Record<SearchFreshness, string> = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };
  return {
    id: "bocha",
    async search(query, options = {}) {
      const json = await postJson(fetchImpl, "https://api.bochaai.com/v1/web-search", apiKey, {
        query, summary: true, count: Math.min(10, Math.max(1, options.count ?? 8)), freshness: options.freshness ? FRESHNESS[options.freshness] : "noLimit"
      }, options.signal) as { data?: { webPages?: { value?: Array<Record<string, unknown>> } } };
      return httpsOnly((json.data?.webPages?.value ?? []).map((item) => ({
        title: text(item.name, 200), url: text(item.url, 2000), snippet: text(item.summary, 600) || text(item.snippet, 600),
        ...(text(item.datePublished, 40) ? { published: text(item.datePublished, 40) } : {}),
        ...(text(item.siteName, 80) ? { site: text(item.siteName, 80) } : {})
      })));
    }
  };
}

/** Tavily: `POST /search`, `{query, max_results, search_depth, time_range}`, results in `results`. */
export function tavilySearch(apiKey: string, fetchImpl: Fetch = fetch): WebSearchBackend {
  return {
    id: "tavily",
    async search(query, options = {}) {
      const json = await postJson(fetchImpl, "https://api.tavily.com/search", apiKey, {
        query, max_results: Math.min(10, Math.max(1, options.count ?? 8)), search_depth: "basic",
        ...(options.freshness ? { time_range: options.freshness } : {})
      }, options.signal) as { results?: Array<Record<string, unknown>> };
      return httpsOnly((json.results ?? []).map((item) => ({
        title: text(item.title, 200), url: text(item.url, 2000), snippet: text(item.content, 600),
        ...(text(item.published_date, 40) ? { published: text(item.published_date, 40) } : {})
      })));
    }
  };
}

/** The backend the environment names, or undefined. */
export function webSearchFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl: Fetch = fetch): WebSearchBackend | undefined {
  const choice = env.CROSSLINE_SEARCH_PROVIDER?.trim().toLowerCase() || (env.BOCHA_API_KEY?.trim() ? "bocha" : env.TAVILY_API_KEY?.trim() ? "tavily" : "");
  if (choice === "bocha" && env.BOCHA_API_KEY?.trim()) return bochaSearch(env.BOCHA_API_KEY.trim(), fetchImpl);
  if (choice === "tavily" && env.TAVILY_API_KEY?.trim()) return tavilySearch(env.TAVILY_API_KEY.trim(), fetchImpl);
  return undefined;
}
