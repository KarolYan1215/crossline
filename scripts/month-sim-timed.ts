/**
 * Timed minutes per day in a finished month simulation (docs/reports/2026-10-30-overnight/closed-loop-results.md): what the system itself
 * can see of the plan being kept — timed minutes against the minutes scheduled that morning — beside the simulation's hidden 「worked」.
 *
 *   pnpm exec tsx scripts/month-sim-timed.ts <ending ledger dir (crossline-month-sim-*)> <run.json>
 *
 * Opens the ending ledger read-only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
const dayIn = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });

const [dir, runFile] = process.argv.slice(2);
if (!dir || !runFile) throw new Error("usage: month-sim-timed.ts <ledger dir> <run.json>");
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] }; close: () => void };
const db = new Database(path.join(dir, "crossline.db"), { readonly: true, fileMustExist: true });
const run = JSON.parse(readFileSync(runFile, "utf8")) as { workspace: string; daysOut: Array<{ day: string; scheduledMin?: number; workedMin?: number }> };
const rows = db.prepare("SELECT workspace_id, started_at, ended_at, payload_json FROM executions").all() as Array<{ workspace_id: string; started_at: string; ended_at: string | null; payload_json: string }>;
const minuteSet = new Map<string, Set<number>>();
for (const row of rows.filter((item) => item.workspace_id.startsWith(run.workspace))) {
  const pauses = (JSON.parse(row.payload_json) as { interruptions?: Array<{ pausedAt: string; resumedAt?: string }> }).interruptions ?? [];
  // A session still open was left paused (the floating timer's 结束 pauses): it ends where its last pause began.
  const last = pauses.at(-1);
  const end = row.ended_at ? Date.parse(row.ended_at) : last && !last.resumedAt ? Date.parse(last.pausedAt) : NaN;
  if (!Number.isFinite(end)) continue;
  for (let at = Math.floor(Date.parse(row.started_at) / 60_000) * 60_000; at < end; at += 60_000) {
    if (pauses.some((pause) => at >= Date.parse(pause.pausedAt) && at < (pause.resumedAt ? Date.parse(pause.resumedAt) : end))) continue;
    const day = dayIn.format(new Date(at));
    const set = minuteSet.get(day) ?? new Set<number>();
    set.add(at);
    minuteSet.set(day, set);
  }
}
db.close();
let timed = 0, scheduled = 0, worked = 0;
for (const day of run.daysOut) { timed += minuteSet.get(day.day)?.size ?? 0; scheduled += day.scheduledMin ?? 0; worked += day.workedMin ?? 0; }
console.log(JSON.stringify({ timedH: Math.round(timed / 60), scheduledH: Math.round(scheduled / 60), workedH: Math.round(worked / 60),
  timedOverScheduled: Math.round(timed / Math.max(1, scheduled) * 100) / 100, workedOverScheduled: Math.round(worked / Math.max(1, scheduled) * 100) / 100 }));
