import { occurrences, type FixedEvent } from "./fixed-events";
import { squashText } from "./opportunity-discovery";
import { mailObligation, type EventObligation, type EventTiming, type MailStructure, type ObligationBasis } from "./obligation";

/**
 * Mail about something the person could go to (a talk, an info session, an activity, a meeting) is asked about, not planned (the owner's
 * decision of 2026-11-10): one card 「要去吗」 with how relevant it is and its line. Only 去 makes it a fixed event, and only a fixed event
 * reaches a calendar; 不去 drops it. Mass notices of low relevance are listed in the weekly review instead of asked. A personal invitation
 * (导师约见、面试、组会) is still asked, with 去 as the default and ahead of everything else. Nothing from a mail ever reaches a calendar
 * without the person's 去.
 *
 * Since 2026-11-11 (§2 of docs/plans/2026-11-11-walkthrough-decisions.md) each event also carries `timing` and `obligation`
 * (`obligation.ts`): a required one from a source the person confirmed is on Crossline's own schedule as busy time without a question
 * (state `fixed`) — still on no calendar, which only 去 writes — a likely one is asked (relevance ≥ `LIKELY_RELEVANCE`), an optional one
 * waits in the weekly review. Events recorded before then are read as they are; nothing is migrated.
 */
export const MAIL_EVENTS_SETTING = "mail.events";
/** Kept this many, newest last; past ones are dropped first. */
export const MAIL_EVENTS_KEEP = 120;
/** Open cards at a time: personal first, then the most relevant. */
export const MAIL_EVENT_ASKS = 4;

/**
 * Going to something — a talk, a rehearsal, a forum, an exam sitting — said with the verb first. It has a day and a time and is over when
 * that passes; it is never work to place in free hours (W-253, W-256: nine 「参加…」 tasks from mail sat in the owner's plan as overdue,
 * and an exam as a movable half hour). Preparing for it (「复习…，并参加小测」) starts with another verb and stays work.
 */
const ATTENDING = /^\s*(参加|出席|参观|观看|旁听|attend\b|join\b)/i;
export function isAttending(text: string): boolean {
  return ATTENDING.test(text);
}

const LEADING_DAY = /^\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\/\d{1,2})\s*(上午|中午|下午|傍晚|晚上|晚间|早上)?\s*(在\s*)?/;
/**
 * What is attended, as a list names it: without the verb, the day (said beside it from the task's own date) and 「在…举行的」, so the part
 * that tells one event from another comes first. Cut from the front, 「参加 11 月 6 日在 Lev…」 named nothing (2026-11-11). Only the first
 * clause: what follows (「，并保留参会记录。」) is about the task, not the event.
 */
export function attendedName(text: string): string {
  const rest = text.trim().replace(ATTENDING, "").replace(LEADING_DAY, "").trim();
  const held = /^.*?(举行|召开|举办)的\s*(.+)$/.exec(rest);
  const name = (held?.[2] ?? rest).trim();
  const clause = name.search(/[，。；;！？]/);
  return (clause > 0 ? name.slice(0, clause) : name).trim() || text.trim();
}

/** What the triage model read about an event in the mail; empty strings and 0 when the mail is not one. */
export type MailMeetReading = { date: string; start: string; end: string; location: string; lineId: string;
  /** 0–100: how much it serves the person's lines and long-term goals. */
  relevance: number;
  /** Addressed to the person in particular (an advisor's meeting, an interview, their own group meeting), not a list's notice. */
  personal: boolean;
  /** One sentence copied exactly from the mail that names the day. */
  quote: string;
  /**
   * One sentence copied exactly from the mail saying attendance is required (「必须参加」「attendance is required」), or empty. Evidence
   * only: it can make an event `likely`, never `required` by itself (`mailObligation`). Optional for answers recorded before it existed.
   */
  required?: string;
  /** Who sent it, as the mail shows: the person's advisor, a course's staff (instructor, TA, course office), or anyone else. */
  senderRole?: "advisor" | "course_staff" | "other" };

/** `fixed`: required and from a source the person confirmed — on Crossline's own schedule as busy time, never asked, never published by itself. */
export type MailEventState = "asked" | "digest" | "go" | "skip" | "fixed";
export type MailEvent = {
  /** Stable for the mail (its message key). */
  id: string;
  title: string; date: string; start: string; end: string; location: string; lineId: string;
  relevance: number; personal: boolean;
  from: string; subject: string;
  state: MailEventState;
  at: string; decidedAt?: string;
  /** The sender's address: what the person's per-source rules are keyed by. Absent on events recorded before 2026-11-11. */
  source?: string;
  timing?: EventTiming; obligation?: EventObligation; basis?: ObligationBasis;
};

