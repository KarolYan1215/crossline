/**
 * Putting into a model's context only what the task at hand needs (docs/context-selection.md, decided 2026-10-20: 「把且只把当前任务需要的
 * 用户或者系统的信息放进上下文，而不是单纯搜索，要和模型结合在一起」). Two halves: code proposes candidates for the task — the structured
 * items that obviously belong (the project's and the line's facts, dates, answers, the planning profile) and file passages found by full-text
 * search — and the model, given the candidates' headings and one line each plus the few strongest in full, reads further through its
 * own lookups (`search_material`, `read_chunk`). Before this the step planner was handed the project's files cut blind at 16k each and
 * 48k in all, and the capture analysis the opening 300 characters of the first eight files uploaded, whatever the capture was about.
 *
 * Pure: chunking, query terms and budgets. The index (`doc_chunks`, an FTS5 trigram table) lives in packages/db.
 */

/** A file passage aims at about this many characters: long enough to carry a problem or a lecture's topic list, short enough to cite. */
export const CHUNK_TARGET_CHARS = 800;

/** Budgets, in characters of what is sent (the model's lookups answer within `MATERIAL_TOOL_BUDGET` per run). */
export const CONTEXT_BUDGETS = {
  /** Step planner with lookups: the candidate list (heading + one line each). */
  candidates: 3_600,
  /** Step planner with lookups: the strongest passages in full. */
  topFull: 4_000,
  /** Step planner on a route that cannot call functions: the passages code picked, in full, instead of the lookups. */
  noTools: 16_000,
  /** The project's and the line's facts handed to the step planner and the backplanner. */
  facts: 6_000,
  /** Capture analysis: the passages that match the capture (each clipped to `analysisPassage`). */
  analysis: 4_200,
  analysisPassage: 700,
  /** Backplanner and milestone architect: a line's or a milestone's passages as excerpts. */
  excerpts: 3_000,
  excerpt: 280
} as const;

/** What the lookups may return in one run, summed: past it they say so and the model plans with what it has. */
export const MATERIAL_TOOL_BUDGET = 30_000;

export type TextChunk = { start: number; text: string };

/**
 * Cuts a document's text into passages of about `target` characters, at the best boundary between 60% and 100% of it: a blank line,
 * else a line end, else a sentence end, else a comma or space; a hard cut only when the text has none. A tail of up to a quarter more
 * than `target` stays with the last passage. Leading whitespace is skipped; `start` is where the passage begins in the original text.
 */
export function chunkText(text: string, target = CHUNK_TARGET_CHARS): TextChunk[] {
  const chunks: TextChunk[] = [];
  const n = text.length;
  let pos = 0;
  const boundaries = [/\n[ \t\r]*\n/g, /\n/g, /[。！？!?；;]|\.(?=\s)/g, /[，,、 \t]/g];
  while (pos < n) {
    while (pos < n && /\s/.test(text[pos]!)) pos += 1;
    if (pos >= n) break;
    if (n - pos <= target * 1.25) { chunks.push({ start: pos, text: text.slice(pos).trimEnd() }); break; }
    const lo = pos + Math.floor(target * 0.6), hi = pos + target;
    const window = text.slice(lo, hi);
    let cut = -1;
    for (const pattern of boundaries) {
      let last = -1;
      for (const match of window.matchAll(pattern)) last = (match.index ?? 0) + match[0].length;
      if (last > 0) { cut = lo + last; break; }
    }
    if (cut < 0) cut = hi;
    const piece = text.slice(pos, cut).trimEnd();
    if (piece) chunks.push({ start: pos, text: piece });
    pos = cut;
  }
  return chunks;
}

const STOP_LATIN = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "are", "was", "you", "your", "not", "but", "all",
  "any", "can", "has", "have", "will", "its", "our", "per", "via", "one", "two", "who", "how", "what", "when", "use", "using"]);
/** Two-character words that name no subject (every task 「完成」 and 「整理」 something). */
const STOP_HAN2 = new Set(["完成", "整理", "准备", "进行", "相关", "一下", "任务", "步骤", "本人", "我们", "这个", "那个", "需要", "可以", "以及",
  "一个", "没有", "已经", "如果", "因为", "所以", "什么", "怎么", "时候", "内容", "根据", "按照", "通过", "提交", "材料", "资料", "文件"]);
/** Characters a Chinese phrase is split at before its windows are taken: function words carry nothing to search by. */
const HAN_SPLIT = /[的了和与及在是把被对为等或并且也就都而之其从向给让于]/u;

export type SearchTerms = {
  /** Three characters or more: matched through the trigram index. */
  long: string[];
  /** Two characters (「组会」, 「HW」): too short for a trigram, matched by LIKE. */
  short: string[];
};

/**
 * The terms a query is searched by. Latin words and numbers whole (a letter–digit mix like `ece555` also as its parts, so 「ECE 555」
 * matches); a Chinese phrase split at function words, then whole when three or four characters long, else as its three-character
 * windows, whose summed scores rank a passage holding the whole phrase above one holding a fragment. Two-character words go to `short`.
 */
export function searchTerms(query: string, max = 32): SearchTerms {
  const long: string[] = [], short: string[] = [];
  const add = (list: string[], term: string) => { if (!list.includes(term)) list.push(term); };
  const text = query.toLowerCase();
  for (const match of text.matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    const parts = /[a-z]/.test(token) && /\d/.test(token) ? [token, ...(token.match(/[a-z]+|\d+/g) ?? [])] : [token];
    for (const part of parts) {
      if (STOP_LATIN.has(part)) continue;
      if (part.length >= 3) add(long, part);
      else if (part.length === 2 && /[a-z]/.test(part)) add(short, part);
    }
  }
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    for (const run of match[0].split(HAN_SPLIT)) {
      if (run.length === 2) { if (!STOP_HAN2.has(run)) add(short, run); continue; }
      if (run.length < 2) continue;
      if (run.length <= 4) { add(long, run); continue; }
      for (let at = 0; at + 3 <= run.length; at += 1) add(long, run.slice(at, at + 3));
    }
  }
  return { long: long.slice(0, max), short: short.slice(0, 8) };
}

/** The FTS5 MATCH expression for the long terms: each a quoted phrase, any of them. Empty when there are none. */
export function ftsMatchExpression(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR ");
}

/** How many of the query's terms a text contains: the cheap relevance code ranks structured items (facts) by. */
export function termHits(text: string, terms: SearchTerms): number {
  const lower = text.toLowerCase();
  return [...terms.long, ...terms.short].filter((term) => lower.includes(term)).length;
}

/** The first `limit` characters of a passage on one line: what a candidate is listed with. */
export function oneLine(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Items in order while they fit the budget (an item longer than what is left is skipped, a shorter later one may still fit). */
export function withinBudget<T>(items: T[], size: (item: T) => number, budget: number): T[] {
  const kept: T[] = [];
  let left = budget;
  for (const item of items) {
    const cost = size(item);
    if (cost > left) continue;
    kept.push(item);
    left -= cost;
  }
  return kept;
}
