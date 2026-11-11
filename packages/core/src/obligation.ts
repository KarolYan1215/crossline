/**
 * Must the person go, and is it at a set time? (docs/plans/2026-11-11-walkthrough-decisions.md §2, approved by the owner.) Every event-like
 * item from mail and from a syllabus carries two attributes, kept apart because they are different questions: an assignment is required
 * but is not a place to be; a talk is at a set time but optional; an exam is both.
 *
 * - `timing`: `fixed` (a start and an end), `due` (to be done before a day), `none`.
 * - `obligation`: `required` / `likely` / `optional`.
 *
 * The obligation is computed here by code from structure, never by a model: a model only extracts fields and quotes. Getting it wrong is not
 * symmetric — a talk taken as required is one fixed block the person deletes, an exam taken as optional is a missed exam — so structure
 * decides `required`, words in a body can at most make something `likely` (asked), and a mailing list caps everything at `optional`.
 */
export type EventTiming = "fixed" | "due" | "none";
export type EventObligation = "required" | "likely" | "optional";
/** Why an item got its obligation, so a card can say it and a test can check it. */
export type ObligationBasis = "list" | "rule" | "organizer" | "required_participant" | "accepted" | "declined" | "keyword" | "invitation" | "relevance" | "none";

/** A calendar invitation inside a mail (its text/calendar part), as code read it: addresses lowercased, parameters uppercased. */
export type MailInvite = { method: string; organizer: string; attendees: Array<{ address: string; role: string; partstat: string }> };
/**
 * What the message's own headers and parts say, read by the connector, never a model: `listed` when it came through a mailing list or a
 * bulletin board (List-Id, List-Unsubscribe, Precedence: bulk/list), `recipients` every To and Cc address.
 */
export type MailStructure = { listed: boolean; recipients: string[]; invite?: MailInvite | undefined };
/** A sender's role as the triage model read it from the mail: the person's advisor, a course's staff, anyone else. */
export type SenderRole = "advisor" | "course_staff" | "other";
/** At or above this relevance (0–100) an event that is not required is still asked about (「要去吗」). */
export const LIKELY_RELEVANCE = 70;

export type ObligationVerdict = { obligation: EventObligation; basis: ObligationBasis;
  /** Whether the person is asked (「要去吗」): every `likely`, and a `required` from a source not yet confirmed by an earlier 去. */
  ask: boolean };

/**
 * The tier of an event in a mail.
 * 1. A list or bulletin board: `optional`, whatever the body says.
 * 2. The person's own rule for the source: two 不去 cap it at `optional`.
 * 3. Structure: the person organises it, is a required participant, or accepted an invitation sent to them alone → `required` (asked
 *    the first time from a source; a source the person said 去 to before is taken directly).
 * 4. Course staff or an advisor writing that attendance is required (`requiredQuote`, found in the mail) → `likely`, or `required`
 *    once the person said 去 to that source.
 * 5. An invitation to the person not answered (or the model's `personal`), or relevance ≥ 70 → `likely`; else `optional`.
 */
export function mailObligation(input: { structure: MailStructure; person: string; personal: boolean; relevance: number; requiredQuote: boolean;
  senderRole: SenderRole | string; rule?: "optional" | "required" | undefined }): ObligationVerdict {
  const { structure, rule } = input;
  if (structure.listed) return { obligation: "optional", basis: "list", ask: false };
  if (rule === "optional") return { obligation: "optional", basis: "rule", ask: false };
  const person = input.person.trim().toLowerCase();
  const me = person ? structure.invite?.attendees.find((attendee) => attendee.address === person) : undefined;
  if (me?.partstat === "DECLINED") return { obligation: "optional", basis: "declined", ask: false };
  const alone = structure.recipients.length > 0 && structure.recipients.every((address) => address === person);
  const structural: ObligationBasis | undefined = person && structure.invite?.organizer === person ? "organizer"
    : me?.role === "REQ-PARTICIPANT" ? "required_participant" : me?.partstat === "ACCEPTED" && alone ? "accepted" : undefined;
  if (structural) return { obligation: "required", basis: structural, ask: rule !== "required" };
  if (input.requiredQuote && (input.senderRole === "advisor" || input.senderRole === "course_staff")) {
    return rule === "required" ? { obligation: "required", basis: "rule", ask: false } : { obligation: "likely", basis: "keyword", ask: true };
  }
  if (me || input.personal) return { obligation: "likely", basis: "invitation", ask: true };
  if (input.relevance >= LIKELY_RELEVANCE) return { obligation: "likely", basis: "relevance", ask: true };
  return { obligation: "optional", basis: "none", ask: false };
}

/** What a syllabus or timetable sits for: an exam, a quiz, a class. A course the person has (its project exists) makes them required. */
const SITTING = new Set(["exam", "quiz", "class"]);
const DUE = new Set(["homework_due", "project_due", "deadline"]);
/**
 * A date read from the person's own files: a sitting of a known course is `required` and `fixed` and, with only a day, `needsTime` (the
 * person is asked 「几点到几点」); a due date is `due`; the rest is `none` and optional. A course nobody confirmed is at most `likely`.
 */
export function dateItemAttributes(item: { kind: string; startTime: string }, courseKnown: boolean): { timing: EventTiming; obligation: EventObligation; needsTime: boolean } {
  if (SITTING.has(item.kind)) return { timing: "fixed", obligation: courseKnown ? "required" : "likely", needsTime: courseKnown && !item.startTime };
  if (DUE.has(item.kind)) return { timing: "due", obligation: courseKnown ? "required" : "likely", needsTime: false };
  if (item.kind === "meeting") return { timing: item.startTime ? "fixed" : "none", obligation: "likely", needsTime: false };
  return { timing: item.startTime ? "fixed" : "none", obligation: "optional", needsTime: false };
}

const clock = (hours: string, minutes: string | undefined) => {
  const h = Number(hours), m = Number(minutes ?? "0");
  return h <= 23 && m <= 59 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : undefined;
};
// i18n-ignore: matched against what the person typed
const RANGE = /(\d{1,2})\s*(?:[:：.点]\s*(\d{2})?)?\s*(?:-|–|—|~|～|到|至|to)\s*(\d{1,2})\s*(?:[:：.点]\s*(\d{2})?)?/i;
/** 「12:45-13:15」「9:00 到 10:30」「14点到15点30」 as two `HH:MM`, the end after the start; undefined for anything else. */
export function parseTimeRange(text: string): { start: string; end: string } | undefined {
  const match = RANGE.exec(text);
  if (!match) return undefined;
  const start = clock(match[1]!, match[2]), end = clock(match[3]!, match[4]);
  return start && end && end > start ? { start, end } : undefined;
}