export const MAIL_MEET_SHAPE = {
  type: "object", additionalProperties: false, required: ["date", "start", "end", "location", "lineId", "relevance", "personal", "quote", "required", "senderRole"], properties: {
    date: { type: "string", maxLength: 10 }, start: { type: "string", maxLength: 5 }, end: { type: "string", maxLength: 5 },
    location: { type: "string", maxLength: 120 }, lineId: { type: "string", maxLength: 128 },
    relevance: { type: "integer", minimum: 0, maximum: 100 }, personal: { type: "boolean" }, quote: { type: "string", maxLength: 300 },
    required: { type: "string", maxLength: 300 }, senderRole: { type: "string", enum: ["advisor", "course_staff", "other"] } }
} as const;

/**
 * The person's rules per source (2026-11-11, §2.6 of the decisions page): two 不去 in a row from a sender cap it at `optional`; 去 to one of
 * its events that was required or said to be required lets it be `required` directly. Shown in settings, each one deletable.
 */
export const MAIL_EVENT_RULES_SETTING = "mail.events.rules";
export type MailEventRule = { source: string; cap: "optional" | "required"; why: "skipped_twice" | "went"; at: string;
  /** The event the rule was learnt from, by title. */
  example: string };
export function readMailEventRules(raw: string | null | undefined): MailEventRule[] {
  try { const list = JSON.parse(raw ?? "[]") as unknown; return Array.isArray(list) ? list.filter((item): item is MailEventRule => !!item && typeof item === "object"
    && typeof (item as MailEventRule).source === "string" && ((item as MailEventRule).cap === "optional" || (item as MailEventRule).cap === "required")) : []; }
  catch { return []; }
}
/** The rules after the person answered `id`: the source's rule replaced when this answer makes one, the rest as they were. */
export function mailEventRulesAfter(list: readonly MailEvent[], rules: readonly MailEventRule[], id: string, decision: "go" | "skip", at: string): MailEventRule[] {
  const event = list.find((item) => item.id === id);
  const source = event?.source;
  if (!event || !source) return [...rules];
  let cap: MailEventRule["cap"] | undefined;
  if (decision === "go" && (event.obligation === "required" || event.basis === "keyword")) cap = "required";
  if (decision === "skip") {
    const answered = list.filter((item) => item.source === source && (item.state === "go" || item.state === "skip") && item.decidedAt)
      .sort((a, b) => a.decidedAt!.localeCompare(b.decidedAt!));
    if (answered.length >= 2 && answered.slice(-2).every((item) => item.state === "skip")) cap = "optional";
  }
  if (!cap) return [...rules];
  return [...rules.filter((rule) => rule.source !== source), { source, cap, why: cap === "optional" ? "skipped_twice" : "went", at, example: event.title.slice(0, 80) }];
}

