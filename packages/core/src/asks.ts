import type { MilestoneRisk } from "./milestone-risk";
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
  | "missed_block" | "source_project" | "calendar_line_unclear" | "interview_open" | "interview_question" | "event_propose" | "step_question"
  | "relation_check" | "background_paused" | "locked_conflict" | "outcome_check" | "progress_check" | "milestone_risk_review"
  /** A course's or the person's own deadline passed with work still open (the daily pass's `milestone.overdue`): 补做 / 新日期 / 放弃. */
  | "milestone_overdue"
  /** Money records the ledger kept apart as possible duplicates (docs/mail-bookkeeping.md §4.3): one card for all of them. */
  | "ledger_duplicate"
  /**
   * Work the assistant can do once the person gives one thing only they hold (docs/work-split.md, an `ask` work order): a question, never
   * a task card. Answered, the assistant takes the work; 「不需要」 archives it.
   */
  | "prep_question"
  /** How long getting to a place on the calendar takes, when nothing says (no word, no map, no default): 30 minutes are kept meanwhile. */
  | "travel_minutes"
  /** The week's risks, once a week (docs/rituals.md): every milestone at risk on one card; one due within two days stays its own card. */
  | "risk_digest"
  /** The weekly commitment (docs/rituals.md): the week's hours against its work, 保 / 推 / 砍 confirmed in one step. */
  | "weekly_commit";

export type AskField = { id: string; label: string; kind: "text" | "longtext" | "date"; required: boolean;
  initial?: string; placeholder?: string };
export type AskOption = { id: string; label: string; detail?: string; recommended?: boolean; fields?: AskField[];
  /** A link instead of an answer: the option opens a page and records nothing. */
  href?: string;
  /** Answered only with the person's own words in the ask's `freeText` box: never a one-tap button. */
  needsNote?: boolean };
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
  /** The importance (0–100) of the milestone it bears on, when it bears on one; orders asks of equal urgency. */
  importance?: number;
  /** Set when the decision is not this week's: the day it comes into the week's decisions (see `horizonEntry`). */
  entersOn?: string;
  /**
   * Whether the answer matters beyond itself: it blocks other work, the assistant needs it to go on, it bears on a
   * milestone weighted 60 or more, or it is a start-standard item. Unset falls back to `importance >= 60` (`askQuadrant`).
   */
  important?: boolean;
  /** `many` when more than one option can be true at once (several goals); `one` (the default) when they exclude each other. */
  select?: "one" | "many";
  /** The thing the question is about, to look at before answering (the portrait, the drafts, a task, a file). */
  preview?: AskPreview;
  /**
   * The person may answer in their own words instead of (or beside) an option: the input is shown in place, its placeholder
   * the recommended answer in words, and typing goes straight into it — no second dialog.
   */
  freeText?: { placeholder: string };
  /** For the assistant's work: how far it got and where it stopped, so the person can decide the next step in place. */
  progress?: AskProgress;
  /** A milestone's reviewed risks, drawn with their level (`milestone_risk_review`). */
  risks?: MilestoneRisk[];
  /**
   * The rows a folded card stands for (a batch of milestone risk reviews), drawn as a short list the person can scan — name, deadline,
   * level, kinds — instead of one sentence naming all of them (2026-10-21 walkthrough: 25 milestones in one `why`).
   */
  items?: AskItem[];
};
export type AskItem = { id: string; title: string; dueDay?: string; line?: string; href?: string; risks?: MilestoneRisk[] };
export type AskPreview = { kind: "portrait" | "milestones" | "plan" | "task" | "file" | "agent"; href: string; label: string };
export type AskProgress = {
  /** One sentence: what the run was doing. */
  summary: string;
  /** What it finished, in order. */
  done: string[];
  /** Where it stopped and why, in the person's words — never a bare code. */
  stuckAt: string;
  /** What only the person can supply or decide for it to go on. */
  needs: string[];
  /** True when retrying could act outside this machine (a login that may lock the account, spending, sending). */
  external: boolean;
  /** Automatic retries already made after an interruption. */
  retries: number;
};

