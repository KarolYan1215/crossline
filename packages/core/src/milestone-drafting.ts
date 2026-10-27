/**
 * How far a milestone-design run has got, line by line (2026-10-17 walkthrough, W-26/W-27). The architect designs one line at a time, so
 * the first line's drafts land minutes before the last; once any draft existed the 主线 page stopped saying it was still designing, and a
 * line the run skipped (thin facts, a refused answer) simply had none, with nothing said. The worker writes this setting as it goes; the
 * page reads it to say which lines are still being designed and why a finished run left a line without drafts.
 */
import { tFor, type Locale } from "./i18n";
export const MILESTONE_DRAFTING_SETTING = "milestones.drafting";

export type MilestoneDrafting = {
  startedAt: string;
  /** The lines this run designs, in order. */
  lines: string[];
  /** Lines finished with drafts. */
  done: string[];
  /** Lines the run tried and could not design, with the reason in the person's words. */
  skipped: Array<{ lineId: string; why: string }>;
  /** Lines with facts too thin or only guessed, not designed at all. */
  thin: string[];
  finishedAt?: string;
};

/** A run that has not finished within this long is taken as lost (a restart), not as still designing. */
const RUN_LOST_MS = 60 * 60_000;

export function readMilestoneDrafting(raw: string | undefined): MilestoneDrafting | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as MilestoneDrafting;
    return parsed && typeof parsed.startedAt === "string" && Array.isArray(parsed.lines) ? { ...parsed, done: parsed.done ?? [], skipped: parsed.skipped ?? [], thin: parsed.thin ?? [] } : undefined;
  } catch { return undefined; }
}

export type DraftingProgress = {
  /** Lines the running run has not reached yet; empty when nothing runs. */
  pending: string[];
  /** For a line with no live milestone after the last run: why. */
  missing: Record<string, string>;
};

/**
 * `withMilestones`: lines that hold any live (draft or approved) milestone now. A line the person fixed since — it has drafts — is not
 * reported missing, whatever the last run said.
 */
export function draftingProgress(drafting: MilestoneDrafting | undefined, withMilestones: Set<string>, now = new Date(), locale?: Locale): DraftingProgress {
  if (!drafting) return { pending: [], missing: {} };
  const running = !drafting.finishedAt && now.getTime() - Date.parse(drafting.startedAt) < RUN_LOST_MS;
  const settled = new Set([...drafting.done, ...drafting.skipped.map((item) => item.lineId)]);
  const pending = running ? drafting.lines.filter((line) => !settled.has(line)) : [];
  const missing: Record<string, string> = {};
  for (const item of drafting.skipped) if (!withMilestones.has(item.lineId)) missing[item.lineId] = item.why;
  for (const line of drafting.thin) if (!withMilestones.has(line)) missing[line] ??= tFor(locale)("这条线在访谈里说得太少（或只有推断），系统没有为它设计草稿。");
  return { pending, missing };
}
