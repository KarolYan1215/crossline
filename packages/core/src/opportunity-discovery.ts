import { quoteSupportsDate } from "./date-schema";
import { countryKey } from "./feasibility";
import { tFor, type Locale } from "./i18n";
import { ELIGIBILITY_DIMS, type ApplicationSlot, type DatedQuote, type EligibilityDim, type EligibilityRule, type EligibilityVerdict, type NeedSource, type Opportunity,
  type OpportunityNeed } from "./opportunity";

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

export const OPPORTUNITY_NEEDS_SKILL = "crossline:crossline-opportunity-needs";
export const OPPORTUNITY_READER_SKILL = "crossline:crossline-opportunity-reader";

// ── ① Needs (read by the watch migration and `watchFromProposal`; the Skill proposes watches since §17.2) ────────────────────────────────────────────────────────────────────────────────────────────────────────

const TERM_SCHEMA = { type: "object", additionalProperties: false, required: ["dim", "rule", "quote", "accepts"], properties: {
  dim: { type: "string", enum: [...ELIGIBILITY_DIMS] },
  rule: { type: "string", minLength: 1, maxLength: 200 },
  quote: { type: "string", maxLength: 300 },
  accepts: { type: "object", additionalProperties: false, required: ["kind", "values", "min", "max"], properties: {
    kind: { type: "string", enum: ["one_of", "range", "text"] },
    values: { type: "array", maxItems: 12, items: { type: "string", maxLength: 60 } },
    min: { type: "number" }, max: { type: "number" } } } } } as const;

export type EligibilityAccepts = { kind: "one_of" | "range" | "text"; values: string[]; min: number; max: number };
/** A term as the reader returns it: the contract's rule plus what it accepts, so code (not a model) can compare it with the person. */
export type EligibilityTerm = EligibilityRule & { accepts: EligibilityAccepts };
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
      required: ["pageId", "url", "title", "organizer", "kind", "deadlines", "startsAt", "cost", "location", "eligibility", "needsAccount", "materials", "consents", "registrationUrl"],
      properties: {
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
        eligibility: { type: "array", maxItems: 12, items: TERM_SCHEMA },
        needsAccount: { type: "boolean" },
        materials: { type: "array", maxItems: 10, items: { type: "string", maxLength: 80 } },
        consents: { type: "array", maxItems: 6, items: { type: "string", maxLength: 160 } },
        registrationUrl: { type: "string", maxLength: 500 } } } },
    blocked: { type: "string", maxLength: 200 } } } as const;