const WEEKDAYS: Array<[RegExp, number]> = [
  // i18n-ignore-start: matched against the mail's own words
  [/\bsun(day)?\b|周日|周天|星期日|星期天|礼拜日|礼拜天/i, 0], [/\bmon(day)?\b|周一|星期一|礼拜一/i, 1], [/\btue(s|sday)?\b|周二|星期二|礼拜二/i, 2],
  [/\bwed(nesday)?\b|周三|星期三|礼拜三/i, 3], [/\bthu(r|rs|rsday)?\b|周四|星期四|礼拜四/i, 4], [/\bfri(day)?\b|周五|星期五|礼拜五/i, 5],
  [/\bsat(urday)?\b|周六|星期六|礼拜六/i, 6]
  // i18n-ignore-end
];
/** The quote names one weekday and the day read is not it (a relative day counted from today instead of the mail, a misread). */
function weekdayContradicts(quote: string, date: string): boolean {
  const named = WEEKDAYS.filter(([pattern]) => pattern.test(quote)).map(([, day]) => day);
  return named.length === 1 && named[0] !== new Date(`${date}T12:00:00Z`).getUTCDay();
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const plusHour = (time: string) => { const [h, m] = time.split(":").map(Number) as [number, number]; const total = Math.min(23 * 60 + 59, h * 60 + m + 60); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };

/**
 * The event as code accepts it: a real day not in the past nor before the mail was sent, a start time, a quote found in the mail itself
 * (the model reads, it never supplies a day of its own) whose weekday, if it names one, is the day's, a line the person has. No end → one
 * hour. Undefined when any of that fails: the mail is then information.
 *
 * Its obligation is code's (`mailObligation`): the headers and invitation the connector read (`structure`, for the account's `person`),
 * the person's rule for the sender (`rules`), and the model's fields only as evidence. A `required` one from a confirmed source is `fixed`
 * (busy on the plan, not asked); a `required` one from a new source and every `likely` one is asked; `optional` waits in the weekly review.
 */
export function mailEventFrom(meet: MailMeetReading | undefined, input: { id: string; title: string; from: string; subject: string; text: string;
  today: string; lineIds: string[]; at: string; fromAddress?: string; sentAt?: string; structure?: MailStructure; person?: string; rules?: readonly MailEventRule[] }): MailEvent | undefined {
  if (!meet || !DAY.test(meet.date) || Number.isNaN(Date.parse(`${meet.date}T00:00:00Z`)) || meet.date < input.today || !TIME.test(meet.start)) return undefined;
  if (input.sentAt && DAY.test(input.sentAt.slice(0, 10)) && meet.date < input.sentAt.slice(0, 10)) return undefined;
  const quote = squashText(meet.quote ?? "");
  if (quote.length < 6 || !squashText(input.text).includes(quote) || weekdayContradicts(meet.quote, meet.date)) return undefined;
  const end = TIME.test(meet.end) && meet.end > meet.start ? meet.end : plusHour(meet.start);
  if (end <= meet.start) return undefined;
  const relevance = Math.max(0, Math.min(100, Math.round(Number(meet.relevance) || 0)));
  const personal = meet.personal === true;
  const source = (input.fromAddress ?? "").trim().toLowerCase();
  const requiredQuote = squashText(meet.required ?? "");
  const verdict = mailObligation({ structure: input.structure ?? { listed: false, recipients: [] }, person: input.person ?? "", personal, relevance,
    requiredQuote: requiredQuote.length >= 6 && squashText(input.text).includes(requiredQuote), senderRole: meet.senderRole ?? "other",
    rule: source ? input.rules?.find((rule) => rule.source === source)?.cap : undefined });
  return { id: input.id, title: input.title.trim().slice(0, 120) || input.subject.slice(0, 120), date: meet.date, start: meet.start, end,
    location: meet.location.trim().slice(0, 120), lineId: input.lineIds.includes(meet.lineId) ? meet.lineId : "", relevance, personal,
    from: input.from.slice(0, 120), subject: input.subject.slice(0, 160), at: input.at,
    ...(source ? { source } : {}), timing: "fixed", obligation: verdict.obligation, basis: verdict.basis,
    state: verdict.obligation === "required" && !verdict.ask ? "fixed" : verdict.ask ? "asked" : "digest" };
}

/** The required events from mail on Crossline's own schedule: busy time the plan works around. Not chosen for any calendar (no 去 yet). */
export function mailEventsOnSchedule(list: readonly MailEvent[]): FixedEvent[] {
  return list.filter((item) => item.state === "fixed").map(mailEventAsFixed);
}

/** Another fixed event the person has at the same time on that day, if any: a required one that clashes is asked, not placed. */
export function mailEventClash(event: Pick<MailEvent, "date" | "start" | "end">, fixed: readonly FixedEvent[]): FixedEvent | undefined {
  return fixed.find((other) => occurrences(other, [event.date]).length > 0 && other.start < event.end && event.start < other.end);
}

export function readMailEvents(raw: string | null | undefined): MailEvent[] {
  try { const list = JSON.parse(raw ?? "[]") as unknown; return Array.isArray(list) ? list.filter((item): item is MailEvent => !!item && typeof item === "object" && typeof (item as MailEvent).id === "string") : []; }
  catch { return []; }
}

/** The list with one more: the same mail keeps the person's answer, past unanswered ones go first, newest `MAIL_EVENTS_KEEP`. */
export function withMailEvent(list: readonly MailEvent[], event: MailEvent, today: string): MailEvent[] {
  const known = list.find((item) => item.id === event.id);
  const next = known && (known.state === "go" || known.state === "skip" || known.state === "fixed") ? known : event;
  return [...list.filter((item) => item.id !== event.id && !(item.date < today && (item.state === "asked" || item.state === "digest"))), next].slice(-MAIL_EVENTS_KEEP);
}

/** The cards to show now: still to come, not answered; personal invitations first, then by relevance, then soonest. */
export function mailEventAsks(list: readonly MailEvent[], today: string): MailEvent[] {
  return list.filter((item) => item.state === "asked" && item.date >= today)
    .sort((a, b) => Number(b.personal) - Number(a.personal) || b.relevance - a.relevance || a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
    .slice(0, MAIL_EVENT_ASKS);
}

/** Low-relevance notices of the coming week and the one just past, for the weekly review; never a card. */
export function mailEventDigest(list: readonly MailEvent[], from: string, to: string): MailEvent[] {
  return list.filter((item) => item.state === "digest" && item.date >= from && item.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

export function decideMailEvent(list: readonly MailEvent[], id: string, decision: "go" | "skip", at: string): MailEvent[] {
  return list.map((item) => item.id === id ? { ...item, state: decision, decidedAt: at } : item);
}

/** A 去 becomes the person's fixed event: busy on the plan, and the one thing from a mail any calendar path writes. */
export function mailEventAsFixed(event: MailEvent): FixedEvent {
  return { id: `mail-${event.id}`, title: event.title, lineId: event.lineId, repeat: null, date: event.date, start: event.start, end: event.end,
    location: event.location, source: "mail" };
}
