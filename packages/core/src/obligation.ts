/**
 * Must the person go, and is it at a set time? (docs/plans/2026-11-11-walkthrough-decisions.md §2, approved by the owner.) Every event-like
 * item from mail and from a syllabus carries two attributes, kept apart because they are different questions: an assignment is required
 * but is not a place to be; a talk is at a set time but optional; an exam is both.
 *
 * - `timing`: `fixed` (a start and an end), `due` (to be done before a day), `none`.
 * - `obligation`: `required` / `likely` / `optional`.
 *
 * Since 2026-11-20 the obligation is the model's (the owner's answer, round 2 of docs/plans/near-term-and-mail-bar-1120.md: 「推翻，模型定」).
 * The 2026-11-11 rule had code decide it from structure, and a list's notice was optional whatever it said; it took the meaning out of the
 * model's hands while the model was the only one reading the mail. Now the structure the connector read (a list, the recipients, an
 * invitation's organizer, role and answer) is given to the model as evidence with the ledger brief, and the model says `attend`. Code keeps
 * only what is the person's own: their rule for a sender (two 不去) and their own 「拒绝」 of an invitation.
 */
export type EventTiming = "fixed" | "due" | "none";
export type EventObligation = "required" | "likely" | "optional";
/** Why an item got its obligation, so a card can say it and a test can check it. */
export type ObligationBasis = "rule" | "declined" | "model"
  /** Bases of events recorded before 2026-11-20, when code tiered them from structure; read as they are. */
  | "list" | "organizer" | "required_participant" | "accepted" | "keyword" | "invitation" | "relevance" | "none";

/** A calendar invitation inside a mail (its text/calendar part), as code read it: addresses lowercased, parameters uppercased. */
export type MailInvite = { method: string; organizer: string; attendees: Array<{ address: string; role: string; partstat: string }> };
/**
 * What the message's own headers and parts say, read by the connector, never a model: `listed` when it came through a mailing list or a
 * bulletin board (List-Id, List-Unsubscribe, Precedence: bulk/list), `recipients` every To and Cc address.
 */
export type MailStructure = { listed: boolean; recipients: string[]; invite?: MailInvite | undefined };
/** A sender's role as the triage model read it from the mail: the person's advisor, a course's staff, anyone else. */
export type SenderRole = "advisor" | "course_staff" | "other";
/** The model's reading of whether the person goes: `must` (an exam sitting, their own group's meeting, an advisor's call), `likely`, `optional`. */
export type MailAttend = "must" | "likely" | "optional";

export type ObligationVerdict = { obligation: EventObligation; basis: ObligationBasis;
  /** Whether the person is asked (「要去吗」): every `likely`, and a `required` from a source not yet confirmed by an earlier 去. */
  ask: boolean };

/**
 * The tier of an event in a mail (2026-11-20).
 * 1. The person's own rule for the source: two 不去 cap it at `optional`.
 * 2. The person declined the invitation: `optional`.
 * 3. The model's `attend`: `must` is `required` and goes on the schedule without a question; `likely` is asked (「要去吗」) only when it
 *    serves one of the person's milestones (the attention gate, §3.5); `optional`, and a `likely` that serves none, wait in the weekly review.
 */
export function mailObligation(input: { attend: MailAttend | string | undefined; structure: MailStructure; person: string; servesMilestone: boolean;
  rule?: "optional" | "required" | undefined }): ObligationVerdict {
  const { structure, rule } = input;
  if (rule === "optional") return { obligation: "optional", basis: "rule", ask: false };
  const person = input.person.trim().toLowerCase();
  const me = person ? structure.invite?.attendees.find((attendee) => attendee.address === person) : undefined;
  if (me?.partstat === "DECLINED") return { obligation: "optional", basis: "declined", ask: false };
  if (input.attend === "must") return { obligation: "required", basis: "model", ask: false };
  if (input.attend === "likely") return { obligation: "likely", basis: "model", ask: input.servesMilestone };
  return { obligation: "optional", basis: "model", ask: false };
}

/** The structure the connector read, said to the model as evidence: a list or not, how many recipients, the person's place in an invitation. */
export function structureEvidence(structure: MailStructure, person: string): { listed: boolean; recipients: number; toPersonAlone: boolean;
  invite: "" | "organizer" | "required" | "optional" | "accepted" | "declined" | "invited" } {
  const address = person.trim().toLowerCase();
  const me = address ? structure.invite?.attendees.find((attendee) => attendee.address === address) : undefined;
  const invite = !structure.invite ? "" : address && structure.invite.organizer === address ? "organizer" : me?.partstat === "DECLINED" ? "declined"
    : me?.partstat === "ACCEPTED" ? "accepted" : me?.role === "REQ-PARTICIPANT" ? "required" : me?.role === "OPT-PARTICIPANT" ? "optional" : "invited";
  return { listed: structure.listed, recipients: structure.recipients.length,
    toPersonAlone: structure.recipients.length > 0 && structure.recipients.every((item) => item === address), invite };
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
