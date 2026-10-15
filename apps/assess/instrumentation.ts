// Runs once when the server starts (Next's instrumentation hook): the retention purge, now and hourly. Node only — the store is
// better-sqlite3 — and imported on demand so nothing of it reaches another runtime. The import sits inside the `=== "nodejs"` branch,
// the shape Next's docs give: webpack drops that branch from the edge build. An early `return` on the opposite test is not dropped, so
// the edge compile tried to bundle better-sqlite3, failed on `fs`, and `next dev` answered every page with a 500 (found 2026-10-15).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPurgeSchedule } = await import("./server/purge");
    startPurgeSchedule();
  }
}
