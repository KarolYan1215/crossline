/**
 * Gate 5 evidence (design §12): run the flywheel Skill for real, with web access, and show what it
 * actually produced — every finding must name an existing milestone, cite a URL it really read, the
 * date it read it, and the condition that would make it stale.
 *
 *   pnpm exec tsx scripts/gate-flywheel-check.ts          # live ledger (findings are idempotent per day)
 *   pnpm exec tsx scripts/gate-flywheel-check.ts --dry    # same run, nothing written
 *
 * This is the only Skill granted the public web, and it is the most expensive one to run, so it is
 * never invoked as a side effect of anything else.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import path from "node:path";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { buildFlywheelContext, createFlywheelExpander } from "../apps/worker/src/flywheel";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? "personal-crossline";
const dry = process.argv.includes("--dry");

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const context = buildFlywheelContext(store, workspaceId);
console.info(JSON.stringify({
  status: "flywheel_context",
  openMilestones: context.openMilestones.map((milestone) => ({
    id: milestone.id, title: milestone.title, criteria: milestone.successCriteria.length
  }))
}, null, 1));

if (!context.openMilestones.length) {
  console.error(JSON.stringify({ status: "blocked", code: "NO_OPEN_MILESTONES",
    message: "没有已批准的里程碑，飞轮没有可挂靠的对象。" }));
  store.close();
  process.exit(1);
}

const before = store.listEvents(WORKSPACE).filter((event) => event.type === "flywheel.finding").length;
const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-flywheel-scout"]
  }
});

try {
  // A dry run still performs the real search and the real validation; it only skips the ledger write,
  // so "it worked" cannot be claimed on the strength of a run that never happened.
  const target = dry ? new CrosslineStore(":memory:") : store;
  if (dry) {
    for (const milestone of store.listMilestones(workspaceId)) target.saveMilestone(milestone);
  }
  const expand = createFlywheelExpander(target, workspaceId, repoRoot, () => supervisor.client);
  const count = await expand();

  const findings = target.listEvents(WORKSPACE).filter((event) => event.type === "flywheel.finding");
  for (const event of findings) {
    const finding = event.payload as { milestoneId: string; summary: string; sourceUrl: string; retrievedAt: string; staleWhen: string; helpsHow: string };
    console.info(JSON.stringify({ status: "finding", ...finding }, null, 1));
  }
  const candidates = target.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "candidate");
  for (const relation of candidates) {
    console.info(JSON.stringify({
      status: "candidate_relation", id: relation.id, kind: relation.kind,
      from: relation.fromMilestoneId, to: relation.toMilestoneId,
      explanation: relation.explanation, refutedWhen: relation.refutedWhen, evidence: relation.evidence
    }, null, 1));
  }

  console.info(JSON.stringify({
    status: count > 0 ? "gate_5_produced" : "gate_5_empty",
    dry, produced: count, storedBefore: before, storedNow: findings.length,
    candidateRelations: candidates.length,
    // Returning nothing is a valid answer for this Skill, so an empty run is reported as empty rather
    // than dressed up as a pass.
    note: count > 0 ? "每条发现都已通过来源 URL、读取日期与失效条件的校验" : "本次没有产出发现；这是允许的答案，不算通过"
  }, null, 1));
  if (dry) target.close();
  process.exitCode = count > 0 ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ status: "blocked", code: error instanceof Error ? error.message : "FLYWHEEL_FAILED" }));
  process.exitCode = 1;
} finally {
  await supervisor.stop();
  store.close();
}
