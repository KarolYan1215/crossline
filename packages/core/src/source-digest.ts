import { tFor, type Locale } from "./i18n";

/**
 * Older versions of a document (the owner's decision D11 of 2026-11-22): when the model confirms that two near-duplicate files are versions
 * of one document (Skill `crossline-source-digest`, candidates from `near-duplicates.ts`), the latest is read in full; the older one stays
 * stored as it is, and the interview reads a short note in its place — what it was, how it differs from the latest — and opens the original
 * only when it needs to. Kept in the ledger setting `sources.versions`.
 */
export const SOURCE_VERSIONS_SETTING = "sources.versions";
/** Per document, the fingerprint already computed, so a pass does not read every text again. */
export const SOURCE_SIMHASH_SETTING = "sources.simhash";
/** When the person's computer last changed a file they uploaded (the browser's `lastModified`), a version signal. */
export const sourceModifiedSetting = (documentId: string) => `sources.modified:${documentId}`;

export type SupersededEntry = { latestId: string; noteDocumentId: string; summary: string; differences: string; at: string };
export type SourceVersions = {
  /** Pairs already put to the model (`a|b`, ids sorted), whatever it answered. */
  checked: string[];
  /** Older document id → the latest version and the note the interview reads instead. */
  superseded: Record<string, SupersededEntry>;
};

export function readSourceVersions(raw: string | undefined): SourceVersions {
  try {
    const value = JSON.parse(raw ?? "{}") as Partial<SourceVersions>;
    return { checked: Array.isArray(value.checked) ? value.checked.filter((item) => typeof item === "string") : [],
      superseded: value.superseded && typeof value.superseded === "object" ? value.superseded : {} };
  } catch { return { checked: [], superseded: {} }; }
}
export const versionPairKey = (a: string, b: string) => [a, b].sort().join("|");

/** The model's answer for each candidate pair. */
export type SourceVersionAnswer = { pairs: Array<{ a: string; b: string; sameDocument: boolean; latestId: string; olderSummary: string; differences: string; why: string }> };
export const SOURCE_VERSIONS_SCHEMA = { type: "object", additionalProperties: false, required: ["pairs"], properties: {
  pairs: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false,
    required: ["a", "b", "sameDocument", "latestId", "olderSummary", "differences", "why"], properties: {
      a: { type: "string", minLength: 1, maxLength: 80 }, b: { type: "string", minLength: 1, maxLength: 80 }, sameDocument: { type: "boolean" },
      latestId: { type: "string", maxLength: 80 }, olderSummary: { type: "string", maxLength: 600 }, differences: { type: "string", maxLength: 1200 },
      why: { type: "string", maxLength: 200 } } } } } } as const;

/**
 * Keeps only answers about pairs that were asked, with a latest id that is one of the two; a same-document answer without a summary is
 * dropped (it would leave the interview with nothing in place of the older file).
 */
export function validateSourceVersions(value: unknown, asked: Array<{ a: string; b: string }>): SourceVersionAnswer {
  const answer = value as SourceVersionAnswer | undefined;
  if (!answer || !Array.isArray(answer.pairs)) throw new Error("SOURCE_VERSIONS_INVALID");
  const open = new Set(asked.map((pair) => versionPairKey(pair.a, pair.b)));
  const pairs = answer.pairs.filter((pair) => pair && open.delete(versionPairKey(String(pair.a), String(pair.b))))
    .map((pair) => ({ a: String(pair.a), b: String(pair.b), sameDocument: pair.sameDocument === true, latestId: String(pair.latestId ?? ""),
      olderSummary: String(pair.olderSummary ?? "").trim(), differences: String(pair.differences ?? "").trim(), why: String(pair.why ?? "").trim().slice(0, 200) }))
    .filter((pair) => !pair.sameDocument || ((pair.latestId === pair.a || pair.latestId === pair.b) && pair.olderSummary));
  return { pairs };
}