export type ReadItem = {
  pageId: string; url: string; title: string; organizer: string; kind: Opportunity["kind"]; deadlines: DatedQuote[]; startsAt: DatedQuote;
  cost: { known: boolean; amount: number; currency: string; quote: string }; location: string; eligibility: EligibilityTerm[]; needsAccount: boolean;
  materials: string[]; consents: string[]; registrationUrl: string;
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
  return { item: { ...item, deadlines, startsAt, cost }, problems };
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

/** A read item as the contract's `Opportunity` (id from its key, so a re-read lands on the same row). */
export function opportunityFromRead(item: ReadItem, input: { lineId: string; needId?: string; foundVia: NeedSource["kind"]; foundAt: string; idOf: (key: string) => string }): Opportunity {
  const url = item.url;
  const registrationHost = hostOf(item.registrationUrl) || hostOf(url);
  const key = opportunityKey(url, item.title, item.deadlines);
  return { id: input.idOf(key), key, ...(input.needId ? { needId: input.needId } : {}), lineId: input.lineId, kind: item.kind, title: item.title, organizer: item.organizer,
    url, registrationHost, deadlines: item.deadlines, ...(item.startsAt.day ? { startsAt: item.startsAt } : {}),
    cost: item.cost.known ? { amount: item.cost.amount, currency: item.cost.currency, quote: item.cost.quote } : null,
    ...(item.location ? { location: item.location } : {}), eligibility: item.eligibility.map(({ dim, rule, quote }) => ({ dim, rule, quote })),
    needsAccount: item.needsAccount, materials: item.materials, consents: item.consents, foundVia: input.foundVia, foundAt: input.foundAt };
}

// ── ③ Eligibility, judged by code ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where the answer to each dimension is kept: a confirmed fact of the `person` line, slot `apply.<name>` (§12). The names the form-filling
 * track also fills are the contract's `APPLICATION_SLOTS`; the rest are this track's own and not sensitive.
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

export const DEGREE_STAGES = ["high_school", "undergraduate", "masters", "phd", "postdoc", "graduate", "professional"] as const;
/** A degree stage in words (a fact, an answer) as one of `DEGREE_STAGES`. */
export function degreeStageOf(text: string): string | undefined {
  const value = text.toLowerCase();
  /* i18n-ignore-start: patterns matched against what the person wrote */
  if (/post-?doc|博士后/.test(value)) return "postdoc";
  if (/ph\.?\s?d|doctor|博士|博一|博二|博三|博四|博五/.test(value)) return "phd";
  if (/master|m\.?s\.?\b|msc|硕士|研究生|研一|研二|研三/.test(value)) return "masters";
  if (/undergrad|bachelor|b\.?s\.?\b|本科|大一|大二|大三|大四/.test(value)) return "undergraduate";
  if (/high school|高中/.test(value)) return "high_school";
  if (/working|professional|在职|工作/.test(value)) return "professional";
  /* i18n-ignore-end */
  return undefined;
}

type Fact = { identityId: string; projectId: string; slot: string; value: string; status: "confirmed" | "inferred" };
export type Applicant = Partial<Record<EligibilityDim, { value: string; factId: string; slot?: string }>> & { terms: Record<string, { meets: boolean; factId: string }> };

/** Slot names an interview used for the same thing before `apply.*` existed, tried after the person's own `apply.*` answer. */
const FACT_HINTS: Partial<Record<EligibilityDim, RegExp>> = {
  /* i18n-ignore-start: slot names written by the interview */
  degree_stage: /degree|学位|学历|stage|program|年级|education/i,
  school: /school|university|学校|院校|大学|institution/i,
  field: /major|field|专业|方向|discipline/i,
  graduation_year: /graduat|毕业/i,
  region: /country|city|location|所在地|城市|国家|地区|residence/i,
  citizenship: /citizen|nationality|国籍/i,
  work_authorization: /visa|work_?auth|签证|工作许可/i
  /* i18n-ignore-end */
};

/** What the ledger knows about the person for each dimension, from confirmed facts only (an inference never decides eligibility). */
export function applicantFrom(facts: Fact[]): Applicant {
  const confirmed = facts.filter((fact) => fact.status === "confirmed" && fact.value.trim() && !fact.value.startsWith("假设")); // i18n-ignore
  const id = (fact: Fact) => `${fact.identityId}/${fact.projectId}/${fact.slot}`;
  const applicant: Applicant = { terms: {} };
  for (const fact of confirmed) {
    if (!fact.slot.startsWith("apply.term.")) continue;
    applicant.terms[fact.slot] = { meets: /^(yes|true|是|满足|符合|y)$/i.test(fact.value.trim()), factId: id(fact) }; // i18n-ignore
  }
  for (const dim of ELIGIBILITY_DIMS) {
    if (dim === "other") continue;
    const slot = applySlot(DIM_SLOT[dim]);
    const own = confirmed.find((fact) => fact.slot === slot);
    const hint = FACT_HINTS[dim];
    // A slot name alone says little across lines (an investment line's `stage`, a course's `meeting_location`): only the person's own
    // facts are read by name, and a degree stage from another line only when its value reads as one.
    const found = own ?? (hint ? confirmed.find((fact) => !fact.slot.startsWith("apply.") && hint.test(fact.slot)
      && (fact.identityId === "person" || (dim === "degree_stage" && degreeStageOf(fact.value) !== undefined))) : undefined);
    if (found) applicant[dim] = { value: found.value, factId: id(found), ...(own ? { slot } : {}) };
  }
  return applicant;
}

const NUMERIC: EligibilityDim[] = ["year", "graduation_year", "age", "team_size"];
const numberIn = (text: string) => { const match = /\d+(\.\d+)?/.exec(text); return match ? Number(match[0]) : undefined; };
const same = (a: string, b: string) => { const x = squashText(a), y = squashText(b); return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x)); };

