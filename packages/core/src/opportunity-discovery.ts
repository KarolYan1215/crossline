import { quoteSupportsDate } from "./date-schema";
import { tFor, type Locale } from "./i18n";
import { DIRECTION_FITS, ELIGIBILITY_DIMS, STAGE_FITS, type ApplicationSlot, type DatedQuote, type EligibilityDim, type EligibilityRule, type EligibilityVerdict, type NeedSource,
  type Opportunity, type OpportunityFit, type OpportunityNeed } from "./opportunity";
import type { EventPlace } from "./opportunity-watch";
import { CLASSIFICATION_PROPERTIES, CLASSIFICATION_REQUIRED, KEEP_RELEVANCE, bestRelevance, isReading, pushable, type RawClassification,
  type TaggedOpportunity } from "./opportunity-tags";

/**
 * The discovery half of the opportunity agent (docs/opportunity-agent.md §5–8, track A): what a line needs from outside, where to look,
 * how a found opportunity is read and how eligibility is judged. Everything here is pure; the worker fetches and runs the Skills, the
 * ledger keeps the rows (`packages/db/src/opportunities.ts`). Nothing in this file writes anywhere outside the machine.
 */

/** Every need of a workspace, proposed, tracked and declined alike (`OpportunityNeed[]`); in the ledger, so a backup carries it. */
export const SCOUT_NEEDS_SETTING = "scout.needs";
/** Needs are worked out again for every line this often, besides a line's setup and a change of its goal or milestones. */
export const NEEDS_PERIOD_DAYS = 30;
/** A tracked need's sources are looked at once a day; polling costs no model. */
export const POLL_PERIOD_HOURS = 24;
/** At most this many new candidates of one need are read by a model in one poll, and this many pages in one reading run. */
export const CANDIDATES_PER_NEED = 5;
export const PAGES_PER_READING = 6;

export const OPPORTUNITY_NEEDS_SKILL = "crossline:crossline-research:needs";
export const OPPORTUNITY_READER_SKILL = "crossline:crossline-page-reader:opportunity";

// ── ① Needs (read by the watch migration and `watchFromProposal`; the Skill proposes watches since §17.2) ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A term on who may take part, quoted from the page; the reader's `fit` (not code) says how the person stands against it (2026-11-25). */
const TERM_SCHEMA = { type: "object", additionalProperties: false, required: ["dim", "rule", "quote"], properties: {
  dim: { type: "string", enum: [...ELIGIBILITY_DIMS] },
  rule: { type: "string", minLength: 1, maxLength: 200 },
  quote: { type: "string", maxLength: 300 } } } as const;

const FIT_LIST = (max: number) => ({ type: "array", maxItems: max, items: { type: "string", maxLength: 120 } }) as const;
/** The reader's judgement of how an opening fits the person (`OpportunityFit`). */
const FIT_SCHEMA = { type: "object", additionalProperties: false, required: ["stageFit", "directionFit", "reachable", "partialRequirements", "agentCanPrepare", "why"],
  properties: { stageFit: { type: "string", enum: [...STAGE_FITS] }, directionFit: { type: "string", enum: [...DIRECTION_FITS] }, reachable: { type: "boolean" },
    partialRequirements: FIT_LIST(5), agentCanPrepare: FIT_LIST(4), why: { type: "string", maxLength: 240 } } } as const;

export type EligibilityAccepts = { kind: "one_of" | "range" | "text"; values: string[]; min: number; max: number };
/** A term as the reader returns it. `accepts` is what readings before 2026-11-25 gave for code to compare; no reading gives it now. */
export type EligibilityTerm = EligibilityRule & { accepts?: EligibilityAccepts | undefined };
export type ProposedNeed = {
  key: string; kind: OpportunityNeed["kind"]; title: string; why: string; factIds: string[]; milestoneIds: string[];
  window: { opensMonth: number; closesMonth: number; basis: string; sourceUrl: string };
  leadDays: number; eligibility: EligibilityTerm[];
  sources: Array<Exclude<NeedSource, { kind: "site_read" }>>;
};
/** The first `YYYY-MM-DD` on or after `today` that falls in `month` (1–12), at `day` of it. */
export function nextMonthDay(today: string, month: number, day = 1): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const year = month > m || (month === m && day >= Number(today.slice(8, 10))) ? y : y + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * A proposed need as the ledger keeps it. A cycle's window is moved to its next occurrence (`YYYY-MM`), and the day preparation has to
 * start is worked back from the expected close: `leadDays` before the last day of the closing month (or before the opening, when only
 * that is known).
 */
