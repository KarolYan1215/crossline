/**
 * What an opportunity is and which lines it serves (owner's decision 2026-11-10, docs/opportunity-agent.md §18). The reader, the needs
 * derivation and the weekly scout each hand back, as structured output, a type tag, the lines it may serve — each with a confidence, a
 * one-sentence reason and the goal or milestones it rests on — and one sentence on why it is worth the person's time. Code then judges
 * each line's claim again against that line's long-term goal, milestones and watches (`relevanceOf`), keeps the lines that hold up,
 * ranks them, and decides whether the find is pushed as a card (`pushable`) or waits for the weekly review's 视野外.
 *
 * Why lexical overlap and not embeddings: the only embedding model on the machine is the voiceprint one; a multilingual text encoder
 * would be a ~100 MB download and a second model whose judgement is as opaque as the first. The check here only has to catch a model
 * claiming a line with nothing to show for it, and the line's own watches (whose queries are search words, mostly in the page's
 * language) bridge a Chinese goal and an English page. Every step is a number a test can pin.
 */
import type { Opportunity } from "./opportunity";

export const OPPORTUNITY_TYPES = ["competition", "conference", "internship", "scholarship", "program", "talk", "event", "social", "job", "grant", "other"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];
export const OPPORTUNITY_TYPE_LABEL: Record<OpportunityType, string> = {
  competition: "比赛", conference: "会议", internship: "实习", scholarship: "奖学金", program: "项目申请", talk: "讲座", event: "活动",
  social: "社交", job: "工作", grant: "资助", other: "其他"
};

/** A line the find may serve: the model's confidence, code's relevance, why, and what on the line it rests on. */
export type OpportunityLineTag = {
  lineId: string;
  /** The model's own confidence, 0–1, as it gave it. */
  confidence: number;
  /** Code's judgement, 0–1 (`relevanceOf`): what ranking and pushing use. */
  relevance: number;
  /** One sentence, the model's: how it serves this line. */
  reason: string;
  /** Milestone ids of the line, or `goal`, that the reason rests on; ids not on the line are dropped by code. */
  anchors: string[];
  /** Carried over from a row read before tags existed (migration 24): one line, no model confidence. */
  migrated?: true | undefined;
};

/** The classification a reader, the scout or the needs derivation gives back for one find (schema below). */
export type RawClassification = {
  type: string;
  reason: string;
  lines: Array<{ lineId: string; confidence: number; reason: string; anchors: string[] }>;
};

/** Model-facing schema fragment, merged into the reader's item and the scout's file. */
export const CLASSIFICATION_PROPERTIES = {
  type: { type: "string", enum: [...OPPORTUNITY_TYPES] },
  reason: { type: "string", maxLength: 160 },
  lines: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["lineId", "confidence", "reason", "anchors"], properties: {
    lineId: { type: "string", maxLength: 80 }, confidence: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string", maxLength: 160 },
    anchors: { type: "array", maxItems: 6, items: { type: "string", maxLength: 160 } } } } }
} as const;
export const CLASSIFICATION_REQUIRED = ["type", "reason", "lines"] as const;

/* i18n-ignore-start: model-facing */
export const CLASSIFICATION_INSTRUCTIONS = "Tag each item: type (competition, conference, internship, scholarship, program for a programme one applies to, "
  + "talk for a lecture or seminar, event, social for a mixer, coffee hour, dance, gala, happy hour or any gathering whose point is meeting people, "
  + "job, grant, other); reason, one sentence on why it is worth this person's time; lines, every given line it serves (none is valid), each with "
  + "a confidence from 0 to 1, a one-sentence reason and anchors: the ids of that line's milestones it moves, or \"goal\" for the long-term goal "
  + "itself. Be strict: a confidence of 0.6 or more means the person would want to hear about it for that line today.";
/* i18n-ignore-end */

/** A line as code judges relevance against it: its goal, its live milestones and its watches' words. */
export type LineBrief = { id: string; name: string; goal: string; milestones: Array<{ id: string; title: string }>; watches: Array<{ title: string; query: string }> };

