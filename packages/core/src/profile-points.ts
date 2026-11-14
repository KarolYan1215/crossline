import { DIMENSION_IDS, isWebUrl, oneOf, type DimensionId, type Hypothesis } from "./profile-hypotheses";

/**
 * The points ledger (要点账本, the owner's decisions of 2026-11-12): what is settled about the person, as points rather than paragraphs.
 * The portrait's sections used to be rewritten as prose every run, so each run reworded what earlier runs said and the side panel showed a
 * different summary every round. Now an interview under these rules (`POINTS_RULES`) keeps:
 *
 * - points the person stated, each resting on their own words (a reply or a file, cited by sentence) and, where there is any, outside data
 *   from the research threads (a URL). A point may be a paragraph. One without a citation is not kept.
 * - points the person confirmed: an inference they rated 「准」 on its observation card, put here by code (no model call), with the card's
 *   quotes and sources; and the correction they wrote under 「部分对」, in their own words.
 *
 * Inferences stay in the hypothesis log until the person rates them. A stage's view in prose (the section's fields) is written once, when
 * the stage is over; the report is written from the points at the end.
 */
export const POINT_SECTIONS = ["narrative", "situation", "compass", "energy"] as const;
export type PointSection = (typeof POINT_SECTIONS)[number];
export const POINT_SOURCES = ["stated", "confirmed", "corrected"] as const;
export type PointSource = (typeof POINT_SOURCES)[number];
export const POINT_OPS = ["add", "revise", "retract"] as const;
/** The longest point: a paragraph. */
export const POINT_TEXT_MAX = 800;

export type ProfilePoint = {
  id: string;
  section: PointSection;
  text: string;
  /** The person's words it rests on: a reply or file (`reply-N`, `src-N`) and the sentence, or a card's correction (`card:<session>#<seq>`). */
  quotes: Array<{ ref: string; text: string }>;
  /** Outside data from the research threads, each with its URL. */
  external: Array<{ text: string; url: string }>;
  source: PointSource;
  /** The hypothesis a confirmed or corrected point came from. */
  hypothesisId?: string;
  retracted?: boolean;
  /** Every change, oldest first: what the point said before it and why it changed. */
  log: Array<{ at: string; op: (typeof POINT_OPS)[number]; before: string; why: string }>;
};

/** One change a run asks for, after its sentence numbers are turned into quotes (`resolveOnboardingRefs`). */
export type PointChange = {
  op: (typeof POINT_OPS)[number];
  id: string;
  section: PointSection;
  text: string;
  quotes: Array<{ ref: string; text: string }>;
  external: Array<{ text: string; url: string }>;
  why: string;
};

/**
 * Which rules an interview runs under, kept in its session's coverage (`rules`). Only interviews started after 2026-11-12 (and the
 * accounts moved over on purpose) run under the points rules; one under way before keeps its paragraphs.
 */
export const POINTS_RULES = "points";
export const pointsRules = (coverage: unknown): boolean => (coverage as { rules?: unknown } | undefined)?.rules === POINTS_RULES;

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
/** One change on the wire: sentence numbers in `refs`, outside data only from the research threads. */
export const POINT_CHANGE_FIELD = object({
  op: { type: "string", enum: [...POINT_OPS] }, id: { type: "string", maxLength: 12 }, section: { type: "string", enum: [...POINT_SECTIONS] },
  text: { type: "string", maxLength: POINT_TEXT_MAX }, refs: { type: "array", maxItems: 8, items: { type: "integer", minimum: 1 } },
  external: { type: "array", maxItems: 3, items: object({ text: { type: "string", minLength: 1, maxLength: 300 }, url: { type: "string", minLength: 8, maxLength: 500 } }) },
  why: { type: "string", maxLength: 300 }
});

const loose = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
const str = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()];

/**
 * A run's changes applied to the ledger, never a refusal: a change that does not hold is left out and counted. Added: a section, words and
 * at least one quote; the same words as a point on record are not added twice. Revised: a point the person stated (theirs to confirm or
 * correct are not the run's to reword), with new words, at least one quote and a reason; the old words go to its log. Retracted: a point
 * the person stated, with a reason. Ids are given here (`p<n>`), never taken from the model for a new point.
 */
