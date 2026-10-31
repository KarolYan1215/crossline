// i18n-exempt: claims read off the profile cards, whose items exist in Chinese only so far (English cards are not offered); the writer's claims are in the interview's language
/**
 * Claims for the profile report (docs/profile-and-agent-kit.md §五–§六): what the cards measured, computed here and never by a model, and
 * what the portrait writer said, each kept only with a quote that is really in the person's replies.
 */
import { administrationNote, instrumentScores, PROFILE_ITEMS, type DimensionScore, type InstrumentAnswers, type InstrumentId } from "./profile-instruments";
import {
  DEFAULT_SECTION_PRIVACY, REPORT_SECTIONS, REPORT_SECTION_LABEL, WRITER_SECTIONS, claimPrivacy, visibleClaims,
  type PrivacyChoices, type PrivacyLevel, type ProfileClaim, type ReportSection, type WrittenClaim
} from "./profile-report";

/** Where the writer's claims are kept, resolved against the replies: `{version, at, claims}`. */
export const PROFILE_CLAIMS_SETTING = "profile.claims";
/** The person's judgement of each claim: 符合 (`confirmed`) or 不符合 (`rejected`: kept, never exported, never written again). */
export const PROFILE_CLAIM_STATUS_SETTING = "profile.claimStatus";
export type ClaimStatus = "confirmed" | "rejected";
export type ClaimStatusMap = Record<string, { status: ClaimStatus; at: string; statement: string }>;

export function readClaimStatus(raw: string | null | undefined): ClaimStatusMap {
  try {
    const value = JSON.parse(raw ?? "{}") as Record<string, { status?: unknown; at?: unknown; statement?: unknown } | null>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([id, entry]) => entry && (entry.status === "confirmed" || entry.status === "rejected")
      ? [[id, { status: entry.status, at: String(entry.at ?? ""), statement: String(entry.statement ?? "") }]] : []));
  } catch { return {}; }
}

