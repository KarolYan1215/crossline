import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config";
import { writeFileAtomic } from "./files";

/**
 * The daily count of paid calls, and an optional ceiling on it: how many paid image calls today, kept in `dataDir()/avatar-budget.json` so a restart does not reset it. A day is
 * a calendar day in China (UTC+8), where the people taking the test are. Every call to the model takes a slot — a retry too — so the
 * count can only overstate what was spent, never understate it. Reads and writes are synchronous, so two figures enqueued in the same
 * process cannot both take the last slot; one process owns the file (the standalone server is one process).
 */

/**
 * No ceiling on figures by default (the owner's decision of 2026-10-17): what bounds the cost is each address's own limit,
 * `AVATARS_PER_EMAIL`, not a number shared by everyone that the first busy day would use up. `ASSESS_IMAGE_DAILY_LIMIT` still sets one.
 */
export const DEFAULT_DAILY_LIMIT = Number.POSITIVE_INFINITY;

/** One counter file per kind of paid call: `avatar` (images) and `text` (the 「你也许想做」 copy). */
export type BudgetName = "avatar" | "text";
export const budgetFile = (name: BudgetName = "avatar"): string => path.join(dataDir(), `${name}-budget.json`);

/** Today's date in UTC+8 as YYYY-MM-DD. */
export function budgetDay(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function dailyLimit(env: Record<string, string | undefined> = process.env, variable = "ASSESS_IMAGE_DAILY_LIMIT", fallback = DEFAULT_DAILY_LIMIT): number {
  const raw = env[variable]?.trim();
  // An empty value is unset, not zero (Number("") is 0, which would quietly stop every figure).
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

type BudgetState = { day: string; count: number };

function read(day: string, name: BudgetName): BudgetState {
  try {
    const state = JSON.parse(fs.readFileSync(budgetFile(name), "utf8")) as Partial<BudgetState>;
    if (state.day === day && typeof state.count === "number" && state.count >= 0) return { day, count: state.count };
  } catch { /* missing or unreadable: a new day */ }
  return { day, count: 0 };
}

/** Paid calls made today. */
export function spentToday(now: Date = new Date(), name: BudgetName = "avatar"): number {
  return read(budgetDay(now), name).count;
}

/** Takes one of today's slots; false (and nothing written) when the day's limit is reached. */
export function takeSlot(limit: number = dailyLimit(), now: Date = new Date(), name: BudgetName = "avatar"): boolean {
  const state = read(budgetDay(now), name);
  if (state.count >= limit) return false;
  writeFileAtomic(budgetFile(name), JSON.stringify({ day: state.day, count: state.count + 1 }));
  return true;
}