/** The note the interview reads in place of an older version: what it is, its summary, what changed, and how to open the original. */
export function olderVersionNote(older: { fileName: string; ref: string }, latest: { fileName: string; ref: string }, entry: { summary: string; differences: string }, locale?: Locale): string {
  const t = tFor(locale);
  return [t("# 旧版：{{file}}", { file: older.fileName }), "",
    t("这是《{{latest}}》（{{latestRef}}）的较早版本，原件仍保存为 {{ref}}；需要逐字核对时用 read_file 读原件。", { latest: latest.fileName, latestRef: latest.ref, ref: older.ref }), "",
    t("## 摘要"), entry.summary, "", t("## 与最新版的差异"), entry.differences || t("（没有写出差异）")].join("\n");
}

/**
 * AI conversation exports (D14, docs/plans/2026-11-22-interview-and-import-redesign.md §四.5): the stored document keeps only what the
 * person typed (`chatHistoryText`); the same Skill then writes one short summary per conversation, and the interview reads the summaries
 * in place of the export, opening the export itself for the person's own words. Kept in the ledger setting `sources.chatDigest`.
 */
export const CHAT_DIGEST_SETTING = "sources.chatDigest";
/**
 * Per export document: the summaries written so far by segment number, how often the model passed a segment over (`tries`, by segment
 * id), and the note once every segment has one.
 */
export type ChatDigestEntry = { summaries: Record<string, string>; tries?: Record<string, number>; noteDocumentId?: string; at?: string };
export function readChatDigests(raw: string | undefined): Record<string, ChatDigestEntry> {
  try {
    const value = JSON.parse(raw ?? "{}") as Record<string, ChatDigestEntry> | null;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** One conversation of an export document: its heading (date and title) and the person's messages as stored. */
export type ChatSegment = { index: number; heading: string; said: string };
/** The first line `chatHistoryText` writes, in either language: what marks a stored document as an AI conversation export. */
const CHAT_HEADER = /^(AI 对话记录（|AI conversation export \()/;
/**
 * The conversations of a stored export document, read back from its own layout (a header line, a contents section, then one `## ` section
 * per conversation whose messages are `- ` lines with indented continuations); undefined for any other document.
 */
export function chatHistorySegments(text: string): ChatSegment[] | undefined {
  const lines = text.split("\n");
  if (!CHAT_HEADER.test(lines[0] ?? "")) return undefined;
  const sections: Array<{ heading: string; body: string[] }> = [];
  for (const line of lines.slice(1)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) sections.push({ heading: heading[1]!.trim(), body: [] });
    else sections.at(-1)?.body.push(line);
  }
  // The first section is the contents list.
  return sections.slice(1).map((section, index) => ({ index, heading: section.heading, said: section.body.join("\n").trim() })).filter((segment) => segment.said);
}

export type ChatDigestAnswer = { segments: Array<{ id: string; summary: string }> };
export const CHAT_DIGEST_SCHEMA = { type: "object", additionalProperties: false, required: ["segments"], properties: {
  segments: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["id", "summary"], properties: {
    id: { type: "string", minLength: 1, maxLength: 20 }, summary: { type: "string", maxLength: 600 } } } } } } as const;
/** Only segments that were asked, each once, with a summary; a segment left out is asked again on a later run. */
export function validateChatDigest(value: unknown, asked: string[]): ChatDigestAnswer {
  const answer = value as ChatDigestAnswer | undefined;
  if (!answer || !Array.isArray(answer.segments)) throw new Error("CHAT_DIGEST_INVALID");
  const open = new Set(asked);
  return { segments: answer.segments.filter((item) => item && String(item.summary ?? "").trim() && open.delete(String(item.id)))
    .map((item) => ({ id: String(item.id), summary: String(item.summary).trim().slice(0, 600) })) };
}

/** The note the interview reads in place of an export: one summary per conversation, and how to open the person's own words. */
export function chatDigestNote(source: { fileName: string; ref: string }, segments: Array<{ heading: string; summary: string }>, locale?: Locale): string {
  const t = tFor(locale);
  return [t("# AI 对话摘要：{{file}}", { file: source.fileName }), "",
    t("每段对话一条摘要。本人逐字说的话在原件 {{ref}} 里，需要引用时用 read_file 读原件。", { ref: source.ref }),
    ...segments.flatMap((segment) => ["", `## ${segment.heading}`, segment.summary || t("（没有写出摘要，原件里有这段对话）")])].join("\n");
}
