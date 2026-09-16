/**
 * Gate 1–2 evidence (design §12): prove a natural-language capture really reaches
 * `awaiting_plan_approval` through the live Codex app-server, carrying thread/turn audit ids, and that
 * the resulting WorkOrder is what the dashboard reads.
 *
 *   pnpm exec tsx scripts/gate-analysis-check.ts [--live]
 *
 * It writes to a throwaway database under the OS temp dir by default, so proving the gate never adds
 * a synthetic capture to the real ledger. `--live` points it at CROSSLINE_DATA_DIR instead.
 *
 * This is deliberately not a vitest file: §12 asks for evidence from a real run, and a test that
 * stubs the runtime would prove only that the stub works.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createCaptureAnalyzer } from "../apps/worker/src/analysis";

const repoRoot = path.resolve(import.meta.dirname, "..");
const live = process.argv.includes("--live");
const dataDir = live
  ? path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"))
  : mkdtempSync(path.join(tmpdir(), "crossline-gate-"));

const workspaceId = "personal-crossline";
const captureId = `gate-check-${Date.now()}`;
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));

// A milestone the proposal can legitimately bind to. On a live run the seed milestones already exist.
if (!store.listMilestones(workspaceId).some((milestone) => milestone.status === "approved")) {
  store.saveMilestone({
    id: "gate-check-milestone", ownerId: "local-owner", workspaceId, identityId: "research",
    projectId: "gate-check-project", title: "闸门检查用里程碑", version: 1, status: "approved"
  });
}

store.capture({
  id: captureId, ownerId: "local-owner", workspaceId,
  // Deliberately self-contained: the Skill is instructed to stop when a required input is unavailable,
  // so a capture that points at an external system proves nothing except that the rule works.
  title: "写一段 200 字的研究方向说明，用于下周组会的自我介绍",
  context: "内容凭自己的判断写，不需要查任何外部资料"
}, `gate-check:${captureId}`);

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-automation-stripper"]
  }
});

try {
  console.info(JSON.stringify({ status: "cost_signal", signal: await supervisor.readCostSignal() }));
  const analyze = createCaptureAnalyzer(store, repoRoot);
  const result = await analyze(supervisor.client, captureId) as {
    state: string; audit?: { threadId?: string; turnId?: string; blocker?: { code: string; message: string } };
  };

  const workOrder = store.listWorkOrders(workspaceId).find((item) => item.id === captureId);
  console.info(JSON.stringify({
    status: "gate_1_2",
    dataDir,
    live,
    state: result.state,
    // The audit ids are the point: without them there is no evidence a real turn ran.
    threadId: result.audit?.threadId ?? null,
    turnId: result.audit?.turnId ?? null,
    blocker: result.audit?.blocker ?? null,
    workOrderOnBoard: workOrder
      ? { id: workOrder.id, identityId: workOrder.identityId, milestoneId: workOrder.milestoneId, state: workOrder.state }
      : null
  }, null, 1));
  process.exitCode = result.state === "awaiting_plan_approval" && workOrder ? 0 : 1;
} finally {
  await supervisor.stop();
  store.close();
}
