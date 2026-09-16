/**
 * Proposes success criteria for approved milestones that do not have any yet.
 *
 *   pnpm exec tsx scripts/propose-milestone-criteria.ts            # propose and print only
 *   pnpm exec tsx scripts/propose-milestone-criteria.ts --accept   # also write them
 *
 * Criteria are the user's to own, so proposing and accepting are separate steps and the default does
 * not write. `--accept` records who accepted in the ledger; set `CROSSLINE_CRITERIA_ACCEPTED_BY` when
 * the acceptance is standing in for someone, so the record says so instead of implying a judgement
 * nobody made.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import path from "node:path";
import {
  CRITERIA_OUTPUT_SCHEMA, validateCriteriaProposal, validateSuccessCriteria,
  type CriteriaContext, type CriteriaProposal
} from "../packages/core/src/index";
import { runCodexSkill, startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? "personal-crossline";
const accept = process.argv.includes("--accept");
// The owner. Criteria belong to the user, and an acceptance made on their instruction is their
// decision — recording it as anything else would understate what they actually own.
const acceptedBy = process.env.CROSSLINE_CRITERIA_ACCEPTED_BY ?? "local-owner";

const INSTRUCTIONS = "Propose success criteria for each supplied milestone. Return only the requested "
  + "JSON. Every criterion needs an observable acceptance condition: prefer count, threshold or "
  + "artifact measures, and use a judgement measure only when the milestone genuinely cannot be counted "
  + "— a judgement measure must state `failsWhen`, the condition under which it is not met. Criteria "
  + "must be things a person could check without re-doing the work. Do not invent facts about the "
  + "user's situation; if a milestone is too vague to judge, return a blocker naming what is missing.";

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-milestone-architect"]
  }
});

try {
  const needing = store.listMilestones(workspaceId)
    .filter((milestone) => milestone.status === "approved" && milestone.verifiability === "unstated");
  if (!needing.length) {
    console.info(JSON.stringify({ status: "nothing_to_propose", message: "已批准的里程碑都已经有达成标准。" }));
    process.exit(0);
  }

  const orders = store.listWorkOrders(workspaceId);
  const context: CriteriaContext = {
    version: "crossline.milestone-criteria.v1",
    milestones: needing.map((milestone) => ({
      id: milestone.id, identityId: milestone.identityId, title: milestone.title, evidencePolicy: "tiered"
    })),
    recentWork: orders.slice(-20).map((order) => ({
      milestoneId: order.milestoneId ?? "", intent: order.intent, state: order.state
    }))
  };

  const result = await runCodexSkill<CriteriaProposal>(supervisor.client, context, {
    skillName: "crossline:crossline-milestone-architect",
    cwd: repoRoot,
    developerInstructions: INSTRUCTIONS,
    outputSchema: CRITERIA_OUTPUT_SCHEMA,
    prepareInput: () => context,
    validateOutput: (output) => validateCriteriaProposal(output, context),
    onAudit: () => {},
    timeoutMs: 10 * 60_000
  });
  if (!result.ok) {
    console.error(JSON.stringify({ status: "blocked", ...result.blocker }));
    process.exit(1);
  }

  const written: string[] = [];
  for (const proposal of result.output.milestones) {
    const milestone = needing.find((item) => item.id === proposal.milestoneId);
    if (!milestone) continue;
    // The same rule the store enforces, checked here so a rejected proposal is reported as a proposal
    // problem rather than surfacing later as an opaque write failure.
    const checked = validateSuccessCriteria(proposal.successCriteria);
    console.info(JSON.stringify({
      status: "proposal", milestoneId: milestone.id, title: milestone.title,
      verifiability: checked.ok ? checked.verifiability : null,
      rejected: checked.ok ? null : checked.blocker,
      rationale: proposal.rationale,
      criteria: proposal.successCriteria
    }, null, 1));
    if (!accept || !checked.ok) continue;

    store.saveMilestone({
      id: milestone.id, ownerId: milestone.ownerId, workspaceId,
      identityId: milestone.identityId, projectId: milestone.projectId,
      title: milestone.title, version: milestone.version, status: milestone.status,
      successCriteria: proposal.successCriteria
    });
    store.appendEvent({
      ownerId: milestone.ownerId, workspaceId,
      idempotencyKey: `milestone:criteria:${milestone.id}:${milestone.version}`,
      type: "milestone.criteria_accepted", entityId: milestone.id,
      // Who accepted is part of the record, and the rationale travels with it so a criterion can be
      // re-read later together with the reason it was proposed.
      payload: { acceptedBy, rationale: proposal.rationale, criteria: proposal.successCriteria }
    });
    written.push(milestone.id);
  }

  console.info(JSON.stringify({
    status: accept ? "accepted" : "proposed_only",
    acceptedBy: accept ? acceptedBy : null,
    written,
    assumptions: result.output.assumptions
  }, null, 1));
} finally {
  await supervisor.stop();
  store.close();
}