export function needFromProposal(lineId: string, proposal: ProposedNeed, today: string): OpportunityNeed & { prepStartsOn?: string } {
  const { opensMonth, closesMonth, basis, sourceUrl } = proposal.window;
  // Anchored on the next close, so a window that is open today (November inside a September–December round) is this round, not next
  // year's; the opening is the one before that close.
  const closingDay = closesMonth ? nextMonthDay(today, closesMonth, 31) : undefined;
  const closes = closingDay?.slice(0, 7);
  const opens = opensMonth
    ? closingDay ? `${Number(closingDay.slice(0, 4)) - (opensMonth > closesMonth ? 1 : 0)}-${String(opensMonth).padStart(2, "0")}` : nextMonthDay(today, opensMonth).slice(0, 7)
    : undefined;
  const lastDay = closingDay ?? (opens ? `${opens}-01` : undefined);
  const prepStartsOn = proposal.kind === "cycle" && lastDay
    ? new Date(Date.parse(`${lastDay}T00:00:00Z`) - proposal.leadDays * 86_400_000).toISOString().slice(0, 10) : undefined;
  const window = proposal.kind === "cycle" || opens || closes
    ? { ...(opens ? { opens } : {}), ...(closes ? { closes } : {}), basis, ...(sourceUrl ? { sourceUrl } : {}) } : undefined;
  return { id: needId(lineId, proposal.key), lineId, kind: proposal.kind, title: proposal.title, why: proposal.why, factIds: proposal.factIds,
    milestoneIds: proposal.milestoneIds, ...(window ? { window } : {}), leadDays: proposal.leadDays,
    eligibility: proposal.eligibility.map(({ dim, rule, quote }) => ({ dim, rule, quote })), sources: proposal.sources, state: "proposed",
    ...(prepStartsOn && prepStartsOn > today ? { prepStartsOn } : prepStartsOn ? { prepStartsOn: today } : {}) };
}

export const needId = (lineId: string, key: string) => `need:${lineId}:${key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60)}`;

export type StoredNeed = OpportunityNeed & { prepStartsOn?: string; derivedAt?: string; decidedAt?: string };
export function readNeeds(raw: string | null | undefined): StoredNeed[] {
  try { const parsed = JSON.parse(raw ?? "[]") as StoredNeed[]; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/**
 * A new derivation merged into what is kept: a tracked or declined need keeps the person's decision (its other fields follow the new
 * reading); a proposed one nobody answered is replaced; one the new reading leaves out stays only if the person tracks it. A proposal
 * whose key the person declined before is not proposed again.
 */
export function mergeNeeds(kept: StoredNeed[], lineId: string, fresh: StoredNeed[]): StoredNeed[] {
  const freshById = new Map(fresh.map((need) => [need.id, need]));
  const others = kept.filter((need) => need.lineId !== lineId);
  const line = kept.filter((need) => need.lineId === lineId);
  const out = line.flatMap((need): StoredNeed[] => {
    const next = freshById.get(need.id);
    if (need.state === "declined") return [need];
    if (need.state === "tracking") return [next ? { ...next, state: "tracking", ...(need.decidedAt ? { decidedAt: need.decidedAt } : {}) } : need];
    return next ? [next] : [];
  });
  const known = new Set(out.map((need) => need.id));
  return [...others, ...out, ...fresh.filter((need) => !known.has(need.id))];
}

// ── ③ Reading a page ────────────────────────────────────────────────────────────────────────────────────────────────

export const OPPORTUNITY_READING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items", "blocked"], properties: {
    items: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false,
      required: ["pageId", "url", "title", "organizer", "kind", "deadlines", "startsAt", "cost", "location", "place", "eligibility", "fit", "needsAccount", "materials", "consents",
        "registrationUrl", ...CLASSIFICATION_REQUIRED],
      properties: {
        ...CLASSIFICATION_PROPERTIES,
        pageId: { type: "string", maxLength: 40 },
        url: { type: "string", maxLength: 500 },
        title: { type: "string", minLength: 2, maxLength: 140 },
        organizer: { type: "string", maxLength: 100 },
        kind: { type: "string", enum: ["event", "application"] },
        deadlines: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["day", "quote"], properties: {
          day: { type: "string", maxLength: 10 }, quote: { type: "string", minLength: 1, maxLength: 300 } } } },
        startsAt: { type: "object", additionalProperties: false, required: ["day", "quote"], properties: {
          day: { type: "string", maxLength: 10 }, quote: { type: "string", maxLength: 300 } } },
        cost: { type: "object", additionalProperties: false, required: ["known", "amount", "currency", "quote"], properties: {
          known: { type: "boolean" }, amount: { type: "number", minimum: 0 }, currency: { type: "string", maxLength: 8 }, quote: { type: "string", maxLength: 300 } } },
        location: { type: "string", maxLength: 120 },
        place: { type: "object", additionalProperties: false, required: ["mode", "city", "country", "quote"], properties: {
          mode: { type: "string", enum: ["online", "in_person", "hybrid", "unknown"] }, city: { type: "string", maxLength: 80 },
          country: { type: "string", maxLength: 60 }, quote: { type: "string", maxLength: 300 } } },
        eligibility: { type: "array", maxItems: 12, items: TERM_SCHEMA },
        fit: FIT_SCHEMA,
        needsAccount: { type: "boolean" },
        materials: { type: "array", maxItems: 10, items: { type: "string", maxLength: 80 } },
        consents: { type: "array", maxItems: 6, items: { type: "string", maxLength: 160 } },
        registrationUrl: { type: "string", maxLength: 500 } } } },
    blocked: { type: "string", maxLength: 200 } } } as const;

