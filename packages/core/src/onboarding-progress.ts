/**
 * The interview's wait, made visible (docs/onboarding-v3.md 「等待」, decided 2026-10-14). A turn takes one to four minutes; the screen
 * used to say only 「正在整理回答」. The runtime streams the answer as it is written, and the answer is JSON in the schema's key order —
 * `reply` first, then the questions, the facts and the dates — so what the model has already written can be counted and the reply read
 * before the turn ends. None of it is stored or trusted: the validated answer replaces it the moment it lands.
 */

/** Ledger setting the worker writes while a turn runs (throttled) and deletes when it ends; the page polls it. */
export const ONBOARDING_PROGRESS_SETTING = "onboarding.progress";

export type OnboardingProgress = {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  /** `queued`: waiting for the server's one model slot (the hosted beta runs one model turn at a time), `ahead` runs before it. */
  phase: "queued" | "thinking" | "writing" | "checking";
  ahead?: number;
  /** Files handed to this turn, by name: what the model is reading before it writes anything. */
  files: string[];
  facts: number;
  dates: number;
  questions: number;
  /** The reply as written so far, unvalidated. */
  reply: string;
  /** This is a second look after the validator sent the first answer back, or a turn resent after silence. */
  repairs: number;
  stalls: number;
};

/** A progress record older than this belongs to a turn that ended without clearing it (a crash): the page ignores it. */
export const ONBOARDING_PROGRESS_STALE_MS = 45_000;

const SECTION_KEYS = ["questions", "slotUpdates", "projectsDetected", "flywheelCandidates", "coverage", "fileDates", "nextAction"] as const;

/** The part of the streamed text that belongs to one top-level key, up to the next key that has started. */
function section(text: string, key: (typeof SECTION_KEYS)[number]): string {
  const start = text.search(new RegExp(`"${key}"\\s*:`));
  if (start < 0) return "";
  const rest = text.slice(start + key.length + 2);
  const ends = SECTION_KEYS.filter((other) => other !== key).map((other) => rest.search(new RegExp(`"${other}"\\s*:`))).filter((at) => at >= 0);
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
}

const count = (text: string, key: string) => text.match(new RegExp(`"${key}"\\s*:`, "g"))?.length ?? 0;

/** The reply string as far as it has been written, unescaped; an escape cut off at the end is dropped rather than shown half. */
function partialReply(text: string): string {
  const match = /^\s*(?:```(?:json)?\s*)?\{\s*"reply"\s*:\s*"((?:[^"\\]|\\.)*)(\\u[0-9a-fA-F]{0,3}|\\)?/.exec(text);
  if (!match) return "";
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return ""; }
}

/** What a partly written interview answer already holds. */
export function readPartialTurn(text: string): Pick<OnboardingProgress, "facts" | "dates" | "questions" | "reply"> {
  const dates = section(text, "fileDates");
  return {
    reply: partialReply(text),
    questions: count(section(text, "questions"), "kind"),
    facts: count(section(text, "slotUpdates"), "slot"),
    // A dated item carries `date`, a weekly arrangement `weekdays`.
    dates: count(dates, "date") + count(dates, "weekdays")
  };
}

/**
 * The last interview round that did not finish, per conversation (`onboarding.lastFailure:<session>`): what it was, in words the
 * person can act on, and the provider's own text folded beside it. Written by the worker when a round stops, removed when the next
 * attempt starts.
 */
export const ONBOARDING_LAST_FAILURE = "onboarding.lastFailure:";
export type OnboardingFailure = { code: string; message: string; detail?: string; at: string };
export function readOnboardingFailure(raw: string | undefined | null): OnboardingFailure | null {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<OnboardingFailure> | null;
    return value && typeof value.code === "string" && typeof value.message === "string" && typeof value.at === "string"
      ? { code: value.code, message: value.message, at: value.at, ...(typeof value.detail === "string" && value.detail ? { detail: value.detail } : {}) } : null;
  } catch { return null; }
}
