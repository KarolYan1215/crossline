import type { LedgerQuestion } from "@crossline/core";
import type { StoredSentence } from "./profile-types";

/** A stored id list (`source_sentences`), tolerant of a hand-edited or empty value. */
export function sentenceIds(raw: unknown): number[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" && raw ? raw : "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
  } catch { return []; }
}
export const questionRow = (row: Record<string, string | number | null>): LedgerQuestion => ({ id: Number(row.id), kind: row.kind as LedgerQuestion["kind"],
  key: String(row.key), text: String(row.text), options: (() => { try { return JSON.parse(String(row.options_json ?? "[]")) as string[]; } catch { return []; } })(),
  identityId: String(row.identity_id ?? ""), projectId: String(row.project_id ?? ""), status: row.status as LedgerQuestion["status"], answer: String(row.answer ?? ""),
  answerSentences: sentenceIds(row.answer_sentences), ...(typeof row.repeats === "number" ? { repeats: row.repeats } : {}), askedAt: String(row.asked_at),
  ...(row.answered_at ? { answeredAt: String(row.answered_at) } : {}) });
export const sentenceRow = (row: Record<string, string | number>): StoredSentence => ({ id: Number(row.id), sourceKind: row.source_kind as StoredSentence["sourceKind"],
  sourceId: String(row.source_id), ord: Number(row.ord), start: Number(row.start_at), end: Number(row.end_at), text: String(row.text), retired: Number(row.retired) === 1 });
