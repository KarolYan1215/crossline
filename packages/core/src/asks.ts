/**
 * An ask: the one shape in which the system stops and puts a question to the person.
 *
 * Before this, every place that needed a person wrote its own blocker somewhere — a ledger event nothing read
 * (`goal.backplan_blocked`), a card on one detail page (a refused capture, stopped materials, a failed gate), or
 * nothing at all — and the person found out only by opening the right page. An ask is built from those same
 * facts on read, so it cannot drift from them, and it carries what a question needs to be answered in place:
 *
 * - **options decided up front** (the person picks; they do not compose) with the system's recommendation marked —
 *   the Agent Inbox accept/edit/respond/ignore and MCP elicitation's accept/decline/cancel are the same idea;
 * - **follow-up fields per option** (pick 「在等」 and it asks who and roughly when), flat and typed as an MCP form is;
 * - **an explanation** of why it is being asked and what happens otherwise, since a question without a reason is
 *   one the person cannot weigh;
 * - **urgency from the deadline it affects**, which is what decides where it is shown and whether it may interrupt:
 *   interruptions cost least at breakpoints and in batches (Adamczyk & Bailey 2004; Fitz et al. 2019), so only an
 *   ask that would cost a deadline within two days reaches a desktop notification;
 * - **snooze**, as Linear's inbox does it: hidden until the chosen day, and back early if the thing it is about
 *   changes (its `fingerprint` moves).
 *
 * The system never answers an ask for the person. When it can act without one it does (the rolling backplan splits
 * what can start now) and the ask is about what only the person knows.
 */
export type AskKind =
  | "backplan_input" | "waiting_due" | "capture_blocked" | "materials_blocked" | "gate_insufficient" | "gate_failed"
  | "evidence_manual" | "milestone_risk" | "agent_blocked" | "calendar_publish_failed" | "calendar_sync_failed" | "codex_signed_out"
  | "missed_block" | "source_project" | "calendar_line_unclear";

export type AskField = { id: string; label: string; kind: "text" | "longtext" | "date"; required: boolean;
  initial?: string; placeholder?: string };
export type AskOption = { id: string; label: string; detail?: string; recommended?: boolean; fields?: AskField[];
  /** A link instead of an answer: the option opens a page and records nothing. */
  href?: string };
export type AskUrgency = "now" | "soon" | "later";
export type Ask = {
  id: string; kind: AskKind; entityId: string;
  title: string; why: string; options: AskOption[];
  urgency: AskUrgency;
  /** The deadline the answer affects, `YYYY-MM-DD`, when there is one. */
  dueDay?: string;
  /** The line it belongs to, for its colour. */
  line?: string;
  raisedAt: string;
  /** Changes whenever the underlying thing changes; a snooze lasts only while it stays the same. */
  fingerprint: string;
};
/** `until` is the person's local day (`YYYY-MM-DD`) on which the ask comes back. */
export type AskSnooze = { askId: string; until: string; fingerprint: string };

const DAY = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/**
 * `now` — answering later would cost a deadline within two days (the forecast's own margin), or it is about today;
 * `soon` — within a week; `later` — everything else. Only `now` may interrupt.
 */
export function urgencyFor(dueDay: string | undefined, today: string): AskUrgency {
  if (!dueDay) return "later";
  const days = daysBetween(today, dueDay);
  return days <= 2 ? "now" : days <= 7 ? "soon" : "later";
}

const URGENCY_RANK: Record<AskUrgency, number> = { now: 0, soon: 1, later: 2 };

/** Snoozed asks removed (unless the thing changed since), the rest most urgent first, then soonest due, then oldest. */
export function rankAsks(asks: Ask[], snoozes: AskSnooze[], today: string): Ask[] {
  const latest = new Map<string, AskSnooze>();
  for (const snooze of snoozes) latest.set(snooze.askId, snooze);
  return asks.filter((ask) => {
    const snooze = latest.get(ask.id);
    return !snooze || snooze.until <= today || snooze.fingerprint !== ask.fingerprint;
  }).sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
    || (a.dueDay ?? "9999").localeCompare(b.dueDay ?? "9999") || a.raisedAt.localeCompare(b.raisedAt));
}

/** The local day a snooze ends: 「明天再问」 is tomorrow, 「下周再问」 seven days on. */
export function snoozeUntil(choice: "tomorrow" | "week", today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + (choice === "tomorrow" ? 1 : 7) * DAY).toISOString().slice(0, 10);
}

/**
 * Checks an answer against the ask it answers: the option must exist and not be a link, every required field must
 * be filled, dates must be real dates, and nothing beyond the option's own fields is passed on.
 */
export function validateAskAnswer(ask: Ask, optionId: string, values: Record<string, unknown>):
  { ok: true; option: AskOption; values: Record<string, string> } | { ok: false; code: string } {
  const option = ask.options.find((item) => item.id === optionId);
  if (!option || option.href) return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const clean: Record<string, string> = {};
  for (const field of option.fields ?? []) {
    const raw = values[field.id];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) { if (field.required) return { ok: false, code: "ASK_FIELD_REQUIRED" }; continue; }
    if (value.length > (field.kind === "longtext" ? 4000 : 200)) return { ok: false, code: "ASK_FIELD_TOO_LONG" };
    if (field.kind === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) return { ok: false, code: "ASK_FIELD_DATE_INVALID" };
    clean[field.id] = value;
  }
  return { ok: true, option, values: clean };
}