// i18n-ignore-start: words read from pages and facts, never shown
const EU = ["at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "ie", "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk", "si", "es", "se"];
const EEA = [...EU, "is", "li", "no"];
const COUNTRY_GROUPS: Record<string, string[]> = { eu: EU, "european union": EU, 欧盟: EU, eea: EEA, "european economic area": EEA, 欧洲经济区: EEA };
/** Words around a country name in a clause or a fact ("U.S. citizens", 「居住于欧盟成员国」), dropped before the name is keyed. */
const COUNTRY_NOISE = /\b(citizens?|citizenship|nationals?|nationality|passport holders?|residing|reside|residents?|living|based|located|in|of|from|an?|the|any|member states?|countries|country|only)\b|公民|国籍|居住于|居住在|居民|成员国|国家|地区|仅限|籍/gi;
/** Residency is not citizenship: a citizenship clause that also admits residents cannot be settled by the person's citizenship alone. */
const RESIDENCY = /permanent resident|green card|lawful|asylee|refugee|daca|永久居民|绿卡|难民/i;
const STEM_FIELD = /engineer|comput|electrical|science|math|physic|chemi|biolog|statist|data|robot|工程|计算机|电子|电气|数学|物理|化学|生物|统计|数据|理工/i;
const OPEN_TO_ALL = /open to (the )?(general )?(public|everyone|all|anyone)|anyone (may|can)|no (eligibility )?restrictions?|向公众开放|面向公众|对所有人开放|任何人都?可/i;
const ANY_FIELD = /\bany (field|discipline|major|background|subject)s?\b|\ball (fields|disciplines|majors|backgrounds)\b|不限专业|任意专业|任何专业/i;
const ANY_STEM = /\b(any|all)\s+stem\b|stem (field|discipline|major)s?|任意 ?stem|任何 ?stem/i;
// i18n-ignore-end

/**
 * The countries a clause or a fact names, as keys ("U.S. citizen" → us; 「欧盟成员国」 → the 27). Every piece must name a known country or
 * group, or there is no answer: an unrecognised word is a question, never a refusal.
 */
export function countriesIn(text: string): Set<string> | undefined {
  const pieces = text.toLowerCase().split(/,|;|\/|\bor\b|\band\b|、|，|或|和|及/)
    .map((piece) => piece.replace(COUNTRY_NOISE, " ").replace(/[()（）]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!pieces.length) return undefined;
  const out = new Set<string>();
  for (const piece of pieces) {
    const group = COUNTRY_GROUPS[piece];
    if (group) { for (const code of group) out.add(code); continue; }
    const code = countryKey(piece);
    if (!/^[a-z]{2}$/.test(code)) return undefined;
    out.add(code);
  }
  return out;
}
/** The one country a person's fact names: the last piece that keys as one ("Madison, Wisconsin, United States" → us). */
function personCountry(value: string): string | undefined {
  for (const piece of value.split(/,|，/).reverse()) {
    const found = countriesIn(piece);
    if (found?.size === 1) return [...found][0];
  }
  return undefined;
}
/**
 * Citizenship and region compared by country, from what the clause accepts or, for a clause the reader gave as text, from its own words:
 * the person's country outside every accepted one is a clear no (D2), spellings of one country are one key.
 */
function countryMeets(term: EligibilityTerm, value: string): boolean | undefined {
  const sources = term.accepts.kind === "text" || !term.accepts.values.length ? [term.rule] : term.accepts.values;
  if (term.dim === "citizenship" && [term.rule, ...sources].some((item) => RESIDENCY.test(item))) return undefined;
  const accepted = new Set<string>();
  for (const item of sources) {
    const found = countriesIn(item);
    if (!found) return undefined;
    for (const code of found) accepted.add(code);
  }
  const mine = personCountry(value);
  if (!mine || !accepted.size) return undefined;
  return accepted.has(mine);
}
/** A clause that restricts nothing ("open to the public", 「不限专业」) is met by anyone; "any STEM discipline" by a STEM field on record. */
function broadMeets(term: EligibilityTerm, applicant: Applicant): boolean {
  if (OPEN_TO_ALL.test(term.rule) || ANY_FIELD.test(term.rule)) return true;
  return ANY_STEM.test(term.rule) && STEM_FIELD.test(applicant.field?.value ?? "");
}
const COUNTRY_DIMS: EligibilityDim[] = ["citizenship", "region"];

/** The question put to the person for a term the ledger cannot settle, in their language. */
export function eligibilityQuestion(term: EligibilityTerm, locale?: Locale): string {
  const t = tFor(locale);
  if (term.dim === "other" || term.accepts.kind === "text") return t("是否满足：{{rule}}", { rule: term.rule });
  return t("{{dim}}是什么？（条件：{{rule}}）", { dim: t(ELIGIBILITY_DIM_LABEL[term.dim]), rule: term.rule });
}
export const ELIGIBILITY_DIM_LABEL: Record<EligibilityDim, string> = {
  degree_stage: "学历阶段", year: "年级", graduation_year: "毕业年份", citizenship: "国籍", work_authorization: "工作许可", region: "所在地区", age: "年龄",
  school: "学校", field: "专业领域", team_size: "团队人数", company_stage: "公司阶段", other: "其他条件"
};

/**
 * The verdict on an opportunity's terms (§7), by code: every term met → eligible; one no fact can settle → unknown, with its question; one
 * clearly not met → ineligible. Citizenship and region are compared by country key; a school or field that does not match is a question, never a refusal: two
 * spellings of one country must not turn the person away.
 */
export function judgeEligibility(terms: EligibilityTerm[], applicant: Applicant, locale?: Locale): EligibilityVerdict {
  const basis: Array<{ dim: EligibilityDim; factId?: string; slot?: string }> = [];
  const questions: Array<{ dim: EligibilityDim; question: string }> = [];
  const failed: Array<{ dim: EligibilityDim; rule: string; why: string }> = [];
  const t = tFor(locale);
  for (const term of terms) {
    const direct = applicant.terms[termSlot(term.rule)];
    if (direct) {
      if (direct.meets) basis.push({ dim: term.dim, factId: direct.factId, slot: termSlot(term.rule) });
      else failed.push({ dim: term.dim, rule: term.rule, why: t("本人确认不满足") });
      continue;
    }
    if (broadMeets(term, applicant)) { basis.push({ dim: term.dim, ...(term.dim === "field" && applicant.field ? { factId: applicant.field.factId } : {}) }); continue; }
    const known = term.dim === "other" ? undefined : applicant[term.dim];
    const byCountry = COUNTRY_DIMS.includes(term.dim);
    if (!known || (term.accepts.kind === "text" && !byCountry) || term.dim === "other") { questions.push({ dim: term.dim, question: eligibilityQuestion(term, locale) }); continue; }
    const met = byCountry ? countryMeets(term, known.value) : meets(term, known.value);
    if (met === true) basis.push({ dim: term.dim, factId: known.factId, ...(known.slot ? { slot: known.slot } : {}) });
    else if (met === false) failed.push({ dim: term.dim, rule: term.rule, why: t("记录为「{{value}}」", { value: known.value.slice(0, 60) }) });
    else questions.push({ dim: term.dim, question: eligibilityQuestion(term, locale) });
  }
  if (failed.length) return { state: "ineligible", failed };
  if (questions.length) return { state: "unknown", questions };
  return { state: "eligible", basis };
}

function meets(term: EligibilityTerm, value: string): boolean | undefined {
  const { accepts } = term;
  if (NUMERIC.includes(term.dim) || accepts.kind === "range") {
    const n = numberIn(value);
    if (n === undefined) return undefined;
    if (accepts.kind !== "range") return accepts.values.some((item) => numberIn(item) === n) ? true : undefined;
    return (accepts.min < 0 || n >= accepts.min) && (accepts.max < 0 || n <= accepts.max);
  }
  if (term.dim === "degree_stage") {
    const stage = degreeStageOf(value);
    if (!stage) return undefined;
    const wanted = accepts.values.map((item) => DEGREE_STAGES.includes(item as never) ? item : degreeStageOf(item) ?? item);
    if (wanted.includes(stage)) return true;
    if (wanted.includes("graduate") && (stage === "masters" || stage === "phd")) return true;
    return wanted.some((item) => DEGREE_STAGES.includes(item as never)) ? false : undefined;
  }
  return accepts.values.some((item) => same(item, value)) ? true : undefined;
}

/** The answer to an eligibility question as the value kept in the person's slot; undefined when it cannot be read. */
export function eligibilityAnswer(term: EligibilityTerm, answer: string): { slot: string; value: string } | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  if (term.dim === "other" || term.accepts.kind === "text") {
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
/** The latest day preparation can start, worked back from the deadline by the need's lead time; undefined without a deadline. */
export function prepStartFor(deadline: string | undefined, leadDays: number): string | undefined {
  return deadline ? new Date(Date.parse(`${deadline}T00:00:00Z`) - leadDays * 86_400_000).toISOString().slice(0, 10) : undefined;
}

// ── ② Sources read without a model ──────────────────────────────────────────────────────────────────────────────────

/** A posting as a public job board gives it; its text still goes to the reader for eligibility terms. */
export type Posting = { id: string; title: string; url: string; location: string; text: string; deadline?: DatedQuote | undefined };

/** Internship words, as words: 「internal」 and 「international」 are not internships. */
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
  return { id: input.idOf(key), key, ...(input.needId ? { needId: input.needId } : {}), lineId: input.lineId, kind: "application", title: item.title,
    organizer: item.note.slice(0, 100), url: item.url, registrationHost: hostOf(item.url), deadlines: [item.deadline], ...(item.startsAt ? { startsAt: item.startsAt } : {}),
    cost: null, ...(item.place ? { location: item.place } : {}), eligibility: [], needsAccount: true, materials: [], consents: [], foundVia: "deadline_list", foundAt: input.foundAt };
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