/** A find is pushed as a card at this relevance or above; below, it waits for the weekly review's 视野外. */
export const PUSH_RELEVANCE = 0.6;
/** A line tag under this is dropped altogether. */
export const KEEP_RELEVANCE = 0.25;
/** A type the person asked for less of (少来这类) still comes when it is this relevant to a line (a social type never does). */
export const QUIET_TYPE_RELEVANCE = 0.8;

// i18n-ignore-start: words matched against pages and goals, never shown
const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "your", "you", "are", "will", "our", "all", "into", "about", "more", "new",
  "event", "events", "join", "open", "apply", "application", "applications", "program", "programs", "2025", "2026", "2027", "2028", "free", "register",
  "registration", "deadline", "students", "student", "university", "online", "day", "week", "year", "one", "can", "how", "what", "who", "its", "their",
  "near", "track", "line", "goal", "goals", "watch", "find", "look", "looking", "page", "pages", "list", "lists"]);
const CJK_STOP = new Set(["一个", "我们", "可以", "进行", "以及", "相关", "活动", "报名", "申请", "截止", "时间", "地点", "欢迎", "参加", "目标", "主线", "成为", "长期"]);
// i18n-ignore-end
const stem = (word: string) => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

/** Words of a text as code compares them: Latin words (lower-cased, plural stripped, stop words out) and CJK bigrams. */
export function tagTerms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) {
    const clean = stem(word.replace(/[.-]+$/, ""));
    if (clean.length >= 3 && !STOP.has(clean)) out.add(clean);
  }
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!CJK_STOP.has(pair)) out.add(pair);
    }
  }
  return out;
}

/** A line's words: goal, milestone titles and its watches' titles and queries. */
export const lineTerms = (line: LineBrief): Set<string> =>
  tagTerms([line.name, line.goal, ...line.milestones.map((item) => item.title), ...line.watches.flatMap((watch) => [watch.title, watch.query])].join("\n"));

/** How much of the find's own words the line shares, 0–1: four shared words or more is full overlap. */
export function overlapOf(findText: string, line: LineBrief): number {
  const find = tagTerms(findText);
  const mine = lineTerms(line);
  let shared = 0;
  for (const term of find) if (mine.has(term)) shared += 1;
  return Math.min(1, shared / 4);
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Code's relevance of one claimed line (owner's decision 2026-11-10 item 1). The model's confidence is the start. A claim on a line
 * the find did not come through must rest on something real there (a live milestone id, or the goal of a line that has one) — else it is
 * capped at 0.45 — and share a word with the line — else it is capped at 0.5. Through the line's own watch, the watch (derived from the
 * goal and milestones, kept by the person) is the anchor and adds 0.1. Overlap then moves it by up to ±0.1 around the middle.
 */
export function relevanceOf(input: { confidence: number; anchors: string[]; line: LineBrief; findText: string; viaLine?: string | undefined }): { relevance: number; anchors: string[] } {
  const ids = new Set(input.line.milestones.map((item) => item.id));
  const anchors = input.anchors.filter((anchor) => ids.has(anchor) || (anchor === "goal" && input.line.goal.trim().length > 0));
  const overlap = overlapOf(input.findText, input.line);
  const own = input.viaLine === input.line.id;
  let score = clamp01(input.confidence);
  if (!anchors.length && !own) score = Math.min(score, 0.45);
  if (overlap === 0 && !own) score = Math.min(score, 0.5);
  score = score + (overlap - 0.5) * 0.2 + (own ? 0.1 : 0);
  return { relevance: round2(clamp01(score)), anchors };
}

/** What the find's own words are for the overlap: its title, organizer, the model's reason and the page's first lines. */
export const findTextOf = (opportunity: Pick<Opportunity, "title" | "organizer">, extra = "") => `${opportunity.title}\n${opportunity.organizer}\n${extra}`;

export type Classified = { type: OpportunityType; reason: string; lines: OpportunityLineTag[]; lowValue?: "social" | undefined };

/**
 * One find's classification, judged by code: unknown lines dropped, each claim's relevance computed, tags under `KEEP_RELEVANCE` left
 * out, the rest ranked. The line of the watch that found it is kept even when the model did not name it (at its computed relevance, so a
 * find the model thinks belongs elsewhere simply ranks low there). A social gathering not tied to a line whose goal is meeting people in
 * its field is marked `lowValue` (item 2).
 */