/** The four Eisenhower quadrants the 待确认 page is laid out in. */
export type AskQuadrant = "urgent_important" | "important" | "urgent" | "neither";
export const ASK_QUADRANTS: AskQuadrant[] = ["urgent_important", "important", "urgent", "neither"];
export const ASK_QUADRANT_LABEL: Record<AskQuadrant, string> = {
  urgent_important: "紧急重要", important: "重要不紧急", urgent: "紧急不重要", neither: "不重要不紧急"
};
/** Urgent = answering later would cost a deadline within two days (`urgency: "now"`); important as `Ask.important` says. */
export function askQuadrant(ask: Pick<Ask, "urgency" | "important" | "importance">): AskQuadrant {
  const urgent = ask.urgency === "now";
  const important = ask.important ?? (ask.importance ?? 0) >= 60;
  return urgent && important ? "urgent_important" : important ? "important" : urgent ? "urgent" : "neither";
}
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

/**
 * Decisions are asked for a week ahead, not all at once (decided 2026-10-10: 55 were waiting and one bore on the next seven days).
 * A decision belongs to this week when the latest day the work behind it can start — its due day less the days its cautious
 * estimate takes — falls within `HORIZON_DAYS`; anything without a date belongs to this week, since nothing says it can wait.
 */
export const HORIZON_DAYS = 7;
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** The latest day work of `leadMinutes` can start to finish by `due`, at `dailyMinutes` of work a day. */
export function latestStart(due: string, leadMinutes: number, dailyMinutes: number): string {
  return plusDays(due, -Math.ceil(Math.max(0, leadMinutes) / Math.max(30, dailyMinutes)));
}
/** `undefined` when the decision is this week's; otherwise the day it comes into the week (`HORIZON_DAYS` before `decideBy`). */
export function horizonEntry(decideBy: string | undefined, today: string): string | undefined {
  if (!decideBy) return undefined;
  const enters = plusDays(decideBy, -HORIZON_DAYS);
  return enters <= today ? undefined : enters;
}

/** Snoozed asks removed (unless the thing changed since), the rest most urgent first, then most important, then soonest due, then oldest. */
export function rankAsks(asks: Ask[], snoozes: AskSnooze[], today: string): Ask[] {
  const latest = new Map<string, AskSnooze>();
  for (const snooze of snoozes) latest.set(snooze.askId, snooze);
  return asks.filter((ask) => {
    const snooze = latest.get(ask.id);
    return !snooze || snooze.until <= today || snooze.fingerprint !== ask.fingerprint;
  }).sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || (b.importance ?? 50) - (a.importance ?? 50)
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

/** The longest answer in the person's own words (`Ask.freeText`). */
export const ASK_NOTE_MAX = 4000;
/**
 * The longest a card's time on screen counts as deciding: past five minutes the person had walked away. What a decision cost is the
 * system's own price (the 2026-10-18 evaluation: without it nothing can show the system saves more time than it takes).
 */
export const DECISION_SECONDS_MAX = 300;
/** A client's reported seconds on screen, or undefined when it reported none or something that is not a time. */
export function decisionSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(DECISION_SECONDS_MAX, Math.round(value)) : undefined;
}
/**
 * Checks a choice that may hold several options (`select: "many"`) and/or the person's own words (`freeText`). Exactly one
 * option for a single-choice ask; at least one for a multiple-choice ask; none at all only when there is a note and the ask
 * takes free text. Each chosen option's fields are checked as `validateAskAnswer` checks them.
 */
export function validateAskChoice(ask: Ask, optionIds: string[], values: Record<string, unknown>, note = ""):
  { ok: true; options: AskOption[]; values: Record<string, string>; note: string } | { ok: false; code: string } {
  const text = note.trim();
  if (text.length > ASK_NOTE_MAX) return { ok: false, code: "ASK_FIELD_TOO_LONG" };
  if (text && !ask.freeText) return { ok: false, code: "ASK_NOTE_NOT_TAKEN" };
  const ids = [...new Set(optionIds)];
  if (ids.length === 0 && !text) return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  if (ids.length > 1 && (ask.select ?? "one") === "one") return { ok: false, code: "ASK_SINGLE_CHOICE" };
  const options: AskOption[] = [];
  const clean: Record<string, string> = {};
  for (const id of ids) {
    const checked = validateAskAnswer(ask, id, values);
    if (!checked.ok) return checked;
    options.push(checked.option);
    Object.assign(clean, checked.values);
  }
  return { ok: true, options, values: clean, note: text };
}