export function applyPointChanges(points: ProfilePoint[], changes: PointChange[], at: string): { points: ProfilePoint[]; dropped: number } {
  const next = points.map((point) => ({ ...point }));
  let last = Math.max(0, ...points.map((point) => Number(/^p(\d+)$/.exec(point.id)?.[1] ?? 0)));
  let dropped = 0;
  for (const change of changes) {
    const text = str(change.text, POINT_TEXT_MAX), why = str(change.why, 300);
    const quotes = unique(change.quotes.filter((quote) => quote.ref && quote.text.trim()), (quote) => `${quote.ref}|${quote.text}`);
    const external = unique(change.external.filter((item) => item.text.trim() && isWebUrl(item.url)).map((item) => ({ text: item.text.trim(), url: item.url.trim() })), (item) => item.url);
    const target = next.find((point) => point.id === change.id && !point.retracted);
    if (change.op === "add") {
      if (!text || !quotes.length || !oneOf(POINT_SECTIONS, change.section) || next.some((point) => !point.retracted && loose(point.text) === loose(text))) { dropped += 1; continue; }
      next.push({ id: `p${++last}`, section: change.section, text, quotes, external, source: "stated", log: [{ at, op: "add", before: "", why }] });
    } else if (change.op === "revise") {
      if (!target || target.source !== "stated" || !text || !quotes.length || !why || loose(text) === loose(target.text)) { dropped += 1; continue; }
      target.log = [...target.log, { at, op: "revise", before: target.text, why }];
      target.text = text;
      target.quotes = unique([...target.quotes, ...quotes], (quote) => `${quote.ref}|${quote.text}`).slice(-12);
      target.external = unique([...target.external, ...external], (item) => item.url).slice(-6);
    } else {
      if (!target || target.source !== "stated" || !why) { dropped += 1; continue; }
      target.retracted = true;
      target.log = [...target.log, { at, op: "retract", before: target.text, why }];
    }
  }
  return { points: next, dropped };
}

/** The section a card's point goes to: the stage it was asked in when that is one, else the one its dimension belongs to. */
export function pointSectionFor(stage: string | undefined, dimension: DimensionId | undefined): PointSection {
  if (oneOf(POINT_SECTIONS, stage)) return stage;
  const byDimension: Partial<Record<DimensionId, PointSection>> = { D8: "narrative", D4: "compass", D5: "compass", D6: "compass", D1: "energy", D2: "energy", D3: "energy", D7: "energy" };
  return (dimension && byDimension[dimension]) || "situation";
}

/** A card as the rating needs it. */
export type RatedCard = { text: string; refs: Array<{ replyId: string; quote: string }>; external?: Array<{ text: string; url: string }> };

/**
 * The person's rating of an observation card applied to the hypothesis it asks about (2026-11-12): 「准」 confirms it — the hypothesis is
 * supported and the card becomes a point marked confirmed, with its quotes and sources; 「不准」 refutes it, and it is never a point;
 * 「部分对」 leaves it open, and the person's correction becomes a point in their own words. Returns what to undo it with.
 */
/* i18n-ignore-start: the ledger's own log and the model-facing lines below are not interface text */
export function rateHypothesis(profile: { hypotheses: Hypothesis[]; points: ProfilePoint[] }, input: {
  hypothesisId: string; cardKey: string; verdict: "fits" | "off" | "partial"; correction?: string; card: RatedCard; section: PointSection; at: string;
}): { hypotheses: Hypothesis[]; points: ProfilePoint[]; pointId?: string; prior?: Pick<Hypothesis, "status" | "rated"> } {
  const index = profile.hypotheses.findIndex((item) => item.id === input.hypothesisId);
  if (index < 0) return { hypotheses: profile.hypotheses, points: profile.points };
  const old = profile.hypotheses[index]!;
  const last = Math.max(0, ...profile.points.map((point) => Number(/^p(\d+)$/.exec(point.id)?.[1] ?? 0)));
  const correction = str(input.correction, 300);
  const point: ProfilePoint | undefined = input.verdict === "fits" ? {
    id: `p${last + 1}`, section: input.section, text: str(input.card.text, POINT_TEXT_MAX),
    quotes: input.card.refs.map((ref) => ({ ref: ref.replyId, text: ref.quote })), external: (input.card.external ?? []).filter((item) => isWebUrl(item.url)),
    source: "confirmed", hypothesisId: old.id, log: [{ at: input.at, op: "add", before: "", why: "本人在观察卡上点了「准」" }]
  } : input.verdict === "partial" && correction ? {
    id: `p${last + 1}`, section: input.section, text: correction, quotes: [{ ref: `card:${input.cardKey}`, text: correction }], external: [],
    source: "corrected", hypothesisId: old.id, log: [{ at: input.at, op: "add", before: "", why: `本人对观察「${str(input.card.text, 80)}」的更正` }]
  } : undefined;
  const status = input.verdict === "fits" ? "supported" as const : input.verdict === "off" ? "refuted" as const : old.status;
  const hypotheses = [...profile.hypotheses];
  hypotheses[index] = { ...old, status, rated: input.verdict, cardKey: input.cardKey, ...(point ? { pointId: point.id } : {}) };
  if (!point) delete hypotheses[index]!.pointId;
  return { hypotheses, points: point ? [...profile.points, point] : profile.points, ...(point ? { pointId: point.id } : {}),
    prior: { status: old.status, ...(old.rated ? { rated: old.rated } : {}) } };
}

