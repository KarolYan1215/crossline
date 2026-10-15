// Runs once when the server starts (Next's instrumentation hook): the retention purge, now and hourly. Node only — the store is
// better-sqlite3 — and imported on demand so nothing of it reaches another runtime.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPurgeSchedule } = await import("./server/purge");
  startPurgeSchedule();
}
