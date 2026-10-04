import "server-only";
import { profileGaps, type AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { latestFileDates } from "@crossline/db";
import { getStore } from "./crossline";
import { countProposedTargets } from "./targets";
import { loadDiligence } from "./diligence";
import { loadPendingDateBatch } from "./imported-dates";

/**
 * Everything waiting for the person to say yes or no, in one number per kind. The badge in the header and the
 * confirmation page both read this, so what the badge counts is exactly what the page lists.
 */
export type PendingCounts = {
  total: number;
  /** Work orders the analysis proposed, waiting for their plan to be approved. */
  workOrders: number;
  /** Differences between the plan and reality, or between plan versions. */
  planChanges: number;
  /** Milestones the architect drafted. */
  milestoneDrafts: number;
  /** Cross-line relations proposed but not yet confirmed. */
  relations: number;
  /** Proposals from web research. */
  research: number;
  /** A batch of dates read from files. */
  dates: number;
  /** Questions the profile still needs answered: a line resting only on guesses. */
  questions: number;
  /** Targets the architect proposed (a course's grade) that the person has not yet accepted or changed. */
  targets: number;
};

export function countPending(ctx: AccessContext): PendingCounts {
  const store = getStore();
  const latestPlan = store.listPlanVersions(ctx.workspaceId)[0];
  const counts = {
    workOrders: store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval").length,
    planChanges: latestPlan ? store.listPlanChanges(ctx.workspaceId, latestPlan.id).filter((change) => change.status === "pending").length : 0,
    milestoneDrafts: store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "draft").length,
    relations: store.listMilestoneRelations(ctx.workspaceId).filter((relation) => relation.status === "candidate").length,
    research: loadDiligence(ctx).filter((report) => report.status === "done")
      .reduce((sum, report) => sum + report.proposals.filter((proposal) => proposal.status === "pending").length, 0),
    dates: loadPendingDateBatch(ctx) ? 1 : 0,
    targets: countProposedTargets(ctx),
    questions: profileGaps({
      identities: defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label })),
      projects: store.listProjects(ctx.workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
      facts: store.listProfileFacts(ctx.workspaceId),
      undated: latestFileDates(store, ctx.workspaceId).undated
    }).filter((gap) => gap.blocking).length
  };
  return { ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}
