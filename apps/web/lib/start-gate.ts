import "server-only";
import { redirect } from "next/navigation";
import { readyToStart, startMissing, type AccessContext, type ChecklistItem } from "@crossline/core";
import { interviewChecklistFor } from "@crossline/db";
import { ensureSeeded, getStore, planToday } from "./crossline";
import { identityLines } from "./lines";
import { timedSync } from "./sections";
import { startConfirmed } from "./start-confirm";

/**
 * Whether the five start items stand (`standard`, `readyToStart`, decided 2026-10-12): a description of every line, the weekly hours, a
 * hard line's fixed schedule, a current project per line with its deadline or 「没有截止」, and a long-term goal the person adopted — and
 * whether the person then confirmed what was recorded (`ready`, 2026-10-19: the plan rests on it, so they look it over once). The
 * portrait is not required. Seeding first: with example data on, a brand-new account has its lines and hours only after this runs.
 */
export function startReadiness(ctx: AccessContext): { ready: boolean; standard: boolean; confirmed: boolean; missing: ChecklistItem[] } {
  ensureSeeded(ctx);
  const lines = identityLines(ctx).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  // Filing files is not a start item, so it is not computed here: this runs on every page load.
  const items = interviewChecklistFor(getStore(), ctx.workspaceId, lines, { unfiledFiles: null, today: planToday(ctx) });
  const standard = readyToStart(items);
  const confirmed = standard && startConfirmed(ctx);
  return { ready: standard && confirmed, standard, confirmed, missing: startMissing(items) };
}

/**
 * Every page but the interview, settings, sign-in and the offline fallback calls this after `requireSessionContext()`: until the start
 * standard stands and the person confirmed it, it leads back to the interview, which says what is still missing. No account is exempt — one with work on its board
 * is held too, so the first schedule anyone sees rests on what they said. API routes are not gated (the worker, local tools and offline
 * replay depend on them; a person who is not ready has no page to reach them from).
 */
export function gateUntilReady(ctx: AccessContext): void {
  if (!timedSync("startGate", () => startReadiness(ctx)).ready) redirect("/onboarding");
}