/** A rating taken back: the point it made goes, and the hypothesis is as it was before. */
export function unrateHypothesis(profile: { hypotheses: Hypothesis[]; points: ProfilePoint[] }, input: {
  hypothesisId: string; pointId?: string; prior?: Pick<Hypothesis, "status" | "rated">;
}): { hypotheses: Hypothesis[]; points: ProfilePoint[] } {
  const hypotheses = profile.hypotheses.map((item) => {
    if (item.id !== input.hypothesisId) return item;
    const { rated: _rated, pointId: _pointId, cardKey: _cardKey, ...rest } = item;
    return { ...rest, status: input.prior?.status ?? (item.status === "refuted" || item.status === "supported" ? "open" : item.status),
      ...(input.prior?.rated ? { rated: input.prior.rated } : {}) };
  });
  return { hypotheses, points: input.pointId ? profile.points.filter((point) => point.id !== input.pointId) : profile.points };
}

/**
 * The hypothesis a card the dialogue wrote stands for when it named none on record (2026-11-12: every card is one hypothesis): its words,
 * its quotes as basis, its sources as outside basis, its falsifier, open until the person rates it.
 */
export function hypothesisFromCard(card: RatedCard & { falsifier: string }, id: string, dimension: DimensionId | undefined): Hypothesis {
  return { id, dimension: oneOf(DIMENSION_IDS, dimension) ? dimension : "D0", statement: str(card.text, 400),
    basis: [...card.refs.map((ref) => ({ kind: "quote" as const, text: ref.quote, ref: ref.replyId })),
      ...(card.external ?? []).filter((item) => isWebUrl(item.url)).map((item) => ({ kind: "external" as const, text: item.text, ref: item.url }))],
    falsifier: card.falsifier, alternative: "", status: "open" };
}

/**
 * What the dialogue is told of the hypothesis log each round (2026-11-12), so a card asks about one hypothesis and never one the person
 * already settled: the open ones (to pick from by id), and the ones they rated, with how.
 */
export function hypothesisLogLines(hypotheses: Hypothesis[], limit = 16): string[] {
  const open = hypotheses.filter((item) => !item.cardKey && item.status !== "refuted").slice(-limit)
    .map((item) => `${item.id} [${item.dimension}] ${item.statement.slice(0, 120)}（待问）`);
  const rated = hypotheses.filter((item) => item.cardKey).slice(-limit).map((item) => `${item.id} ${item.statement.slice(0, 80)}（本人说${
    item.rated === "fits" ? "准，已记进要点" : item.rated === "off" ? "不准，不再提" : item.rated === "partial" ? "部分对，已记下更正" : "未答"}）`);
  return [...rated, ...open];
}

/**
 * The extraction's new hypotheses numbered `h<n>` after the highest on record, whatever it called them, with the careers' references
 * moved along. In the seventh replay (2026-11-13) the extraction saw a log of cards only (`c<seq>`) and went on numbering `c33`, `c35`…,
 * the ids the next cards would take.
 */
