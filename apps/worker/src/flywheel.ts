import { FLYWHEEL_OUTPUT_SCHEMA, validateFlywheelExpansion, type FlywheelContext, type FlywheelExpansion }
  from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

const OWNER_ID = "local-owner";
export const FLYWHEEL_SKILL = "crossline:crossline-flywheel-scout";

const INSTRUCTIONS = "Search the public web for information that would help finish the supplied "
  + "milestones. Return only the requested JSON. Every finding must name one supplied milestoneId, "
  + "cite the URL you actually read, the date you read it, and the condition that would make it stale. "
  + "You may also propose relations between two DIFFERENT supplied milestones when what you read gives "
  + "a concrete reason one helps the other: state the claim in `explanation`, state in `refutedWhen` "
  + "what would show that claim is wrong, and cite the source you actually read. Do not propose tasks, "
  + "do not propose new milestones, do not change anything, and do not invent sources. Returning no "
  + "findings and no relations is a valid answer.";

export function buildFlywheelContext(store: CrosslineStore, workspaceId: string): FlywheelContext {
  const milestones = store.listMilestones(workspaceId).filter((item) => item.status === "approved");
  const orders = store.listWorkOrders(workspaceId);
  return {
    version: "crossline.flywheel.v1",
    openMilestones: milestones.map((milestone) => ({
      id: milestone.id, identityId: milestone.identityId, title: milestone.title,
      successCriteria: milestone.successCriteria
    })),
    recentOutputs: orders
      .filter((order) => order.state === "accepted")
      .slice(-20)
      .map((order) => ({ milestoneId: order.milestoneId, intent: order.intent, acceptedAt: "" }))
  };
}

/**
 * Runs the nightly expansion and stores whatever it found as evidence rows against their milestone.
 *
 * Findings are stored, never acted on: they are reading material for the morning, and anything that
 * would change the plan still goes through the same approval the rest of the system uses.
 */
export function createFlywheelExpander(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function expand(): Promise<number> {
    const client = getClient();
    if (!client) throw new Error("CODEX_SUPERVISOR_UNAVAILABLE");
    const context = buildFlywheelContext(store, workspaceId);
    if (!context.openMilestones.length) return 0;

    const result = await runCodexSkill<FlywheelExpansion>(client, context, {
      skillName: FLYWHEEL_SKILL,
      cwd,
      developerInstructions: INSTRUCTIONS,
      outputSchema: FLYWHEEL_OUTPUT_SCHEMA,
      // Reaching the public web is the whole point of this Skill, and the only one that gets it.
      allowWebSearch: true,
      prepareInput: () => context,
      validateOutput: (output) => validateFlywheelExpansion(output, context),
      onAudit: () => {},
      timeoutMs: 15 * 60_000
    });
    if (!result.ok) throw new Error(result.blocker.code);

    const day = new Date().toISOString().slice(0, 10);
    for (const [index, finding] of result.output.findings.entries()) {
      store.appendEvent({
        ownerId: OWNER_ID, workspaceId,
        idempotencyKey: `flywheel:finding:${day}:${index}`,
        type: "flywheel.finding", entityId: finding.milestoneId,
        payload: finding
      });
    }

    // Relations land as candidates only. Nothing here decides anything: a candidate is a question for
    // the weekly review, and `rankCandidates` orders them by counted facts rather than by the model's
    // own sense of how good its suggestion was.
    const existing = new Map(store.listMilestoneRelations(workspaceId).map((relation) => [relation.id, relation]));
    let proposed = 0;
    for (const relation of result.output.relations) {
      // A stable id, so the same relation proposed on two nights updates one row instead of filling
      // the pool with copies of itself.
      const id = `flywheel:${relation.fromMilestoneId}->${relation.toMilestoneId}:${relation.kind}`;
      const current = existing.get(id);
      // Never overwrite a decision the user already made, and never resurrect something the evidence
      // refuted. A nightly job that quietly un-approves relations would make the review meaningless.
      if (current && current.status !== "candidate") continue;
      store.saveMilestoneRelation({
        id, ownerId: OWNER_ID, workspaceId,
        fromMilestoneId: relation.fromMilestoneId, toMilestoneId: relation.toMilestoneId,
        kind: relation.kind, status: "candidate",
        evidence: [{ uri: relation.sourceUrl, source: relation.sourceTitle, observedAt: relation.retrievedAt }],
        // Counterexamples belong to the gate and to the user, so a re-proposal never clears them.
        counterexample: current?.counterexample ?? [],
        costMinutes: current?.costMinutes ?? null,
        lastValidatedAt: relation.retrievedAt,
        explanation: relation.explanation,
        refutedWhen: relation.refutedWhen
      });
      store.appendEvent({
        ownerId: OWNER_ID, workspaceId,
        idempotencyKey: `flywheel:relation:${day}:${id}`,
        type: "flywheel.relation_proposed", entityId: id, payload: relation
      });
      proposed += 1;
    }
    return result.output.findings.length + proposed;
  };
}
