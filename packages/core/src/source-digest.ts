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
