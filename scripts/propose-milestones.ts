/**
 * Asks the architect Skill for new milestones and stores them as drafts.
 *
 *   pnpm exec tsx scripts/propose-milestones.ts ["往哪个方向走"]
 *
 * Drafts only — approving is done in the UI, because choosing what you are working towards is the one
 * decision this system does not make for you. The same path runs from the milestones page; this script
 * exists so it can be exercised without a browser.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import path from "node:path";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createMilestoneProposer } from "../apps/worker/src/milestone-proposer";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? "personal-crossline";
const request = process.argv.slice(2).filter((arg) => arg !== "--").join(" ");

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
  const propose = createMilestoneProposer(store, workspaceId, repoRoot, () => supervisor.client);
  const outcome = await propose(request);
  if (outcome.state === "blocked") {
    console.error(JSON.stringify({ status: "blocked", code: outcome.code, message: outcome.message }));
    process.exitCode = 1;
  } else {
    for (const draft of outcome.drafts) {
      const stored = store.listMilestones(workspaceId).find((milestone) => milestone.id === draft.id);
      console.info(JSON.stringify({
        status: "draft", id: draft.id, identityId: draft.identityId, title: draft.title,
        verifiability: stored?.verifiability,
        // Printed so an all-output proposal is visible here rather than only in the UI.
        outcomeCriteria: stored?.successCriteria.filter((criterion) => criterion.evidenceOf === "outcome").length,
        criteria: stored?.successCriteria
      }, null, 1));
    }
    console.info(JSON.stringify({ status: "proposed", drafts: outcome.drafts.length, assumptions: outcome.assumptions }, null, 1));
  }
} finally {
  await supervisor.stop();
  store.close();
}