export function classifyFind(raw: Partial<RawClassification> | undefined, input: { lines: LineBrief[]; title: string; organizer: string; pageText?: string;
  viaLine?: string | undefined; fallbackType?: OpportunityType | undefined }): Classified {
  const known = new Map(input.lines.map((line) => [line.id, line]));
  const type = (OPPORTUNITY_TYPES as readonly string[]).includes(raw?.type ?? "") ? raw!.type as OpportunityType : input.fallbackType ?? "other";
  const reason = (raw?.reason ?? "").trim().slice(0, 160);
  const findText = findTextOf(input, `${reason}\n${(input.pageText ?? "").slice(0, 600)}`);
  const claims = new Map<string, { confidence: number; reason: string; anchors: string[] }>();
  for (const claim of raw?.lines ?? []) {
    if (!claim || !known.has(claim.lineId) || claims.has(claim.lineId)) continue;
    claims.set(claim.lineId, { confidence: clamp01(claim.confidence), reason: (claim.reason ?? "").trim().slice(0, 160), anchors: Array.isArray(claim.anchors) ? claim.anchors : [] });
  }
  if (input.viaLine && known.has(input.viaLine) && !claims.has(input.viaLine)) claims.set(input.viaLine, { confidence: 0.5, reason: "", anchors: [] });
  const lines: OpportunityLineTag[] = [...claims.entries()].map(([lineId, claim]) => {
    const judged = relevanceOf({ confidence: claim.confidence, anchors: claim.anchors, line: known.get(lineId)!, findText, viaLine: input.viaLine });
    return { lineId, confidence: round2(claim.confidence), relevance: judged.relevance, reason: claim.reason, anchors: judged.anchors };
  }).filter((tag) => tag.relevance >= KEEP_RELEVANCE).sort((a, b) => b.relevance - a.relevance || a.lineId.localeCompare(b.lineId));
  const signs = socialSigns(`${input.title}\n${input.organizer}`).length > 0;
  const final: OpportunityType = signs && !SOCIAL_KEEPS_TYPE.has(type) ? "social" : type;
  const tied = lines.some((tag) => tag.relevance >= PUSH_RELEVANCE && networkingLine(known.get(tag.lineId)!));
  return { type: final, reason, lines, ...(final === "social" && !tied ? { lowValue: "social" as const } : {}) };
}
/** Types a social word in passing does not turn into a social gathering (a competition with a mixer is still a competition). */
const SOCIAL_KEEPS_TYPE = new Set<OpportunityType>(["competition", "conference", "internship", "scholarship", "program", "job", "grant"]);

// i18n-ignore-start: words matched against pages and goals, never shown
const SOCIAL = [
  /\b(?:formal|winter|spring|lunar new year|charity)?\s*(?:ball|gala|prom|dance party|semi-formal)\b/i,
  /\bcoffee (?:hour|chat|social|break)\b/i, /\bhappy hour\b/i, /\bmixer\b/i, /\bmeet[- ]and[- ]greet\b/i, /\bsocial (?:night|hour|event|gathering)\b/i,
  /\bnetworking (?:night|reception|social|event|hour)\b/i, /\b(?:wine|cheese|pizza|ice cream|boba|bubble tea) (?:night|social|party)\b/i,
  /\btrivia night\b/i, /\bgame night\b/i, /\bpotluck\b/i, /\bpub (?:night|crawl)\b/i, /\bmentor(?:ship)? (?:mixer|meetup|social|coffee)\b/i,
  /舞会/, /酒会/, /联谊/, /茶话会/, /咖啡时间/, /咖啡角/, /(?:导师|校友)(?:交流会|见面会|茶叙)/, /社交(?:之夜|活动|晚会|酒会)/, /见面会/, /派对/, /晚宴/
];
const NETWORKING = /network|人脉|社交|结识|connections|business development|\bbd\b|fundrais|融资|投资人|合伙人|co-?founder|招募|recruit|community|社群|圈子/i;
// i18n-ignore-end
/** Why a find reads as a low-value social gathering (舞会, coffee hour, mentor mixer, 社交酒会 …): the words that say so. */
export function socialSigns(text: string): string[] {
  return SOCIAL.flatMap((pattern) => { const match = pattern.exec(text); return match ? [match[0].trim()] : []; });
}
/** A line whose goal or milestones are about meeting people in its field: there a social gathering may be worth going to. */
export const networkingLine = (line: LineBrief) => NETWORKING.test([line.goal, ...line.milestones.map((item) => item.title)].join("\n"));