export function numberNewHypotheses<C extends { hypothesisIds?: string[] }>(onRecord: Hypothesis[], hypotheses: Hypothesis[], careers: C[] = []):
  { hypotheses: Hypothesis[]; careers: C[] } {
  const known = new Set(onRecord.map((item) => item.id));
  let next = Math.max(0, ...onRecord.map((item) => /^h(\d+)$/.exec(item.id)).map((match) => (match ? Number(match[1]) : 0))) + 1;
  const renamed = new Map<string, string>();
  for (const item of hypotheses) if (!known.has(item.id) && !renamed.has(item.id)) renamed.set(item.id, `h${next++}`);
  const as = (id: string) => renamed.get(id) ?? id;
  return { hypotheses: hypotheses.map((item) => ({ ...item, id: as(item.id) })),
    careers: careers.map((career) => (career.hypothesisIds ? { ...career, hypothesisIds: career.hypothesisIds.map(as) } : career)) };
}

/** Hypotheses offered to the cards each round (2026-11-14): up to `INSIGHTS_PER_ROUND` may go on cards together, one more to choose from. */
export const CARDS_OFFERED = 4;

/** The ids `cardCandidates` offers, in its order: a card naming one of them is drawn from the log. */
export const cardCandidateIds = (hypotheses: Hypothesis[], limit = 3): string[] => candidateRows(hypotheses, limit).map(({ item }) => item.id);

/**
 * What the next observation card asks about (2026-11-13, the owner: cards come from the log, not made up afresh each round): at most
 * `limit` hypotheses still open, never put on a card, resting on two replies or more (a card cites two), with the replies they rest on.
 * The dimension the cards have asked least comes first, then the hypothesis with more replies behind it, then the older one. In the
 * sixth replay every one of twelve cards was a new inference, and none of the 25 the extraction kept was ever asked.
 */
export function cardCandidates(hypotheses: Hypothesis[], limit = 3): string[] {
  return candidateRows(hypotheses, limit)
    // The competing explanation goes with it: a card states the pattern and leaves the why open unless the replies settle it (replays 10
    // and 11, 2026-11-14: all seven cards rated 「部分对」 had the pattern right and the cause wrong).
    .map(({ item, cited }) => `${item.id} [${item.dimension}] ${item.statement.slice(0, 120)}（依据 ${cited.slice(0, 3).map(([ref, text]) => `${ref}「${text.slice(0, 40)}」`).join("、")}）`
      + (item.alternative.trim() ? `；另一种解释：${item.alternative.trim().slice(0, 80)}` : ""));
}

function candidateRows(hypotheses: Hypothesis[], limit: number) {
  // `cardKey` is set when a card is shown, answered or not (onboarding-session.ts), so a card left unanswered is not offered again.
  const asked = new Map<string, number>();
  for (const item of hypotheses) if (item.cardKey) asked.set(item.dimension, (asked.get(item.dimension) ?? 0) + 1);
  const replies = (item: Hypothesis) => [...new Map(item.basis.filter((basis) => /^reply-\d+$/.test(basis.ref)).map((basis) => [basis.ref, basis.text])).entries()];
  return hypotheses.map((item, index) => ({ item, index, cited: replies(item) }))
    .filter(({ item, cited }) => !item.cardKey && (item.status === "open" || item.status === "undecided") && cited.length >= 2)
    .sort((a, b) => (asked.get(a.item.dimension) ?? 0) - (asked.get(b.item.dimension) ?? 0) || b.cited.length - a.cited.length || a.index - b.index)
    .slice(0, limit);
}

/** The ledger as the extraction and the dialogue are shown it: one line per point still standing. */
export function pointLines(points: ProfilePoint[]): string[] {
  const label: Record<PointSource, string> = { stated: "原话", confirmed: "本人确认", corrected: "本人更正" };
  return points.filter((point) => !point.retracted).map((point) => `${point.id} [${point.section}·${label[point.source]}] ${point.text.slice(0, 200)}`);
}

/* i18n-ignore-end */

/** Points as stored: anything malformed reads as none. */
export function readPoints(raw: unknown): ProfilePoint[] {
  return Array.isArray(raw) ? raw.filter((point): point is ProfilePoint => Boolean(point) && typeof point === "object"
    && typeof (point as ProfilePoint).id === "string" && typeof (point as ProfilePoint).text === "string" && oneOf(POINT_SECTIONS, (point as ProfilePoint).section)) : [];
}
