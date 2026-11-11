import type { FixedEvent } from "./fixed-events";
import { squashText } from "./opportunity-discovery";

/**
 * Mail about something the person could go to (a talk, an info session, an activity, a meeting) is asked about, not planned (the owner's
 * decision of 2026-11-10): one card 「要去吗」 with how relevant it is and its line. Only 去 makes it a fixed event, and only a fixed event
 * reaches a calendar; 不去 drops it. Mass notices of low relevance are listed in the weekly review instead of asked. A personal invitation
 * (导师约见、面试、组会) is still asked, with 去 as the default and ahead of everything else. Nothing from a mail ever reaches a calendar
 * without the person's 去.
 */
export const MAIL_EVENTS_SETTING = "mail.events";
/** At or above this relevance (0–100) a mass notice is asked about; below it, it goes to the weekly digest. */
export const MAIL_EVENT_ASK_RELEVANCE = 50;
/** Kept this many, newest last; past ones are dropped first. */
export const MAIL_EVENTS_KEEP = 120;
/** Open cards at a time: personal first, then the most relevant. */
export const MAIL_EVENT_ASKS = 4;

/** What the triage model read about an event in the mail; empty strings and 0 when the mail is not one. */
export type MailMeetReading = { date: string; start: string; end: string; location: string; lineId: string;
  /** 0–100: how much it serves the person's lines and long-term goals. */
  relevance: number;
  /** Addressed to the person in particular (an advisor's meeting, an interview, their own group meeting), not a list's notice. */
  personal: boolean;
  /** One sentence copied exactly from the mail that names the day. */
  quote: string };

export type MailEventState = "asked" | "digest" | "go" | "skip";
export type MailEvent = {
  /** Stable for the mail (its message key). */
  id: string;
  title: string; date: string; start: string; end: string; location: string; lineId: string;
  relevance: number; personal: boolean;
  from: string; subject: string;
  state: MailEventState;
  at: string; decidedAt?: string;
};

export const MAIL_MEET_SHAPE = {
  type: "object", additionalProperties: false, required: ["date", "start", "end", "location", "lineId", "relevance", "personal", "quote"], properties: {
    date: { type: "string", maxLength: 10 }, start: { type: "string", maxLength: 5 }, end: { type: "string", maxLength: 5 },
    location: { type: "string", maxLength: 120 }, lineId: { type: "string", maxLength: 128 },
    relevance: { type: "integer", minimum: 0, maximum: 100 }, personal: { type: "boolean" }, quote: { type: "string", maxLength: 300 } }
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const plusHour = (time: string) => { const [h, m] = time.split(":").map(Number) as [number, number]; const total = Math.min(23 * 60 + 59, h * 60 + m + 60); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };

/**
 * The event as code accepts it: a real day not in the past, a start time, a quote found in the mail itself (the model reads, it never
 * supplies a day of its own), a line the person has. No end → one hour. Undefined when any of that fails: the mail is then information.
 */
export function mailEventFrom(meet: MailMeetReading | undefined, input: { id: string; title: string; from: string; subject: string; text: string;
  today: string; lineIds: string[]; at: string }): MailEvent | undefined {
  if (!meet || !DAY.test(meet.date) || Number.isNaN(Date.parse(`${meet.date}T00:00:00Z`)) || meet.date < input.today || !TIME.test(meet.start)) return undefined;
  const quote = squashText(meet.quote ?? "");
  if (quote.length < 6 || !squashText(input.text).includes(quote)) return undefined;
  const end = TIME.test(meet.end) && meet.end > meet.start ? meet.end : plusHour(meet.start);
  if (end <= meet.start) return undefined;
  const relevance = Math.max(0, Math.min(100, Math.round(Number(meet.relevance) || 0)));
  const personal = meet.personal === true;
  return { id: input.id, title: input.title.trim().slice(0, 120) || input.subject.slice(0, 120), date: meet.date, start: meet.start, end,
    location: meet.location.trim().slice(0, 120), lineId: input.lineIds.includes(meet.lineId) ? meet.lineId : "", relevance, personal,
    from: input.from.slice(0, 120), subject: input.subject.slice(0, 160), at: input.at,
    state: personal || relevance >= MAIL_EVENT_ASK_RELEVANCE ? "asked" : "digest" };
}

export function readMailEvents(raw: string | null | undefined): MailEvent[] {
  try { const list = JSON.parse(raw ?? "[]") as unknown; return Array.isArray(list) ? list.filter((item): item is MailEvent => !!item && typeof item === "object" && typeof (item as MailEvent).id === "string") : []; }
  catch { return []; }
}

/** The list with one more: the same mail keeps the person's answer, past unanswered ones go first, newest `MAIL_EVENTS_KEEP`. */
export function withMailEvent(list: readonly MailEvent[], event: MailEvent, today: string): MailEvent[] {
  const known = list.find((item) => item.id === event.id);
  const next = known && (known.state === "go" || known.state === "skip") ? known : event;
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
