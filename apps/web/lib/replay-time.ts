/**
 * When a replayed command was actually done: its own `createdAt`, written on the device. Stamping the
 * replay time instead made a session done offline at 14:00 and synced at 18:00 look four hours long.
 * A time in the future, unparseable, or more than a week old is not trusted, and the store additionally
 * never lets it precede the step it follows.
 */
export function replayTime(createdAt: string, now = Date.now()): string | undefined {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at) || at > now + 60_000 || at < now - 7 * 86_400_000) return undefined;
  return new Date(at).toISOString();
}
