import {
  SCOUT_NEEDS_SETTING, applicantFrom, judgeEligibility, mergeNeeds, readNeeds, tFor,
  type EligibilityVerdict, type StoredNeed
} from "@crossline/core";
import type { CrosslineStore, StoredOpportunity } from "./index";
import { readLocale } from "./locale";

/**
 * The opportunity agent's ledger helpers shared by the worker and the web (docs/opportunity-agent.md §5–8): the needs kept per workspace,
 * the person's answer to a need and eligibility answers as profile facts. 报名 goes to the form-filling track's `queueFormRun` (form-runs.ts).
 */

export const scoutNeeds = (store: CrosslineStore, workspaceId: string): StoredNeed[] => readNeeds(store.getSetting(workspaceId, SCOUT_NEEDS_SETTING));

/** A line's new derivation merged into what is kept (`mergeNeeds`); returns everything kept after it. */
export function saveLineNeeds(store: CrosslineStore, workspaceId: string, lineId: string, fresh: StoredNeed[]): StoredNeed[] {
  const next = mergeNeeds(scoutNeeds(store, workspaceId), lineId, fresh);
  store.setSetting(workspaceId, SCOUT_NEEDS_SETTING, JSON.stringify(next));
  return next;
}

export const waitingIdForNeed = (needId: string) => `wait-opp-${needId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;

/**
 * The person's answer to a proposed need: 跟踪 starts watching its sources and, for a cycle, writes the 「预计 X 月开放」 waiting item
 * (asked about on its day like any other); 不要 is remembered as a preference so it is not proposed again. Undoing is answering again.
 */
export function decideNeed(store: CrosslineStore, workspaceId: string, ownerId: string, needId: string, decision: "tracking" | "declined",
  now = new Date(), note = ""): StoredNeed | undefined {
  const needs = scoutNeeds(store, workspaceId);
  const need = needs.find((item) => item.id === needId);
  if (!need) return undefined;
  const t = tFor(readLocale(store, workspaceId));
  const decided: StoredNeed = { ...need, state: decision, decidedAt: now.toISOString() };
  store.setSetting(workspaceId, SCOUT_NEEDS_SETTING, JSON.stringify(needs.map((item) => item.id === needId ? decided : item)));
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.need.decided:${needId}:${now.toISOString()}`, type: "opportunity.need.decided",
    entityId: needId, payload: { needId, lineId: need.lineId, decision, title: need.title } });
  if (decision === "declined") {
    store.addPreference({ workspaceId, source: "opportunity_declined", scope: need.lineId, weight: 1, refId: needId,
      text: note.trim() ? t("不要「{{title}}」这类机会：{{note}}", { title: need.title, note: note.trim().slice(0, 200) })
        : t("不要「{{title}}」这类机会（{{why}}）", { title: need.title, why: need.why.slice(0, 120) }) });
    const waiting = store.listWaitingItems(workspaceId, { state: "open" }).find((item) => item.id === waitingIdForNeed(needId));
    if (waiting) store.answerWaitingItem(workspaceId, waiting.id, { kind: "cancelled" }, ownerId);
    return decided;
  }
  const opens = need.window?.opens ?? need.window?.closes;
  // A window already open needs no wait: its sources are read from today.
  if (need.kind === "cycle" && opens && opens > now.toISOString().slice(0, 7)) {
    const expectedAt = `${opens}-01`;
    // Tracked again after a 不要: the earlier wait is opened again rather than written twice.
    const earlier = store.listWaitingItems(workspaceId).find((item) => item.id === waitingIdForNeed(needId));
    if (earlier) { if (earlier.state !== "open") store.reopenWaitingItem(workspaceId, earlier.id, expectedAt, ownerId); return decided; }
    store.saveWaitingItem({ id: waitingIdForNeed(needId), ownerId, workspaceId, who: "",
      title: t("「{{title}}」预计 {{month}} 开放", { title: need.title, month: opens }), expectedAt, approximate: true, followUpAt: expectedAt,
      state: "open", blocks: [], source: "opportunity" });
  }
  return decided;
}

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
