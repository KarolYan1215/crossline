/**
 * Runs a small, privacy-safe corpus through the real Crossline Codex workflow.
 *
 * The corpus is opt-in because every case consumes a real Codex turn. It always uses a temporary
 * ledger and logs only case IDs, states, and audit IDs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createCaptureAnalyzer } from "../apps/worker/src/analysis";

if (!process.argv.includes("--live")) {
  throw new Error("CODEX_CORPUS_LIVE_FLAG_REQUIRED: rerun with --live to spend Codex usage");
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-codex-corpus-"));
const workspaceId = "personal-crossline";
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const cases = [
  {
    id: "self-contained-research-summary",
    title: "写一段 200 字的研究方向说明，用于下周组会的自我介绍",
    context: "内容凭自己的判断写，不需要查任何外部资料",
    expected: "awaiting_plan_approval"
  },
  {
    id: "partial-input-needs-material-contract",
    title: "根据这段实验记录写出组会摘要",
    context: "实验记录：基线准确率为 81%，只改学习率后为 84%。还缺最终图和误差条。",
    expected: "awaiting_plan_approval"
  },
  {
    id: "missing-required-input-blocks",
    title: "从提供的访谈记录里提取所有承诺并列成表",
    context: "",
    expected: "blocked"
  }
] as const;

store.saveMilestone({
  id: "corpus-milestone", ownerId: "local-owner", workspaceId, identityId: "research",
  projectId: "corpus-project", title: "Codex 工作流回归", version: 1, status: "approved"
});
for (const item of cases) {
  store.capture({ id: item.id, ownerId: "local-owner", workspaceId, title: item.title, context: item.context }, `corpus:${item.id}`);
}

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-automation-stripper"]
  }
});

const failures: string[] = [];
try {
  console.info(JSON.stringify({ status: "cost_signal", signal: await supervisor.readCostSignal() }));
  const analyze = createCaptureAnalyzer(store, repoRoot);
  for (const item of cases) {
    const outcome = await analyze(supervisor.client, item.id);
    const hasAudit = Boolean(outcome.audit?.threadId && outcome.audit?.turnId);
    const passed = outcome.state === item.expected && hasAudit;
    if (!passed) failures.push(item.id);
    console.info(JSON.stringify({
      case: item.id,
      expected: item.expected,
      state: outcome.state,
      attempt: outcome.attempt,
      audited: hasAudit,
      blocker: outcome.audit?.blocker?.code ?? null
    }));
  }
} finally {
  await supervisor.stop();
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "corpus_failed" : "corpus_passed", failures, dataDir }));
process.exitCode = failures.length ? 1 : 0;