/** The tags as kept on a record (what the store and the card read). */
export type TaggedOpportunity = Pick<Opportunity, "lineId"> & { lines?: OpportunityLineTag[] | undefined; type?: OpportunityType | undefined;
  reason?: string | undefined; lowValue?: "social" | undefined };

/** The best relevance of a record (0 when no line holds it); one read before tags existed counts as just pushable (shown under the old rules). */
export const bestRelevance = (row: TaggedOpportunity): number => row.lines === undefined ? PUSH_RELEVANCE
  : row.lines.length ? Math.max(...row.lines.map((tag) => tag.relevance)) : 0;
/** Whether a find may be pushed as a card (item 1): one line holds it at `PUSH_RELEVANCE` or above. */
export const pushable = (row: TaggedOpportunity): boolean => bestRelevance(row) >= PUSH_RELEVANCE;
/** The record's line: its most relevant one, else the line it was found under. */
export const primaryLineOf = (tags: OpportunityLineTag[], fallback: string) => tags[0]?.lineId ?? fallback;

// i18n-ignore-start: words matched against titles, never shown
const TYPE_WORDS: Array<[OpportunityType, RegExp]> = [
  ["scholarship", /scholarship|奖学金|助学金/i], ["grant", /\bgrant\b|funding|资助|基金申请/i], ["internship", /intern|实习/i],
  ["competition", /hackathon|competition|challenge|contest|olympiad|比赛|竞赛|大赛|挑战赛|黑客松/i],
  ["conference", /conference|symposium|congress|summit|workshop|call for papers|\bcfp\b|大会|会议|研讨会|峰会/i],
  ["talk", /\btalk\b|lecture|seminar|colloquium|讲座|报告会|论坛/i], ["job", /\bjob\b|full[- ]time|engineer\b|招聘|岗位/i],
  ["program", /fellowship|residency|summer school|bootcamp|accelerator|incubator|cohort|暑期学校|训练营|项目/i]
];
// i18n-ignore-end
/** A record's type: its own, else read from its title and kind (rows read before tags existed). */
export function opportunityTypeOf(row: Pick<Opportunity, "kind" | "title"> & { type?: OpportunityType | undefined }): OpportunityType {
  if (row.type) return row.type;
  if (socialSigns(row.title).length) return "social";
  for (const [type, pattern] of TYPE_WORDS) if (pattern.test(row.title)) return type;
  return row.kind === "application" ? "program" : "event";
}

/** The tags a record read before tags existed gets (migration 24): its one line, as pushable as it was, marked migrated. */
export function migratedTags(row: Pick<Opportunity, "lineId" | "kind" | "title">): { lines: OpportunityLineTag[]; type: OpportunityType } {
  return { lines: row.lineId ? [{ lineId: row.lineId, confidence: PUSH_RELEVANCE, relevance: PUSH_RELEVANCE, reason: "", anchors: [], migrated: true }] : [],
    type: opportunityTypeOf(row) };
}

/**
 * One record read twice (two watches, a mail and a page, the scout): its lines are the union, each line at the better of its two
 * relevances with that reading's reason; the type and reason of the newer reading; `lineId` the most relevant line. A migrated tag gives
 * way to a judged one for the same line.
 */
export function mergeLineTags<T extends TaggedOpportunity>(before: TaggedOpportunity, after: T): T {
  const best = new Map<string, OpportunityLineTag>();
  for (const tag of [...(before.lines ?? []), ...(after.lines ?? [])]) {
    const kept = best.get(tag.lineId);
    if (!kept || (kept.migrated && !tag.migrated) || (Boolean(kept.migrated) === Boolean(tag.migrated) && tag.relevance > kept.relevance)) best.set(tag.lineId, tag);
  }
  const lines = [...best.values()].sort((a, b) => b.relevance - a.relevance || a.lineId.localeCompare(b.lineId));
  return { ...after, lines, lineId: primaryLineOf(lines, after.lineId) };
}