/** Where an opening is held as the reader gives it: city and country as the page writes them, the sentence that says so as `quote`. */
export type ReadPlace = { mode: EventPlace["mode"]; city: string; country: string; quote: string };
export type ReadItem = {
  pageId: string; url: string; title: string; organizer: string; kind: Opportunity["kind"]; deadlines: DatedQuote[]; startsAt: DatedQuote;
  cost: { known: boolean; amount: number; currency: string; quote: string }; location: string;
  /** Optional in the type for answers and fixtures written before it; the schema requires it. */
  place?: ReadPlace | undefined;
  eligibility: EligibilityTerm[]; needsAccount: boolean; materials: string[]; consents: string[]; registrationUrl: string;
  /** How it fits the person (2026-11-25); optional for answers and fixtures written before, the schema requires it. */
  fit?: OpportunityFit | undefined;
  /** The classifier's type, reason and lines (§18, reader input v3); optional for answers and fixtures written before. */
  type?: string | undefined; reason?: string | undefined; lines?: RawClassification["lines"] | undefined; lowValue?: boolean | undefined;
};
export type ReadingAnswer = { items: ReadItem[]; blocked: string };

/** Letters and digits only, lower-cased: a quote copied with other punctuation, spacing or case is still the page's own words. */
export const squashText = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const quotedIn = (quote: string, text: string) => Boolean(quote.trim()) && squashText(text).includes(squashText(quote));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * The day's year agrees with the quote: a quote that names years names this one (「the 2025 cohort closed on December 1, 2025」 is not
 * 2026-12-01, D4). A quote naming no year leaves the year to the reader, as before.
 */
export function quoteYearAgrees(day: string, quote: string): boolean {
  const years = quote.match(/(?<!\d)(19|20)\d{2}(?!\d)/g);
  return !years || years.includes(day.slice(0, 4));
}
const datedQuote = (item: DatedQuote, pageText: string) =>
  DAY.test(item.day) && quotedIn(item.quote, pageText) && quoteSupportsDate(item.day, item.quote) && quoteYearAgrees(item.day, item.quote);

// i18n-ignore: words read from pages
const MOVED = /extend|postpone|originally|moved|now due|push(ed)? back|延长|延期|推迟|改为|延至|顺延/i;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/**
 * A deadline the page says was moved (「originally October 30, 2026, now November 14, 2026」), read as the later day its own sentence names
 * after the quoted one (D7): a reader that copied only the old day no longer makes a live opening look closed.
 */
function movedDeadline(item: DatedQuote, pageText: string): DatedQuote {
  const sentence = pageText.split(/(?<=[.!?。！？])\s+|\n+/).find((part) => squashText(part).includes(squashText(item.quote)));
  if (!sentence || !MOVED.test(sentence)) return item;
  for (let n = 1; n <= 366; n += 1) {
    const day = addDays(item.day, n);
    if (quoteSupportsDate(day, sentence) && quoteYearAgrees(day, sentence)) return { day, quote: sentence.trim().slice(0, 300) };
  }
  return item;
}

const NO_PLACE: ReadPlace = { mode: "unknown", city: "", country: "", quote: "" };
/**
 * The reader's place, kept only as far as the page says it (D11): the quote must be on the page, and a city or country the quote does not
 * name is dropped (the geocoder finds a city's country; a place nobody wrote is never guessed). Anything else is unknown.
 */
function verifiedPlace(place: ReadPlace | undefined, pageText: string): ReadPlace {
  if (!place || place.mode === "unknown" || !quotedIn(place.quote, pageText)) return NO_PLACE;
  const named = (value: string) => (value.trim() && quotedIn(value, place.quote) ? value.trim() : "");
  return { mode: place.mode, city: named(place.city), country: named(place.country), quote: place.quote };
}
// i18n-ignore-start: words read from pages
const ONLINE_PLACE = /^(online|virtual|remote|zoom|线上|在线|网络)/i;
const HYBRID_PLACE = /\(?\s*(hybrid|混合)\s*\)?/i;
// i18n-ignore-end
/** A location line's city: its parts without a number (a room, a street address), so 「Engineering Hall 1800, Madison, WI」 is 「Madison, WI」. */
const cityPart = (text: string) => text.split(/[,，]/).map((part) => part.trim()).filter((part) => part && !/\d/.test(part)).join(", ");
/**
 * A place from a `location` line, for an item whose reader gave none (D11): online and hybrid by their words, else an in-person city.
 * An empty line, or one with no city left, is no place (unknown stays unknown).
 */
