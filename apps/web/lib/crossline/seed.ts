import "server-only";
import { defaultMilestoneTemplates, type AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { seedExampleReadiness } from "../example-readiness";
import { getStore } from "./store";
import type { PersistedScheduleBlock } from "./schedule";

/**
 * Which identities get seeded is decided by the installed packs, never by a fixed list. A hardcoded
 * list meant that swapping the packs seeded milestones for identities that no longer existed, and
 * `validateAnalysisContext` then refused every single analysis with `ANALYSIS_CONTEXT_INVALID`.
 */
export const seedIdentities = () => defaultIdentityPacks().filter((pack) => pack.kind === "identity");

/* i18n-ignore-start: example content for the test board (person-written data, not interface) */
// Example content for the packs this repo happens to ship. Keyed by id, so an unknown identity falls
// back to a generic starter written from the pack's own label instead of being skipped.
const starterMilestoneTitles: Record<string, string> = {
  research: "稳定推进当前实验与论文",
  startup: "验证一个可付费的真实问题",
  media: "建立一次可复用的内容闭环",
  investment: "形成有证据的每周研究备忘录"
};

// `priorFamily` names which labelled prior in the identity pack this seed belongs to, so the estimate
// is read from `durationPriors` instead of being derived from a hand-written minute count.
type StarterWorkOrder = { title: string; energy: "low" | "medium" | "high"; priorFamily: string };
const starterWorkOrders: Record<string, StarterWorkOrder> = {
  research: { title: "梳理本周科研下一步", energy: "high", priorFamily: "deep_work" },
  startup: { title: "写下当前创业里程碑的一个可验证假设", energy: "medium", priorFamily: "preparation" },
  media: { title: "从本周工作中提取一个可公开选题", energy: "low", priorFamily: "review" },
  investment: { title: "整理当前美股与 ETF 关注清单", energy: "medium", priorFamily: "review" }
};
/* i18n-ignore-end */

// A prior is honest only when it really comes from the pack. Deriving p25/p85 from one hand-written
// number and labelling the result `identity_prior` was a fabricated interval wearing a real label.
function identityPrior(identityId: string, family: string) {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId && item.kind === "identity");
  const prior = pack?.durationPriors[family] ?? pack?.durationPriors.review;
  return { ...(prior ?? { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 }),
    source: "identity_prior" as const, observationCount: 0, confidence: "low" as const };
}

export function ensureSeeded(ctx: AccessContext): void {
  const store = getStore();
  // Example milestones, relations and work orders exist only so the e2e suite and the unit tests have a board
  // to drive. A real account starts empty: its goals come from the interview, not from four placeholders that
  // every user shared and none of them chose.
  if (process.env.CROSSLINE_SEED_EXAMPLES === "1") {
    // The example board meets the start standard, or every page of the suites would lead back to the interview.
    seedExampleReadiness(store, ctx);
    // Earlier seeds wrote no projectId, and analysis only offers milestones that have one, so an existing
    // database would stay permanently unanalysable. Re-seeding is idempotent and repairs those rows.
    const seeded = store.listMilestones(ctx.workspaceId);
    if (seeded.length === 0 || seeded.some((milestone) => milestone.id.endsWith("-starter") && !milestone.projectId)) {
      for (const pack of seedIdentities()) {
        store.saveMilestone({
          id: `${pack.id}-starter`, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
          identityId: pack.id, projectId: `${pack.id}-default`,
          title: starterMilestoneTitles[pack.id] ?? `为「${pack.label}」确定第一个可验收的里程碑`, // i18n-ignore: example data
          version: 1, status: "approved"
        });
      }
    }
    if (store.listMilestoneRelations(ctx.workspaceId).length === 0) {
      const relations = [
        ["research-startup", "research-starter", "startup-starter", "informs", "approved"],
        ["startup-media", "startup-starter", "media-starter", "reuses", "approved"],
        ["media-research", "media-starter", "research-starter", "recurring_feedback", "approved"],
        // Seeded id "research-investment" can never match the flywheel's own id scheme
        // (`flywheel:<from>-><to>:<kind>`), so a candidate here would be a permanent, un-fillable orphan
        // the review page could only ever show as unreviewable. Seeded approved, like the other three.
        ["research-investment", "research-starter", "investment-starter", "informs", "approved"]
      ] as const;
      // These example relations describe the four packs this repo ships. Under a different pack set
      // their endpoints do not exist, and a relation pointing at a missing milestone is worse than no
      // relation at all — so it is skipped rather than seeded dangling.
      const seededMilestoneIds = new Set(store.listMilestones(ctx.workspaceId).map((milestone) => milestone.id));
      for (const [id, fromMilestoneId, toMilestoneId, kind, status] of relations) {
        if (!seededMilestoneIds.has(fromMilestoneId) || !seededMilestoneIds.has(toMilestoneId)) continue;
        store.saveMilestoneRelation({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, fromMilestoneId, toMilestoneId, kind, status });
      }
    }
    if (store.listWorkOrders(ctx.workspaceId).length === 0) {
      for (const pack of seedIdentities()) {
        const identityId = pack.id;
        const { title, energy, priorFamily } = starterWorkOrders[identityId]
          ?? { title: `写下「${pack.label}」当前最该推进的一件事`, energy: "medium" as const, priorFamily: "review" }; // i18n-ignore: example data
        const id = `${identityId}-starter-work-order`;
        const milestoneId = store.listMilestones(ctx.workspaceId).find((item) => item.identityId === identityId)?.id ?? `${identityId}-unassigned`;
        store.saveWorkOrder({
          id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, identityId,
          projectId: `${identityId}-default`, milestoneId, intent: title,
          state: "ready_for_human", riskTier: "milestone",
          estimate: identityPrior(identityId, priorFamily),
          payload: { seeded: true, materialContract: [], evidenceContract: [{ kind: "record", required: true }],
            humanCore: [{ id: `${id}-core`, intent: title, energy, interruptible: true }] }
        });
      }
    }
  }
  if (store.listMilestoneTemplates(ctx.workspaceId).length === 0) {
    store.seedMilestoneTemplates(ctx.workspaceId, defaultMilestoneTemplates());
  }
  if (store.listPlanVersions(ctx.workspaceId).length === 0) {
    // An empty plan, not five example blocks. The lanes fill from two real sources now — the calendar
    // and the scheduler — and seeding a fake day meant the first thing a new database showed was a
    // schedule nobody had made, in a view whose whole job is to say what is really committed.
    store.savePlanVersion({
      id: "personal-plan-v1", ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      version: 1, status: "current", payload: { blocks: [] }
    });
  }

  // A database seeded before the scheduler was wired up still holds the five example blocks; `loadCurrentPlan` no longer reads them.
  for (const plan of store.listPlanVersions(ctx.workspaceId)) {
    const blocks = (plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? [];
    const real = blocks.filter((block) => block.source !== "示例数据"); // i18n-ignore: a stored marker
    if (real.length === blocks.length) continue;
    store.savePlanVersion({ ...plan, payload: { blocks: real } });
  }
}
