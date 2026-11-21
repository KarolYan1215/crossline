/**
 * Which of the system's messages may interrupt the person (docs/plans/attention-ledger-1120.md, the owner's answers of 2026-11-20, A1–A4).
 * A push to the desktop or the phone is the dearest thing the system can spend: only what needs the person to act now goes out; what
 * only says what the system did, or asks something that can wait for the next look at the page, is listed — in the bell or the 小帮手 —
 * and counted into the morning brief's one line, the collected push.
 *
 * - `interrupt`: pushed when no page is open (the producers already keep it out of the quiet hours and inside the day's cap).
 * - `always`: pushed as before, whatever the hour: account-security mail (「账号安全提醒照推」).
 * - `list`: never pushed.
 */
export type PushPolicy = "interrupt" | "always" | "list";

const INTERRUPT: ReadonlySet<string> = new Set([
  // A block coming up — only the ones the calendar app does not already remind about (`listOnly` marks the rest, A1).
  "block_start",
  // A block just ended that the passive signals cannot settle and that bears on a near deadline.
  "block_confirm",
  // A deadline the free time no longer covers.
  "latest_start",
  // The person's own running timer.
  "timer_overrun",
  // Reminders the person set themselves: an errand's departure, a timed reminder, an automation that only reminds.
  "reminder", "departure", "automation_remind"
]);
const ALWAYS: ReadonlySet<string> = new Set(["mail_check"]);

export function pushPolicyOf(kind: string | undefined): PushPolicy {
  if (!kind) return "list";
  if (ALWAYS.has(kind)) return "always";
  return INTERRUPT.has(kind) ? "interrupt" : "list";
}

/**
 * Messages that ask the person something and are answered in the 小帮手 (2026-10-27): not reminders, and not "what the system did".
 * The web's bell reads this set (`app/notice-kinds.ts`); the brief's collected line leaves these out.
 */
export const INPUT_NUDGE_KINDS: ReadonlySet<string> = new Set([
  "block_confirm", "day_wrap", "energy_check", "outcome_check", "progress_check", "agent_question", "opener"
]);

/**
 * A listed message that reports something the system did or found (not a question, not a reminder the person set): what the brief's
 * 「系统做了 N 件」 counts.
 */
export const isSystemReport = (kind: string | undefined): boolean => pushPolicyOf(kind) === "list" && !INPUT_NUDGE_KINDS.has(kind ?? "");
