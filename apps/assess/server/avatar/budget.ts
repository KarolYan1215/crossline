import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config";
import { writeFileAtomic } from "./files";

/**
 * The daily cost guard: how many paid image calls today, kept in `dataDir()/avatar-budget.json` so a restart does not reset it. A day is
 * a calendar day in China (UTC+8), where the people taking the test are. Every call to the model takes a slot — a retry too — so the
 * count can only overstate what was spent, never understate it. Reads and writes are synchronous, so two figures enqueued in the same
 * process cannot both take the last slot; one process owns the file (the standalone server is one process).
 */

export const DEFAULT_DAILY_LIMIT = 300;

export const budgetFile = (): string => path.join(dataDir(), "avatar-budget.json");

/** Today's date in UTC+8 as YYYY-MM-DD. */
export function budgetDay(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function dailyLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ASSESS_IMAGE_DAILY_LIMIT?.trim();
  // An empty value is unset, not zero (Number("") is 0, which would quietly stop every figure).
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DAILY_LIMIT;
}

type BudgetState = { day: string; count: number };

function read(day: string): BudgetState {
  try {
    const state = JSON.parse(fs.readFileSync(budgetFile(), "utf8")) as Partial<BudgetState>;
    if (state.day === day && typeof state.count === "number" && state.count >= 0) return { day, count: state.count };
  } catch { /* missing or unreadable: a new day */ }
  return { day, count: 0 };
}

/** Paid calls made today. */
export function spentToday(now: Date = new Date()): number {
  return read(budgetDay(now)).count;
}

/** Takes one of today's slots; false (and nothing written) when the day's limit is reached. */
export function takeSlot(limit: number = dailyLimit(), now: Date = new Date()): boolean {
  const state = read(budgetDay(now));
  if (state.count >= limit) return false;
  writeFileAtomic(budgetFile(), JSON.stringify({ day: state.day, count: state.count + 1 }));
  return true;
}
