/**
 * The portrait narrative (2026-11-22, docs/plans/portrait-depth-1122.md §三–§四): one piece of prose written before the report's fields,
 * free text with no schema (format constraints cost reasoning: Tam et al. 2024), the life story first, then one section per insight, then
 * the principle that joins them. It prints no evidence, confidence or citation; each section ends on a hidden line naming the points and
 * hypotheses it rests on and its level, so a section the person marks wrong leads back to the ledger, and the farthest (level 3) waits to
 * be rated until the whole has been read.
 */
import { levelOf, type Hypothesis, type HypothesisLevel } from "./profile-hypotheses";

export type NarrativeSection = { heading: string; body: string; basis: string[]; level: HypothesisLevel };
export type PortraitNarrative = { text: string; sections: NarrativeSection[] };

/** Saved beside the report: the narrative, when it was written, and the person's ratings of its sections. */
export const PORTRAIT_NARRATIVE_SETTING = "portrait.narrative";
/** How long a level-3 section waits before it can be rated: read the whole, come back (Swann & Hill 1982; Finn's levels). */
export const NARRATIVE_RATE_AFTER_MS = 3 * 86_400_000;
export type NarrativeRating = { verdict: "fits" | "partial" | "off"; note?: string; at: string };
export type SavedNarrative = PortraitNarrative & { version: number; at: string; ratings?: Record<string, NarrativeRating> };

const BASIS_LINE = /<!--\s*basis:\s*([^>]*?)\s+level:\s*([123])\s*-->/;

/** The narrative's sections: each `## ` heading, its paragraphs, and the hidden basis line under it. */
export function parseNarrative(text: string): PortraitNarrative {
  const clean = text.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  const parts = clean.split(/^##\s+/m).slice(1);
  const sections = parts.map((part): NarrativeSection => {
    const [first, ...rest] = part.split("\n");
    const raw = rest.join("\n");
    const match = BASIS_LINE.exec(raw);
    const basis = match ? match[1]!.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean) : [];
    const level = levelOf({ level: match ? Number(match[2]) : undefined });
    return { heading: (first ?? "").trim(), body: raw.replace(new RegExp(BASIS_LINE.source, "g"), "").trim(), basis, level };
  }).filter((section) => section.heading && section.body);
  return { text: clean, sections };
}

/**
 * What a narrative must not carry, each a reason handed back to the model: no section, a section with no basis or one naming ids the
 * ledger lacks, and a level-3 section when the interview had a safety turn. How it is written — quotes, sources, wording, labels, how
 * many level-3 sections — is the Skill's (2026-11-27, docs/plans/condense-1127.md A6).
 */
/* i18n-ignore-start: reasons handed back to the model */
export function narrativeProblems(narrative: PortraitNarrative, known: { ids: ReadonlySet<string>; safety: boolean }): string[] {
  const problems: string[] = [];
  if (narrative.sections.length < 2) problems.push("叙事至少要有「人生叙事」和一节洞察，每节用 `## ` 开头。");
  for (const section of narrative.sections) {
    const name = `「${section.heading.slice(0, 30)}」`;
    if (!section.basis.length) problems.push(`${name}末尾缺少 <!-- basis: … level: n --> 一行。`);
    const unknown = section.basis.filter((id) => !known.ids.has(id));
    if (unknown.length) problems.push(`${name}的 basis 写了材料里没有的 id：${unknown.join("、")}。`);
  }
  if (known.safety && narrative.sections.some((section) => section.level === 3)) problems.push("访谈里有过艰难时期的处理，这份叙事不写第三级的节。");
  return problems;
}
/* i18n-ignore-end */

/** A section's stable key for its rating: its heading, letters and digits only. */
export const narrativeSectionKey = (heading: string): string => heading.replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 60);

/** Whether a section may be rated now: levels 1–2 at once, level 3 three days after the narrative was written. */
export const narrativeRatable = (section: Pick<NarrativeSection, "level">, writtenAt: string, now: Date): boolean =>
  section.level !== 3 || now.getTime() - Date.parse(writtenAt) >= NARRATIVE_RATE_AFTER_MS;

export type RatingRow = { statement: string; dimension: string; rated: "fits" | "partial" | "off"; correction: string; novel?: "new" | "known" };
export type RatingPattern = { rated: number; byDimension: Array<{ dimension: string; fits: number; partial: number; off: number }>; guarded: string[]; accepted: string[] };

