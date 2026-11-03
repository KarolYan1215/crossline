import { applicantFrom, judgeEligibility, type EligibilityVerdict } from "@crossline/core";
import type { CrosslineStore, StoredOpportunity } from "./index";
import { readLocale } from "./locale";

/**
 * The opportunity agent's ledger helpers shared by the worker and the web (docs/opportunity-agent.md §5–8): eligibility answers as
 * profile facts and the week's counts. Watches are in opportunity-watches.ts; 报名 goes to the form-filling track's `queueFormRun` (form-runs.ts).
 */

export const waitingIdForNeed = (needId: string) => `wait-opp-${needId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;

/**
 * An answer to an eligibility question, kept where the form-filling track reads the application profile: a confirmed fact of the `person`
 * line, no project, slot `apply.<name>` (§12). Every opportunity still waiting on a question is judged again at once.
 */
export function recordEligibilityAnswer(store: CrosslineStore, workspaceId: string, slot: string, value: string, opportunityId: string, now = new Date()): number {
  store.upsertProfileFact({ workspaceId, identityId: "person", projectId: "", slot, value, status: "confirmed", sourceRef: `opportunity:${opportunityId}`,
    sourceQuote: value, updatedAt: now.toISOString() });
  return rejudgeOpportunities(store, workspaceId, now);
}

/** Judges again every undecided opportunity whose verdict is still a question; returns how many changed. */
export function rejudgeOpportunities(store: CrosslineStore, workspaceId: string, now = new Date()): number {
  const applicant = applicantFrom(store.listProfileFacts(workspaceId));
  const locale = readLocale(store, workspaceId);
  let changed = 0;
  for (const row of store.listOpportunities(workspaceId)) {
    if (row.verdict.state !== "unknown" || (row.decision && row.decision !== "later")) continue;
    const verdict: EligibilityVerdict = judgeEligibility(row.terms, applicant, locale);
    if (JSON.stringify(verdict) === JSON.stringify(row.verdict)) continue;
    store.setOpportunityVerdict(workspaceId, row.id, verdict, now.toISOString());
    changed += 1;
  }
  return changed;
}

/** The week's discovery in numbers, for the weekly review (§7: an ineligible opportunity is counted there and nowhere else). */
export function opportunityWeek(store: CrosslineStore, workspaceId: string, since: string): { found: number; eligible: number; unknown: number; ineligible: number; decided: number } {
  const rows = store.listOpportunities(workspaceId).filter((row) => row.foundAt >= since);
  return { found: rows.length, eligible: rows.filter((row) => row.verdict.state === "eligible").length,
    unknown: rows.filter((row) => row.verdict.state === "unknown").length, ineligible: rows.filter((row) => row.verdict.state === "ineligible").length,
    decided: rows.filter((row) => row.decision && row.decision !== "later").length };
}
