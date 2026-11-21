/**
 * New papers from arXiv (docs/plans/attention-ledger-1120.md §7.3, batch 6, 2026-11-21): the public read-only API, no account and no
 * login. Its metadata is CC0; its terms ask for one request every three seconds (the worker paces it). Semantic Scholar is not used: its
 * API licence does not allow commercial use without a separate agreement (§八). Pure here: the URL and the Atom feed's reading.
 */
export const ARXIV_API = "https://export.arxiv.org/api/query";
/** arXiv asks for no more than one request every three seconds. */
export const ARXIV_PACE_MS = 3_000;
/** A paper older than this is not new to anyone watching the field. */
export const ARXIV_MAX_AGE_DAYS = 30;

export type ArxivPaper = { url: string; title: string; authors: string[]; published: string; summary: string };

/** The newest submissions matching `query` (arXiv's `search_query` syntax, e.g. `all:"spiking neural network" AND cat:cs.NE`). */
export const arxivQueryUrl = (query: string, max = 10) =>
  `${ARXIV_API}?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${max}`;

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_whole, name: string) =>
  name.startsWith("#x") || name.startsWith("#X") ? String.fromCodePoint(parseInt(name.slice(2), 16))
    : name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : XML_ENTITIES[name.toLowerCase()] ?? "");
const squash = (text: string) => unescape(text).replace(/\s+/g, " ").trim();
const field = (entry: string, tag: string) => squash(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(entry)?.[1] ?? "");

/** The feed's entries published in the last `ARXIV_MAX_AGE_DAYS`, as https links to their abstract pages. */
export function parseArxivFeed(xml: string, now: Date, maxAgeDays = ARXIV_MAX_AGE_DAYS): ArxivPaper[] {
  const since = now.getTime() - maxAgeDays * 86_400_000;
  const out: ArxivPaper[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    if (!entry) continue;
    const id = field(entry, "id");
    const published = field(entry, "published");
    const title = field(entry, "title");
    if (!/^https?:\/\/arxiv\.org\/abs\//i.test(id) || !title || !(Date.parse(published) >= since)) continue;
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((match) => squash(match[1] ?? "")).filter(Boolean);
    out.push({ url: id.replace(/^http:/i, "https:"), title, authors, published: published.slice(0, 10), summary: field(entry, "summary") });
  }
  return out;
}

/** What the reader is given for one paper: its own words only. */
export const arxivPageText = (paper: ArxivPaper) =>
  [paper.title, paper.authors.slice(0, 8).join(", "), `arXiv ${paper.published}`, paper.summary].filter(Boolean).join("\n");
