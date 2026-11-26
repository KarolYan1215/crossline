import { tFor } from "@crossline/core";
import type { CrosslineStore, StoredOpportunity } from "./index";
import { readLocale } from "./locale";

/**
 * The opportunity agent's ledger helpers shared by the worker and the web (docs/opportunity-agent.md §5–8): eligibility answers as
 * profile facts and the week's counts. Watches are in opportunity-watches.ts; 报名 goes to the form-filling track's `queueFormRun` (form-runs.ts).
 */

export const waitingIdForNeed = (needId: string) => `wait-opp-${needId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;

/**
 * An answer to an eligibility question on a card read before 2026-11-25 (no reading asks one now: the reader's fit decides), kept where the
 * form-filling track reads the application profile: a confirmed fact of the `person` line, no project, slot `apply.<name>` (§12). The
 * card's own opportunity is settled by the person's answers alone: a 「不满足」 (`no`) rules it out, anything else lets it through.
 * Returns 1 when its verdict changed.
 */
export function recordEligibilityAnswer(store: CrosslineStore, workspaceId: string, slot: string, value: string, opportunityId: string, now = new Date()): number {
  store.upsertProfileFact({ workspaceId, identityId: "person", projectId: "", slot, value, status: "confirmed", sourceRef: `opportunity:${opportunityId}`,
    sourceQuote: value, updatedAt: now.toISOString() });
  const row = store.listOpportunities(workspaceId, { id: opportunityId })[0];
  if (!row || (row.decision && row.decision !== "later")) return 0;
  const t = tFor(readLocale(store, workspaceId));
  if (value === "no" && row.verdict.state !== "ineligible") {
    store.setOpportunityVerdict(workspaceId, row.id, { state: "ineligible", failed: [{ dim: "other", rule: t("资格条件"), why: t("本人确认不满足") }] }, now.toISOString());
    return 1;
  }
  if (value !== "no" && row.verdict.state === "unknown") {
    store.setOpportunityVerdict(workspaceId, row.id, { state: "eligible", basis: [] }, now.toISOString());
    return 1;
  }
  return 0;
}

/** The week's discovery in numbers, for the weekly review (§7: an ineligible opportunity is counted there and nowhere else). */
export function opportunityWeek(store: CrosslineStore, workspaceId: string, since: string): { found: number; eligible: number; unknown: number; ineligible: number; decided: number } {
  const rows = store.listOpportunities(workspaceId).filter((row) => row.foundAt >= since);
  return { found: rows.length, eligible: rows.filter((row) => row.verdict.state === "eligible").length,
    unknown: rows.filter((row) => row.verdict.state === "unknown").length, ineligible: rows.filter((row) => row.verdict.state === "ineligible").length,
    decided: rows.filter((row) => row.decision && row.decision !== "later").length };
}
