/**
 * What a report says to put into practice (docs/skills-library.md 「报告与可落地」): the organising run writes `落地.json` beside its
 * documents, up to eight concrete actions, each with why (citing a topic) and the line it belongs to. Read through this check only:
 * anything malformed is dropped, a line id that is not one of the person's lines becomes "", and nothing else is trusted.
 */
export const REPORT_ITEMS_FILE = "落地.json"; // i18n-ignore: a file name the run writes
export const REPORT_ITEMS_MAX = 8;
export const REPORT_ITEM_TITLE_MAX = 40;

export type ReportItem = { title: string; why: string; topic: string; lineId: string };

const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

export function readReportItems(raw: string, lineIds: readonly string[]): ReportItem[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^﻿/, "")); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [];
  const seen = new Set<string>();
  const items: ReportItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = text(record.title, 200);
    // A title past the limit was cut off or is a paragraph, not an action.
    if (!title || title.length > REPORT_ITEM_TITLE_MAX || seen.has(title)) continue;
    const lineId = text(record.lineId, 80);
    seen.add(title);
    items.push({ title, why: text(record.why, 300), topic: text(record.topic, 60), lineId: lineIds.includes(lineId) ? lineId : "" });
    if (items.length >= REPORT_ITEMS_MAX) break;
  }
  return items;
}
