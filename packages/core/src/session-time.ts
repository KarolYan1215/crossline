/**
 * How long a timed session worked. `pauseMinutes` holds only the pauses that were resumed, so a session left paused — the floating
 * timer's 结束 pauses it, the order stays active — went on counting from the pause to now: the owner's step timed 15:37–20:58 read
 * 「今天计时 5h47」 at 21:24 (2026-11-11). While a pause is open, the work stopped where it began.
 */
export type SessionLike = {
  startedAt: string; endedAt?: string | undefined; pauseMinutes: number;
  interruptions?: ReadonlyArray<{ pausedAt: string; resumedAt?: string | undefined }> | undefined;
};

/** Where a session's work stops: its end; while it is paused, where that pause began; otherwise now. Never before its start. */
export function sessionWorkEnd(session: SessionLike, now: string | number): number {
  const open = session.endedAt ? undefined : session.interruptions?.at(-1);
  const end = session.endedAt ? Date.parse(session.endedAt)
    : open && !open.resumedAt ? Date.parse(open.pausedAt)
    : typeof now === "number" ? now : Date.parse(now);
  return Math.max(Date.parse(session.startedAt), end);
}

/** Minutes worked: wall clock to `sessionWorkEnd`, less the resumed pauses. */
export function sessionWorkedMinutes(session: SessionLike, now: string | number): number {
  return Math.max(0, Math.round((sessionWorkEnd(session, now) - Date.parse(session.startedAt)) / 60_000) - session.pauseMinutes);
}

/** A timer runs half again over the step's usual minutes before 「超时」 is said (`timer_overrun`). */
export const OVERRUN_RATIO = 1.5;
/** Unanswered, a running timer is stopped once it has run three times the usual minutes, and never before four hours. */
export const FORGOTTEN_RATIO = 3;
export const FORGOTTEN_MIN_MINUTES = 240;

/**
 * A timer nobody stopped (2026-11-11: started on a block at 15:37 and left running; the 「超时」 message never came because the day's
 * cap was spent, and the evening read five hours of work). Once it has run `FORGOTTEN_RATIO` × the usual minutes (at least four hours) it
 * is stopped where 「超时」 was due — the last moment the time is plausibly work — and the person is told, so the measure stays honest
 * without a guess about the hours in between. `undefined` while it is not forgotten, paused, or has no usual length.
 */
export function forgottenTimerStop(timer: { startedAt: string; usualMinutes: number; pausedMinutes?: number | undefined; paused?: boolean | undefined },
  now: string | number): string | undefined {
  if (timer.paused || !(timer.usualMinutes >= 10)) return undefined;
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const elapsed = (nowMs - Date.parse(timer.startedAt)) / 60_000 - (timer.pausedMinutes ?? 0);
  if (elapsed < Math.max(FORGOTTEN_MIN_MINUTES, timer.usualMinutes * FORGOTTEN_RATIO)) return undefined;
  return new Date(Date.parse(timer.startedAt) + ((timer.pausedMinutes ?? 0) + timer.usualMinutes * OVERRUN_RATIO) * 60_000).toISOString();
}
