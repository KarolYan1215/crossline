import "server-only";
import { onPersonsBoard, type AccessContext } from "@crossline/core";
import { resultsAwaitingReview } from "@crossline/db";
import { appNow, getStore } from "./crossline";
import { countProposedTargets } from "./targets";
import { countAssistantPending } from "./agent";
import { loadDiligence } from "./diligence";
import { loadPendingDateBatch } from "./imported-dates";
import { listed, openAsks } from "./asks";
import { decisionHorizon } from "./horizon";
import { interviewStatus } from "./interview-status";
import { preparingProposalIds } from "./proposal-ready";
import { memoByLedger } from "./ledger-memo";

/**
 * Everything waiting for the person to say yes or no this week, in one number per kind. The badge in the header and the
 * confirmation page both read this, so what the badge counts is exactly what the page lists. Task proposals, milestone drafts, asks
 * and assistant results whose work need not start within seven days (`lib/horizon.ts`) are counted in `later` instead and come
 * into the week's numbers by themselves.
 */
export type PendingCounts = {
  total: number;
  /** Work orders the analysis proposed, waiting for their plan to be approved. */
  workOrders: number;
  /** Milestones the architect drafted. */
  milestoneDrafts: number;
  /** Cross-line relations proposed but not yet confirmed. Decided in the weekly review, so not in `total`. */
  relations: number;
  /** Proposals from web research. */
  research: number;
  /** A batch of dates read from files. */
  dates: number;
  /**
   * The interview's open questions — exactly the ones the interview page shows (`interviewStatus`, screened) — while it is unfinished.
   * They are answered in the interview (scenarios.md §3.8, 2026-10-29), so 待确认 links to it with this count; not in `total`.
   */
  questions: number;
  /** Targets the architect proposed (a course's grade) that the person has not yet accepted or changed. */
  targets: number;
  /** Kinds of work the assistant would like to start but has not been allowed to. */
  assistantKinds: number;
  /** Questions the guard put to the person in the middle of a run. */
  assistantQuestions: number;
  /** Finished tasks waiting for the person to look at what the assistant made. */
  assistantReviews: number;
  /**
   * Questions the system put because it stopped and only the person can say how to go on (see `lib/asks.ts`): a missing
   * input, something awaited that was due, a refused capture, a failed gate, a milestone at risk. Snoozed ones are not counted.
   */
  asks: number;
  /** Decisions that are not this week's, by kind; not in `total`. */
  later: { workOrders: number; milestoneDrafts: number; asks: number; assistantReviews: number; total: number };
};

export function countPending(ctx: AccessContext): PendingCounts {
  // Polled by every open page's badge: reused until the ledger changes or half a minute passes (`lib/ledger-memo.ts`).
  return memoByLedger(getStore(), `pending:${ctx.workspaceId}:${appNow().toISOString().slice(0, 16)}`, 30_000, () => computePending(ctx));
}

function computePending(ctx: AccessContext): PendingCounts {
  const store = getStore();
  const assistant = countAssistantPending(ctx);
  const horizon = decisionHorizon(ctx);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const split = <T>(items: T[], deferred: (item: T) => boolean) => { const later = items.filter(deferred).length; return { now: items.length - later, later }; };
  // A proposal whose steps are still being planned is not a decision yet (`lib/proposal-ready.ts`).
  const preparing = preparingProposalIds(ctx);
  // A question to the person waiting as an order (docs/work-split.md) is not a proposal to approve: it reaches the person as an ask.
  const proposals = split(orders.filter((order) => order.state === "awaiting_plan_approval" && !preparing.has(order.id) && onPersonsBoard(order)),
    (order) => Boolean(horizon.orderEntry(order)));
  const drafts = split(store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "draft"), (milestone) => Boolean(horizon.milestoneEntry(milestone.id)));
  const asks = split(listed(openAsks(ctx)), (ask) => Boolean(ask.entersOn));
  const reviews = split(resultsAwaitingReview(store, ctx.workspaceId), (task) => {
    const order = orders.find((item) => item.id === task.workOrderId);
    return Boolean(order && horizon.orderEntry(order));
  });
  const counts = {
    workOrders: proposals.now,
    milestoneDrafts: drafts.now,
    relations: store.listMilestoneRelations(ctx.workspaceId).filter((relation) => relation.status === "candidate").length,
    research: loadDiligence(ctx).filter((report) => report.status === "done")
      .reduce((sum, report) => sum + report.proposals.filter((proposal) => proposal.status === "pending").length, 0),
    dates: loadPendingDateBatch(ctx) ? 1 : 0,
    targets: countProposedTargets(ctx),
    assistantKinds: assistant.categories,
    assistantQuestions: assistant.approvals,
    assistantReviews: reviews.now,
    asks: asks.now,
    questions: interviewQuestions(ctx)
  };
  // Candidate relations and research proposals are judged in the weekly review (`/review`), not one by one as they arrive (the
  // person's decision, 2026-10-13): whether to take one is a judgement about direction, not a fact only they can give. They stay listed
  // there and are left out of the number that asks for today's decisions.
  // The interview's questions are answered in the interview, not counted as decisions (scenarios.md §3.8).
  const { relations: _weekly, research: _weeklyResearch, questions: _interview, ...today } = counts;
  const later = { workOrders: proposals.later, milestoneDrafts: drafts.later, asks: asks.later, assistantReviews: reviews.later };
  return { ...counts, total: Object.values(today).reduce((sum, value) => sum + value, 0),
    later: { ...later, total: Object.values(later).reduce((sum, value) => sum + value, 0) } };
}

/**
 * The badge once counted the profile's blocking gaps unscreened, so a question the interview page had screened out (or that a file
 * already answered) showed as 「访谈问题 1」 with nowhere to answer it (2026-10-17 walkthrough, W-13). It reads the same list the interview
 * page does; once the checklist is complete there are none.
 */
function interviewQuestions(ctx: AccessContext): number {
  const status = interviewStatus(ctx);
  return status.started && !status.complete ? status.openQuestions : 0;
}