export function placeFromLocation(location: string | undefined): EventPlace | undefined {
  const text = location?.trim();
  if (!text) return undefined;
  if (HYBRID_PLACE.test(text)) {
    const city = cityPart(text.replace(HYBRID_PLACE, " "));
    return { mode: "hybrid", ...(city ? { city } : {}), quote: text };
  }
  if (ONLINE_PLACE.test(text)) return { mode: "online", quote: text };
  const city = cityPart(text);
  return city ? { mode: "in_person", city, quote: text } : undefined;
}
/** A location line kept only when its city (or its online word) is on the page: the reader's own words are not where the opening is. */
function locationOnPage(location: string, pageText: string): string {
  const text = location.trim();
  if (!text) return "";
  const city = ONLINE_PLACE.test(text) ? text.split(/[,，(（]/)[0]!.trim() : cityPart(text.replace(HYBRID_PLACE, " "));
  return city && quotedIn(city, pageText) ? text : "";
}

/**
 * Checks one read item against the text it was read from, as code: every deadline quote is in the page and names its day (and its year,
 * when it names one), the cost's quote is in the page, and every eligibility term quotes the page. A term that does not quote the page
 * makes the item unusable (dropping the term would make the opportunity look open to the person when it may not be); a deadline that does
 * not is dropped on its own; a deadline the page says was moved is read as its new day. Two problems make the item unusable as well:
 * `quote_absent`, a deadline or fee quoting text that is nowhere on the page (the reader read something else, or text hidden from a person:
 * D6), and `earlier_cycle`, every deadline it gave dated by the page in an earlier year than claimed and none left (an opening of a past
 * round: D4).
 */
export function checkReadItem(item: ReadItem, pageText: string): { item: ReadItem; problems: string[] } {
  const problems: string[] = [];
  const deadlines = item.deadlines.filter((deadline) => datedQuote(deadline, pageText)).map((deadline) => movedDeadline(deadline, pageText));
  if (deadlines.length < item.deadlines.length) problems.push("deadline_unquoted");
  const absent = [...item.deadlines, item.startsAt].some((dated) => dated.quote.trim() && !quotedIn(dated.quote, pageText))
    || (item.cost.known && !quotedIn(item.cost.quote, pageText));
  if (absent) problems.push("quote_absent");
  const earlier = item.deadlines.filter((deadline) => DAY.test(deadline.day) && quotedIn(deadline.quote, pageText) && !quoteYearAgrees(deadline.day, deadline.quote)
    && (deadline.quote.match(/(?<!\d)(19|20)\d{2}(?!\d)/g) ?? []).every((year) => year < deadline.day.slice(0, 4)));
  if (earlier.length && !deadlines.length) problems.push("earlier_cycle");
  const startsAt = datedQuote(item.startsAt, pageText) ? item.startsAt : { day: "", quote: "" };
  const cost = item.cost.known && !quotedIn(item.cost.quote, pageText) ? { known: false, amount: 0, currency: "", quote: "" } : item.cost;
  if (item.cost.known && !cost.known) problems.push("cost_unquoted");
  if (item.eligibility.some((term) => !quotedIn(term.quote, pageText))) problems.push("eligibility_unquoted");
  const place = verifiedPlace(item.place, pageText);
  if (item.place && item.place.mode !== "unknown" && place.mode === "unknown") problems.push("place_unquoted");
  const location = locationOnPage(item.location ?? "", pageText);
  return { item: { ...item, deadlines, startsAt, cost, location, place }, problems };
}

/** Problems that make a read item unusable: it is not what its page says (a misquoted term, a quote from elsewhere, a past round). */
export const UNUSABLE_READ = ["eligibility_unquoted", "quote_absent", "earlier_cycle"] as const;
export const readItemUnusable = (problems: string[]) => UNUSABLE_READ.some((problem) => problems.includes(problem));

/* i18n-ignore-start */
const ASKS_FOR_SECRET = /\b(passport|social security|ssn|bank account|card number|credit card|password|pin|phone number|id number|verification code)\b|护照|身份证|银行卡|密码|手机号|验证码/i;
const HANDS_OVER = /\b(reply with|send (us )?your|provide your|confirm your|verify your|enter your|submit your)\b|回复|提供|发送|填写/i;
const PRIZE_CLAIM = /\b(to claim|claim (your|the) (prize|award|reward|winnings))\b|领取(奖|奖金|奖品)/i;
const PRIZE = /\b(you have been selected for|you('ve| have) won|you are a winner)\b|恭喜(您|你)(获得|中奖|入选)|中奖/i;
/* i18n-ignore-end */
/**
 * Why a mail filed as an opportunity looks like phishing (D5), by rule: it asks for a secret identifier to be handed over by mail, or it
 * announces a prize to be claimed. A real programme collects identifiers in its own form, never by reply; such a mail is never read,
 * kept or followed (its link is not opened either).
 */
export function phishingSigns(text: string): string[] {
  const signs: string[] = [];
  if (ASKS_FOR_SECRET.test(text) && HANDS_OVER.test(text)) signs.push("asks_for_identifiers");
  if (PRIZE.test(text) && PRIZE_CLAIM.test(text)) signs.push("prize_claim");
  return signs;
}

/**
 * Whether an address a model named carries the person's identifiers in its path or query (「beacon?u=qiao」, D6). Crossline never requests
 * such an address: that request is the person's data leaving for wherever the text the model read pointed.
 */
export function carriesPersonData(url: string, identifiers: string[]): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  let rest = `${parsed.pathname} ${parsed.search} ${parsed.hash}`;
  try { rest = decodeURIComponent(rest); } catch { /* keep as is */ }
  const lower = rest.toLowerCase();
  const words = new Set(lower.split(/[^\p{L}\p{N}@._+-]+/u).flatMap((word) => [word, ...word.split(/[._+-]/)]).filter(Boolean));
  return identifiers.map((value) => value.trim().toLowerCase()).filter((value) => value.length >= 3)
    .some((value) => (value.includes("@") ? lower.includes(value) || words.has(value.split("@")[0]!) : value.split(/\s+/).some((part) => part.length >= 3 && words.has(part))));
}

/** Repair messages to the reader (model-facing). Only what a second turn can fix: a misquote of a page the run was given. */
/* i18n-ignore-start */
export function readingProblems(answer: ReadingAnswer, pages: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const item of answer.items ?? []) {
    const text = pages.get(item.pageId);
    if (item.pageId && text === undefined) { problems.push(`「${item.title}」的 pageId「${item.pageId}」不是给出的页面`); continue; }
    if (text === undefined) continue;
    const checked = checkReadItem(item, text);
    if (checked.problems.includes("eligibility_unquoted")) problems.push(`「${item.title}」有资格条款的 quote 不是页面原文，请逐字摘抄原句`);
    if (checked.problems.includes("deadline_unquoted")) problems.push(`「${item.title}」有截止日期的 quote 不是页面原文或没写出该日期`);
    if (checked.problems.includes("place_unquoted")) problems.push(`「${item.title}」的 place.quote 不是页面原文，请逐字摘抄写明举办地点的句子；页面没写地点时 mode 填 unknown`);
  }
  return problems;
}
/* i18n-ignore-end */

export function validateOpportunityReading(value: unknown, pages: Map<string, string>): ReadingAnswer {
  const answer = value as ReadingAnswer;
  if (!answer || !Array.isArray(answer.items)) throw Object.assign(new Error("OPPORTUNITY_READING_INVALID"), { detail: "items must be an array" });
  const problems = readingProblems(answer, pages);
  if (problems.length) throw Object.assign(new Error("OPPORTUNITY_READING_INVALID"), { detail: problems.slice(0, 6).join("；") }); // i18n-ignore
  return answer;
}

export const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
/** A title without its year, however written (「2026」, 「'26」): one event announced two ways is one key (D3). */
const normalTitle = (title: string) => squashText(title.replace(/['’]\d{2}(?!\d)/g, " ")).replace(/\b(20\d\d|19\d\d)\b/g, "").replace(/\s+/g, " ").trim();
/** One opportunity across sources: host + normalized title + first deadline (contract's `Opportunity.key`). */
export const opportunityKey = (url: string, title: string, deadlines: DatedQuote[]) =>
  `${hostOf(url)}|${normalTitle(title)}|${[...deadlines].map((item) => item.day).sort()[0] ?? ""}`;

/** The record's place: the reader's (checked by `checkReadItem`), else one derived from its `location` line, else none. */
function placeOf(item: ReadItem): EventPlace | undefined {
  const read = item.place;
  if (read && read.mode !== "unknown") return { mode: read.mode, ...(read.city ? { city: read.city } : {}), ...(read.country ? { country: read.country } : {}), quote: read.quote };
  return placeFromLocation(item.location);
}

/** A read item as the contract's `Opportunity` (id from its key, so a re-read lands on the same row). */
export function opportunityFromRead(item: ReadItem, input: { lineId: string; needId?: string; foundVia: NeedSource["kind"]; foundAt: string; idOf: (key: string) => string }): Opportunity {
  const url = item.url;
  const registrationHost = hostOf(item.registrationUrl) || hostOf(url);
  const key = opportunityKey(url, item.title, item.deadlines);
  const place = placeOf(item);
  return { id: input.idOf(key), key, ...(input.needId ? { needId: input.needId } : {}), lineId: input.lineId, kind: item.kind, title: item.title, organizer: item.organizer,
    url, registrationHost, deadlines: item.deadlines, ...(item.startsAt.day ? { startsAt: item.startsAt } : {}),
    cost: item.cost.known ? { amount: item.cost.amount, currency: item.cost.currency, quote: item.cost.quote } : null,
    ...(item.location ? { location: item.location } : {}), ...(place ? { place } : {}), eligibility: item.eligibility.map(({ dim, rule, quote }) => ({ dim, rule, quote })),
    needsAccount: item.needsAccount, materials: item.materials, consents: item.consents, foundVia: input.foundVia, foundAt: input.foundAt };
}

// ── ③ Eligibility, judged by the reader (the owner's decision of 2026-11-25) ───────────────────────────────────────────

/**
 * Where an answer to an eligibility term is kept: a confirmed fact of the `person` line, slot `apply.<name>` (§12). The names the
 * form-filling track also fills are the contract's `APPLICATION_SLOTS`; the rest are this track's own and not sensitive.
 */
export const DIM_SLOT: Record<Exclude<EligibilityDim, "other">, ApplicationSlot | string> = {
  degree_stage: "degree_stage", year: "year", graduation_year: "graduation_year", citizenship: "citizenship", work_authorization: "work_authorization",
  region: "country", age: "age", school: "school", field: "major", team_size: "team_size", company_stage: "company_stage"
};
export const applySlot = (name: string) => `apply.${name}`;
/** A term answered directly (its own yes or no), for terms no profile value can settle: `apply.term.<hash>`. */
export const termSlot = (rule: string) => applySlot(`term.${hashText(squashText(rule))}`);
function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

type Fact = { identityId: string; projectId: string; slot: string; value: string; status: "confirmed" | "inferred" };
/** Slots that identify the person and say nothing about fit: never handed to the reader. */
const IDENTIFYING = /name|email|phone|address|birth|id_number|passport|student_id|website|github|resume|^apply\.term\./i;
/**
 * The person as the reader judges fit against (2026-11-25): the confirmed facts of the `person` line (degree stage, school, field,
 * graduation year, citizenship, country…; never an inference, an assumption or an identifier), and what the person is looking for — the
 * active watches' titles and how each tells a find worth their attention. The stage the person is in is read from here by the model.
 */
export function readerPerson(facts: Fact[], watches: Array<{ title: string; judge: string; state: string }>): { facts: Array<{ slot: string; value: string }>; seeking: string[] } {
  return {
    facts: facts.filter((fact) => fact.identityId === "person" && fact.status === "confirmed" && fact.value.trim() && !fact.value.startsWith("假设") // i18n-ignore
      && !IDENTIFYING.test(fact.slot)).slice(0, 30).map((fact) => ({ slot: fact.slot, value: fact.value.slice(0, 120) })),
    seeking: watches.filter((watch) => watch.state === "active").map((watch) => `${watch.title}${watch.judge ? `：${watch.judge}` : ""}`.slice(0, 160)).slice(0, 12)
  };
}

/** A fit as the schema allows it, or undefined for an answer that has none or a malformed one (read as before: pushed, nothing ruled out). */
export function fitOf(value: unknown): OpportunityFit | undefined {
  const fit = value as Partial<OpportunityFit> | undefined;
  if (!fit || !(STAGE_FITS as readonly string[]).includes(fit.stageFit ?? "") || !(DIRECTION_FITS as readonly string[]).includes(fit.directionFit ?? "")) return undefined;
  const list = (items: unknown, max: number) => (Array.isArray(items) ? items : []).map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, max).map((item) => item.slice(0, 120));
  return { stageFit: fit.stageFit!, directionFit: fit.directionFit!, reachable: fit.reachable !== false, partialRequirements: list(fit.partialRequirements, 5),
    agentCanPrepare: list(fit.agentCanPrepare, 4), why: String(fit.why ?? "").trim().slice(0, 240) };
}

/**
 * The verdict on an opening, from the reader's fit (§7 as of 2026-11-25). The model decides; code only maps its fields: the wrong stage
 * or an unrelated direction is ineligible, everything else — a partial match, a stretch, an adjacent direction — is eligible and reaches
 * the person with what is missing on the card. A bar the person cannot clear (`reachable: false`: citizenship, clearance, age, another
 * school's members) is eligible too and says 「不满足」 on its card, after the reachable ones (the owner, 2026-11-26: the person decides).
 * No fit (a listed call for papers, an older answer) is eligible: when in doubt, more reaches the person, never less.
 */
export function verdictFromFit(fit: OpportunityFit | undefined, locale?: Locale): EligibilityVerdict {
  if (!fit) return { state: "eligible", basis: [] };
  const t = tFor(locale);
  const why = fit.why || t("阅读器的判断");
  if (fit.stageFit === "wrong_stage") return { state: "ineligible", failed: [{ dim: "degree_stage", rule: t("阶段不对"), why }], fit };
  if (fit.directionFit === "unrelated") return { state: "ineligible", failed: [{ dim: "field", rule: t("方向无关"), why }], fit };
  return { state: "eligible", basis: [], fit };
}

/**
 * Whether the reader's type contradicts what the person is looking for, as code reads the watch's words: a full-time job while every
 * watch of the line looks for internships. Never a verdict — the model's fit stands ("rather more than fewer") — only a `rule-fired` line
 * for the consistency review (docs/plans/harness-1125.md 「机会放宽」).
 */
export function stageConflict(type: string | undefined, fit: OpportunityFit | undefined, seeking: string[]): boolean {
  if (type !== "job" || !fit || fit.stageFit === "wrong_stage" || !seeking.length) return false;
  return seeking.every((text) => INTERN.test(text));
}

/** The answer to an eligibility question on a card read before 2026-11-25, as the value kept in the person's slot; undefined when unreadable. */
export function eligibilityAnswer(term: EligibilityTerm, answer: string): { slot: string; value: string } | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  if (term.dim === "other" || term.accepts?.kind === "text") {
    /* i18n-ignore-start: the person's words */
    if (/^(是|满足|符合|yes|y|对)/i.test(text)) return { slot: termSlot(term.rule), value: "yes" };
    if (/^(否|不|no|n)/i.test(text)) return { slot: termSlot(term.rule), value: "no" };
    /* i18n-ignore-end */
    return undefined;
  }
  return { slot: applySlot(DIM_SLOT[term.dim]), value: text.slice(0, 120) };
}

// ── ④ Ranking and urgency ───────────────────────────────────────────────────────────────────────────────────────────

const daysBetweenDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** The earliest deadline still ahead of `today` (or today's), when there is one. */
export const nextDeadline = (opportunity: Pick<Opportunity, "deadlines">, today: string) =>
  opportunity.deadlines.map((item) => item.day).filter((day) => day >= today).sort()[0];
/** Order of the offers (§7): the line's weight × how soon it closes × whether it bears on a milestone. */
export function opportunityRank(input: { deadline?: string | undefined; today: string; lineWeight: number; milestoneLinked: boolean }): number {
  const urgency = input.deadline ? 1 / (1 + Math.max(0, daysBetweenDays(input.today, input.deadline)) / 14) : 0.2;
  return input.lineWeight * urgency * (input.milestoneLinked ? 1.5 : 1);
}
/**
 * Whether a find may be pushed as a card (2026-11-25). A line holding it at the push threshold, as before (`pushable`, §18); besides, an
 * opening the reader judged in the same or an adjacent direction, as long as some line still holds it at all (each line's claim is
 * checked by code, `classifyFind`). News and papers keep the old rule.
 */
export function offerPushable(row: TaggedOpportunity & { verdict?: EligibilityVerdict | undefined }): boolean {
  if (pushable(row)) return true;
  const fit = row.verdict && row.verdict.state !== "unknown" ? row.verdict.fit : undefined;
  return !isReading(row.type) && Boolean(fit && fit.directionFit !== "unrelated") && bestRelevance(row) >= KEEP_RELEVANCE;
}
const DIRECTION_RANK: Record<string, number> = { same: 2, adjacent: 1 };
/**
 * The order offers are listed in (the brief's count, 待确认 and the weekly review, 2026-11-25): direction first (the reader's same before
 * adjacent; with no fit, a line holding it at the push threshold counts as same), then the nearest deadline, then relevance.
 */
export function offerOrder(today: string) {
  type Row = TaggedOpportunity & Pick<Opportunity, "deadlines"> & { verdict?: EligibilityVerdict | undefined };
  const direction = (row: Row) => {
    const fit = row.verdict && row.verdict.state !== "unknown" ? row.verdict.fit : undefined;
    return fit ? DIRECTION_RANK[fit.directionFit] ?? 0 : pushable(row) ? 2 : 1;
  };
  // One the person cannot clear (`reachable: false`, shown 「不满足」) comes after every one they can.
  const reach = (row: Row) => row.verdict && row.verdict.state !== "unknown" && row.verdict.fit?.reachable === false ? 0 : 1;
  return (a: Row, b: Row) => reach(b) - reach(a) || direction(b) - direction(a) || (nextDeadline(a, today) ?? "9999").localeCompare(nextDeadline(b, today) ?? "9999")
    || bestRelevance(b) - bestRelevance(a);
}
/** The latest day preparation can start, worked back from the deadline by the need's lead time; undefined without a deadline. */
export function prepStartFor(deadline: string | undefined, leadDays: number): string | undefined {
  return deadline ? new Date(Date.parse(`${deadline}T00:00:00Z`) - leadDays * 86_400_000).toISOString().slice(0, 10) : undefined;
}

// ── ② Sources read without a model ──────────────────────────────────────────────────────────────────────────────────

/** A posting as a public job board gives it; its text still goes to the reader for eligibility terms. */
export type Posting = { id: string; title: string; url: string; location: string; text: string; deadline?: DatedQuote | undefined };

/** Internship words, as words: 「internal」 and 「international」 are not internships. */
// rule: opportunity.stage-conflict
export const INTERN = /\b(intern|interns|internship|internships|co-?op|summer student)\b|实习/i;

const decodeEntities = (html: string) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
export const textOfHtml = (html: string) => decodeEntities(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** Postings of one public board (Greenhouse `?content=true`, Lever `?mode=json`, Ashby), the ones whose title matches `query`. */
export function parsePostings(provider: "greenhouse" | "lever" | "ashby", body: unknown, query: string): Posting[] {
  const wanted = query.trim() ? new RegExp(query.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i") : INTERN;
  const matches = (title: string) => wanted.test(title) && (wanted !== INTERN || INTERN.test(title));
  const out: Posting[] = [];
  if (provider === "greenhouse") {
    for (const job of ((body as { jobs?: Array<Record<string, unknown>> })?.jobs ?? [])) {
      const title = String(job.title ?? "");
      if (!matches(title)) continue;
      const deadline = typeof job.application_deadline === "string" && job.application_deadline ? String(job.application_deadline).slice(0, 10) : "";
      out.push({ id: String(job.id), title, url: String(job.absolute_url ?? ""), location: String((job.location as { name?: string } | undefined)?.name ?? ""),
        text: textOfHtml(String(job.content ?? "")).slice(0, 12_000),
        ...(DAY.test(deadline) ? { deadline: { day: deadline, quote: `application_deadline: ${String(job.application_deadline)}` } } : {}) });
    }
  } else if (provider === "lever") {
    for (const job of (Array.isArray(body) ? body as Array<Record<string, unknown>> : [])) {
      const title = String(job.text ?? "");
      const commitment = String((job.categories as { commitment?: string } | undefined)?.commitment ?? "");
      if (!matches(`${title} ${commitment}`)) continue;
      out.push({ id: String(job.id), title, url: String(job.hostedUrl ?? ""), location: String((job.categories as { location?: string } | undefined)?.location ?? ""),
        text: [job.descriptionPlain, ...((job.lists as Array<{ text?: string; content?: string }> | undefined) ?? []).map((list) => `${list.text ?? ""}\n${textOfHtml(String(list.content ?? ""))}`), job.additionalPlain]
          .filter(Boolean).join("\n").slice(0, 12_000) });
    }
  } else {
    for (const job of ((body as { jobs?: Array<Record<string, unknown>> })?.jobs ?? [])) {
      const title = String(job.title ?? "");
      if (job.isListed === false || !matches(`${title} ${String(job.employmentType ?? "")}`)) continue;
      out.push({ id: String(job.id), title, url: String(job.jobUrl ?? ""), location: String(job.location ?? ""),
        text: String(job.descriptionPlain ?? textOfHtml(String(job.descriptionHtml ?? ""))).slice(0, 12_000) });
    }
  }
  return out.filter((posting) => /^https:\/\//.test(posting.url));
}

export const boardUrl = (provider: "greenhouse" | "lever" | "ashby", board: string) => provider === "greenhouse"
  ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`
  : provider === "lever" ? `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`
  : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;

/** The conference deadline lists (§6): ccfddl's one file of every conference, and Hugging Face's one file per conference. */
export const CCFDDL_URL = "https://ccfddl.com/conference/allconf.yml";
export const aiDeadlinesUrl = (name: string) => `https://raw.githubusercontent.com/huggingface/ai-deadlines/main/src/data/conferences/${encodeURIComponent(name.toLowerCase().replace(/[^a-z0-9-]/g, ""))}.yml`;

/** A conference deadline read from a list: the deadline's own YAML line is its quote. Calls for papers carry no eligibility terms. */
export type ListedDeadline = { title: string; url: string; deadline: DatedQuote; startsAt?: DatedQuote | undefined; place: string; note: string };

/** ccfddl's parsed YAML (`allconf.yml`): conferences whose title, description or dblp key match `query`, deadlines from `today` on. */
export function ccfddlDeadlines(parsed: unknown, query: string, today: string): ListedDeadline[] {
  const q = squashText(query);
  const out: ListedDeadline[] = [];
  for (const conf of Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []) {
    const name = `${String(conf.title ?? "")} ${String(conf.description ?? "")} ${String(conf.dblp ?? "")}`;
    if (!q || !squashText(name).includes(q)) continue;
    for (const edition of (conf.confs as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const round of (edition.timeline as Array<Record<string, unknown>> | undefined) ?? []) {
        const raw = String(round.deadline ?? "");
        const day = raw.slice(0, 10);
        if (!DAY.test(day) || day < today) continue;
        out.push({ title: `${String(conf.title)} ${String(edition.year ?? "")}${round.comment ? ` · ${String(round.comment)}` : ""}`.trim(),
          url: String(edition.link ?? ""), deadline: { day, quote: `deadline: '${raw}'` }, place: String(edition.place ?? ""),
          note: `${String(conf.description ?? "")} (${String(edition.timezone ?? "")})` });
      }
    }
  }
  return out.filter((item) => /^https?:\/\//.test(item.url)).map((item) => ({ ...item, url: item.url.replace(/^http:/, "https:") }));
}

/** Hugging Face's per-conference YAML: the paper deadline (else the first) of each edition from `today` on. */
export function aiDeadlines(parsed: unknown, today: string): ListedDeadline[] {
  const out: ListedDeadline[] = [];
  for (const edition of Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []) {
    const rounds = (edition.deadlines as Array<Record<string, unknown>> | undefined) ?? [];
    const round = rounds.find((item) => item.type === "paper") ?? rounds[0];
    const raw = String(round?.date ?? "");
    const day = raw.slice(0, 10);
    if (!DAY.test(day) || day < today) continue;
    const start = String(edition.start ?? "");
    out.push({ title: `${String(edition.title ?? "")} ${String(edition.year ?? "")}`.trim(), url: String(edition.link ?? "").replace(/^http:/, "https:"),
      deadline: { day, quote: `date: '${raw}'` }, ...(DAY.test(start) ? { startsAt: { day: start, quote: `start: '${start}'` } } : {}),
      place: [edition.city, edition.country].filter(Boolean).join(", "), note: String(edition.full_name ?? "") });
  }
  return out.filter((item) => /^https:\/\//.test(item.url));
}

/** A listed deadline as the contract's `Opportunity`: a call for papers is open to anyone who submits, so it carries no terms. */
export function opportunityFromListed(item: ListedDeadline, input: { lineId: string; needId?: string; foundAt: string; idOf: (key: string) => string }): Opportunity {
  const key = opportunityKey(item.url, item.title, [item.deadline]);
  const place = placeFromLocation(item.place);
  return { id: input.idOf(key), key, ...(input.needId ? { needId: input.needId } : {}), lineId: input.lineId, kind: "application", title: item.title,
    organizer: item.note.slice(0, 100), url: item.url, registrationHost: hostOf(item.url), deadlines: [item.deadline], ...(item.startsAt ? { startsAt: item.startsAt } : {}),
    cost: null, ...(item.place ? { location: item.place } : {}), ...(place ? { place } : {}), eligibility: [], needsAccount: true, materials: [], consents: [], foundVia: "deadline_list", foundAt: input.foundAt };
}

/** Devpost's public listing (`/api/hackathons?search=…`, undocumented, read at most daily): hackathons open or upcoming. */
export type DevpostHackathon = { title: string; url: string; dates: string; location: string; organizer: string };
export function devpostHackathons(body: unknown): DevpostHackathon[] {
  return ((body as { hackathons?: Array<Record<string, unknown>> })?.hackathons ?? [])
    .filter((item) => item.open_state === "open" || item.open_state === "upcoming")
    .map((item) => ({ title: String(item.title ?? ""), url: String(item.url ?? ""), dates: String(item.submission_period_dates ?? ""),
      location: String((item.displayed_location as { location?: string } | undefined)?.location ?? ""), organizer: String(item.organization_name ?? "") }))
    .filter((item) => /^https:\/\//.test(item.url) && item.title);
}