/**
 * The person's ratings as material (2026-11-22, §二): never the content of what they rejected, only how they rated. A dimension is
 * `guarded` when at least `MIN_RATED` cards on it were rated, none 准 and more than half 不准, while some other dimension had cards rated
 * 准; `accepted` the dimensions with most cards rated 准. Below that sample there is no pattern: an interview has a dozen cards or two,
 * and 「they denied it, so it hit」 must never be read off three.
 */
export const MIN_RATED = 4;
export function ratingPattern(rows: RatingRow[]): RatingPattern | null {
  const by = new Map<string, { fits: number; partial: number; off: number }>();
  for (const row of rows) {
    const entry = by.get(row.dimension) ?? { fits: 0, partial: 0, off: 0 };
    entry[row.rated] += 1;
    by.set(row.dimension, entry);
  }
  const byDimension = [...by.entries()].map(([dimension, counts]) => ({ dimension, ...counts }));
  const total = (entry: { fits: number; partial: number; off: number }) => entry.fits + entry.partial + entry.off;
  const guarded = byDimension.filter((entry) => total(entry) >= MIN_RATED && entry.fits === 0 && entry.off * 2 > total(entry)).map((entry) => entry.dimension);
  const accepted = byDimension.filter((entry) => entry.fits * 2 > total(entry) && total(entry) >= 2).map((entry) => entry.dimension);
  if (!guarded.length || !accepted.length) return null;
  return { rated: rows.length, byDimension, guarded, accepted };
}

/** The rated cards as the narrative reads them: the statement, its dimension, the verdict, the correction in the person's words. */
export function ratingRows(hypotheses: Hypothesis[], points: Array<{ id: string; text: string; source: string }>): RatingRow[] {
  const byId = new Map(points.map((point) => [point.id, point]));
  return hypotheses.flatMap((item): RatingRow[] => {
    if (!item.rated) return [];
    const point = item.pointId ? byId.get(item.pointId) : undefined;
    return [{ statement: item.statement, dimension: item.dimension, rated: item.rated, correction: point?.source === "corrected" ? point.text : "",
      ...(item.novel ? { novel: item.novel } : {}) }];
  });
}

/** A saved narrative as stored: anything malformed reads as none. */
export function readSavedNarrative(raw: string | null | undefined): SavedNarrative | null {
  try {
    const value = JSON.parse(raw ?? "null") as SavedNarrative | null;
    return value && typeof value.text === "string" && Array.isArray(value.sections) && typeof value.at === "string" ? value : null;
  } catch { return null; }
}

type ClaimStatusEntry = { status: "confirmed" | "rejected"; at: string; statement: string };
/**
 * The person's verdict on one section. 不准 also marks the section's heading a rejected claim, so the next narrative and report do not
 * say it again (`rejectedClaims`); 准 or 部分对 lifts that. A level-3 section cannot be rated before `NARRATIVE_RATE_AFTER_MS`.
 */
export function rateNarrativeSection(saved: SavedNarrative, status: Record<string, ClaimStatusEntry>, input: { key: string; verdict: NarrativeRating["verdict"]; note?: string; now: Date }):
  { ok: true; saved: SavedNarrative; status: Record<string, ClaimStatusEntry> } | { ok: false; code: "NARRATIVE_SECTION_UNKNOWN" | "NARRATIVE_NOT_YET_RATABLE" } {
  const section = saved.sections.find((item) => narrativeSectionKey(item.heading) === input.key);
  if (!section) return { ok: false, code: "NARRATIVE_SECTION_UNKNOWN" };
  if (!narrativeRatable(section, saved.at, input.now)) return { ok: false, code: "NARRATIVE_NOT_YET_RATABLE" };
  const at = input.now.toISOString();
  const note = input.note?.trim().slice(0, 600);
  const claimId = `narrative:${input.key}`;
  const nextStatus = { ...status };
  if (input.verdict === "off") nextStatus[claimId] = { status: "rejected", at, statement: section.heading };
  else delete nextStatus[claimId];
  return { ok: true, status: nextStatus,
    saved: { ...saved, ratings: { ...saved.ratings, [input.key]: { verdict: input.verdict, at, ...(note ? { note } : {}) } } } };
}
