/**
 * What to do with a queued offline command that did not go through.
 *
 * A command the server has permanently rejected must stop being retried: retrying it forever is an
 * invisible loop that also delays everything queued behind it. It becomes a dead letter the person
 * can see and deal with, which is the only honest end state for work that cannot be replayed.
 */
export type ReplayOutcome = "done" | "retry" | "dead_letter";

export function classifyReplay(status: number | undefined): ReplayOutcome {
  // No status at all means the request never reached the server — offline, DNS, a dropped socket.
  if (status === undefined) return "retry";
  if (status >= 200 && status < 300) return "done";
  // 408 and 429 are the two 4xx that genuinely mean "try again".
  if (status === 408 || status === 429) return "retry";
  // Every other 4xx is the server saying this command will never be accepted as written.
  if (status >= 400 && status < 500) return "dead_letter";
  return "retry";
}

/** A dead letter keeps why it died, so the offline page can say more than "something failed". */
export type DeadLetter<T> = { command: T; status: number; reason: string; failedAt: string };