/** A stable id from what a claim says and where, so the person's choice on it survives a rewrite that says the same thing. */
export function claimIdOf(section: string, statement: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${section}|${statement.replace(/\s+/g, "")}`) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `c-${hash.toString(36)}`;
}

const squash = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The writer's claims that can be traced: each quote must be a span of one of the person's replies (punctuation and spacing aside), and a
 * claim the person rejected before is not written again. `sentenceOf` finds the numbered sentence the quote sits in, when there is one.
 */
export function resolveWrittenClaims(written: readonly WrittenClaim[] | undefined, replies: readonly string[],
  options: { at: string; rejected?: ReadonlySet<string>; sentenceOf?: (quote: string) => number | undefined }): ProfileClaim[] {
  const corpus = replies.map(squash);
  const seen = new Set<string>();
  return (written ?? []).flatMap((claim) => {
    const statement = claim.statement.trim();
    const quote = claim.quote.trim();
    const id = claimIdOf(claim.section, statement);
    if (!statement || !WRITER_SECTIONS.includes(claim.section) || seen.has(id) || options.rejected?.has(id)) return [];
    const key = squash(quote);
    if (key.length < 2 || !corpus.some((reply) => reply.includes(key))) return [];
    seen.add(id);
    return [{ id, section: claim.section, statement, kind: claim.kind === "self_reported" ? "self_reported" : "inferred",
      confidence: Math.max(0, Math.min(1, claim.confidence)), basis: [sentenceOf(quote, options.sentenceOf)],
      reviewBy: addDays(options.at, 90) } satisfies ProfileClaim];
  });
}

const sentenceOf = (quote: string, find?: (quote: string) => number | undefined) => {
  const sentenceId = find?.(quote);
  return sentenceId ? { sentenceId, quote } : { quote };
};

const levelOf = (score: number) => (score >= 65 ? "偏高" : score <= 35 ? "偏低" : "中等");
const confidenceOf = (score: DimensionScore) => (score.administration === "tapped" ? 0.8 : score.administration === "mixed" ? 0.6 : 0.5);
const administrationOfAll = (scores: DimensionScore[]) => scores.every((score) => score.administration === "tapped") ? "tapped" as const
  : scores.every((score) => score.administration === "mapped") ? "mapped" as const : "mixed" as const;
const itemsBehind = (scores: DimensionScore[], instrument: InstrumentId) => {
  const dimensions = new Set(scores.map((score) => score.dimension));
  return PROFILE_ITEMS.filter((item) => item.instrument === instrument
    && (instrument === "values" ? item.dimension.split("|").some((side) => dimensions.has(side)) : dimensions.has(item.dimension))).map((item) => item.id);
};
type Scored = DimensionScore & { score: number };
const scored = (answers: InstrumentAnswers, instrument: InstrumentId) =>
  instrumentScores(answers, instrument).filter((score): score is Scored => score.score !== null);

/**
 * The cards' claims: one per Big Five dimension, the three strongest work interests with the weakest, the value tradeoffs' top three and
 * bottom two, and life satisfaction. Only dimensions with a score speak (every item answered, at most half by words); each says how it was
 * answered. `measured` only when every item behind it was tapped, else `inferred` (§六). Relative tendencies only, no norms (§三).
 */
export function instrumentClaims(answers: InstrumentAnswers, at: string): ProfileClaim[] {
  const reviewBy = addDays(at, 180);
  // The id carries what the claim says (levels and order, not the exact numbers), so a judgement never carries over to a reading that changed.
  const claim = (section: ReportSection, statement: string, scores: Scored[], instrument: InstrumentId, reading: string): ProfileClaim => ({
    id: claimIdOf(section, `${instrument}:${reading}`), section, statement,
    kind: scores.every((score) => score.administration === "tapped") ? "measured" : "inferred",
    confidence: Math.min(...scores.map(confidenceOf)),
    basis: [{ instrument, items: itemsBehind(scores, instrument), administration: administrationOfAll(scores) }], reviewBy });
  const out: ProfileClaim[] = [];
  for (const score of scored(answers, "mini_ipip"))
    out.push(claim("personality", `${score.label}${levelOf(score.score)}（${score.score}/100，${administrationNote(score)}）`, [score], "mini_ipip",
      `${score.dimension}:${levelOf(score.score)}`));
  const interests = scored(answers, "rest18").sort((a, b) => b.score - a.score);
  if (interests.length >= 4) out.push(claim("interests", `最想做的工作类型：${interests.slice(0, 3).map((score) => `${score.label}（${score.score}）`).join("、")}；`
    + `最不想做：${interests.at(-1)!.label}（${interests.at(-1)!.score}）`, interests, "rest18",
    [...interests.slice(0, 3), interests.at(-1)!].map((score) => score.dimension).join(",")));
  const values = scored(answers, "values").sort((a, b) => b.score - a.score);
  if (values.length >= 5) out.push(claim("values", `取舍时更看重：${values.slice(0, 3).map((score) => score.label).join("、")}；更容易让出：`
    + values.slice(-2).map((score) => score.label).join("、"), values, "values",
    [...values.slice(0, 3), ...values.slice(-2)].map((score) => score.dimension).join(",")));
  const life = scored(answers, "swls")[0];
  if (life) out.push(claim("lifestyle", `对眼下生活的整体满意度${levelOf(life.score)}（${life.score}/100，${administrationNote(life)}）`, [life], "swls", levelOf(life.score)));
  return out;
}

/** What the writer is told about the cards: levels in words, never a number, so its own claims say how a tendency shows in a day. */
export function instrumentReadings(answers: InstrumentAnswers): string[] {
  return (["mini_ipip", "rest18", "swls", "values"] as const).flatMap((instrument) =>
    scored(answers, instrument).map((score) => `${score.label}：${levelOf(score.score)}（${administrationNote(score)}）`));
}

export type ReportSectionView = {
  section: ReportSection; label: string; privacy: PrivacyLevel;
  claims: Array<ProfileClaim & { shownTo: PrivacyLevel; personStatus?: ClaimStatus }>;
};

/** The report by section for one audience (§五, §七): every section in order, its level, and the claims that audience may see. */
export function reportSections(claims: readonly ProfileClaim[], choices: PrivacyChoices, audience: PrivacyLevel,
  status: ClaimStatusMap = {}): ReportSectionView[] {
  const shown = visibleClaims(claims, audience, choices).filter((claim) => audience === "private" || status[claim.id]?.status !== "rejected");
  return REPORT_SECTIONS.map((section) => ({ section, label: REPORT_SECTION_LABEL[section],
    privacy: choices.sections[section] ?? DEFAULT_SECTION_PRIVACY[section],
    claims: shown.filter((claim) => claim.section === section).map((claim) => ({ ...claim, shownTo: claimPrivacy(claim, choices),
      ...(status[claim.id] ? { personStatus: status[claim.id]!.status } : {}) })) }));
}

/** What leaves Crossline with the profile (§七): `public` and `agent` claims, none the person rejected. A `private` claim never does. */
export function exportableClaims(claims: readonly ProfileClaim[], choices: PrivacyChoices, status: ClaimStatusMap): ProfileClaim[] {
  return visibleClaims(claims, "agent", choices).filter((claim) => status[claim.id]?.status !== "rejected");
}
