/**
 * Structured-output evidence: how reliably the real Codex runtime returns what each Skill's schema and validator ask for.
 *
 *   pnpm exec tsx scripts/structured-output-check.ts [runs-per-case]
 *
 * It spends real quota (about a dozen model runs) on a throwaway database, so it is never run as a side effect. For every run it
 * records what the usage sink saw — repairs (how many times the validator sent the answer back), turns, tokens, duration and the
 * blocker code if it failed — and prints one table at the end. The raw answers, rejected ones included, are written to a
 * temp directory (`CROSSLINE_RECORD_DIR`) so a failure can be replayed as a fixture.
 *
 * Read the table, not just the exit code: a Skill that passes every time but needs a repair every time has a schema or prompt
 * problem that retries are hiding.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setUsageSink, startCodexSupervisor, type SkillUsage } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createCaptureAnalyzer } from "../apps/worker/src/analysis";
import { createBackgroundFactsExtractor } from "../apps/worker/src/background-facts-runner";
import { createMilestoneProposer } from "../apps/worker/src/milestone-proposer";
import { createOnboardingSessionRunner } from "../apps/worker/src/onboarding-session";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-structured-"));
process.env.CROSSLINE_RECORD_DIR = path.join(dataDir, "answers");
const runsPerCase = Math.max(1, Number(process.argv[2]) || 1);

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const { workspace, principal } = store.createPrincipalWithWorkspace("structured-output-check", "check");
const workspaceId = workspace.id;
store.saveMilestone({ id: "check-milestone", ownerId: principal.id, workspaceId, identityId: "research", projectId: "check", title: "检查用里程碑", version: 1, status: "approved" });

type Row = { skill: string; label: string; outcome: string; usage: SkillUsage[] };
const rows: Row[] = [];
let sink: SkillUsage[] = [];
setUsageSink((usage) => { sink.push(usage); });
async function trial(skill: string, label: string, run: () => Promise<string>): Promise<void> {
  sink = [];
  const started = Date.now();
  let outcome: string;
  try { outcome = await run(); } catch (error) { outcome = `threw:${error instanceof Error ? error.message.slice(0, 80) : "?"}`; }
  rows.push({ skill, label, outcome, usage: sink.map((item) => ({ ...item, durationMs: item.durationMs || Date.now() - started })) });
  const last = rows[rows.length - 1]!;
  console.info(JSON.stringify({ step: `${skill}:${label}`, outcome, repairs: last.usage.reduce((sum, item) => sum + item.repairs, 0), seconds: Math.round((Date.now() - started) / 1000) }));
}

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-onboarding", "crossline:crossline-automation-stripper", "crossline:crossline-background-facts", "crossline:crossline-milestone-architect"]
  }
});
const getClient = () => supervisor.client;

try {
  // 1. The interview: the largest and most grounded output, in three situations.
  const interview = createOnboardingSessionRunner(store, workspaceId, repoRoot, getClient, { extract: "await" });
  const outcomeOf = (result: { state: string } & { code?: string }) => result.state === "blocked" ? `blocked:${result.code}` : result.state;
  for (let i = 0; i < runsPerCase; i += 1) {
    await trial("onboarding", `rich-first-message#${i}`, async () => outcomeOf(await interview({ sessionId: `rich-${i}`, text:
      "我是 UW-Madison ECE 的博士生，导师是 Akhilesh Jaiswal，做 neuromorphic computing 的硬件软件协同设计。现在有两个项目：A 是和西湖合作的，10/31 前必须投出，我负责 NeuroSim 仿真和算法，数据 10/8 左右到；B 是在 Wisc 练手的，要先熟悉 Cadence 并画一个 6T SRAM。另外在想做一个创业项目，首批 10-30 个试用者，11 月底前要有能自己用的 MVP。" })));
    await trial("onboarding", `follow-up#${i}`, async () => outcomeOf(await interview({ sessionId: `rich-${i}`, text: "项目 A 的图表清单已经明确，主要卡点是数据没到；合作人是西湖的一位师兄，我每周能投入大约 25 小时。" })));
    await trial("onboarding", `vague#${i}`, async () => outcomeOf(await interview({ sessionId: `vague-${i}`, text: "我什么都想做，但不知道从哪开始。" })));
  }

  // 2. Capture analysis: a concrete task, a vague one and a bare link.
  const analyze = createCaptureAnalyzer(store, workspaceId, repoRoot);
  const captures = [
    ["concrete", "写一段 200 字的研究方向说明，用于下周组会自我介绍", "内容凭自己的判断写"],
    ["vague", "整理一下", ""],
    ["link-only", "https://arxiv.org/abs/1706.03762", "看看这篇"]
  ] as const;
  for (let i = 0; i < runsPerCase; i += 1) for (const [label, title, context] of captures) {
    const id = `cap-${label}-${i}`;
    store.capture({ id, ownerId: principal.id, workspaceId, title, context }, `check:${id}`);
    await trial("analysis", label, async () => {
      const result = await analyze(supervisor.client, id) as { state: string; audit?: { blocker?: { code: string } } };
      return result.state === "blocked" ? `blocked:${result.audit?.blocker?.code}` : result.state;
    });
  }

  // 3. Background facts: a small, frequent Skill.
  const facts = createBackgroundFactsExtractor(store, workspaceId, repoRoot, getClient);
  for (let i = 0; i < runsPerCase; i += 1) {
    await trial("background-facts", "grant", async () => outcomeOf(await facts("申请 NSF 的博士生基金", "我是国际学生，F-1，截止日期 12 月中")));
    await trial("background-facts", "nothing-to-learn", async () => outcomeOf(await facts("买牛奶", "")));
  }

  // 4. Milestone proposal from the profile the interview just built.
  const propose = createMilestoneProposer(store, workspaceId, repoRoot, getClient);
  await trial("milestone-architect", "from-profile", async () => outcomeOf(await propose("根据我的情况给出里程碑")));
} finally {
  setUsageSink(undefined);
  await supervisor.stop();
  store.close();
}

const keys = [...new Set(rows.map((row) => `${row.skill} / ${row.label.replace(/#\d+$/, "")}`))];
const table = keys.map((key) => {
  const group = rows.filter((row) => `${row.skill} / ${row.label.replace(/#\d+$/, "")}` === key);
  const usage = group.flatMap((row) => row.usage);
  const good = group.filter((row) => !row.outcome.startsWith("blocked") && !row.outcome.startsWith("threw")).length;
  return {
    case: key, runs: group.length, passed: good, repairs: usage.reduce((sum, item) => sum + item.repairs, 0),
    turns: usage.reduce((sum, item) => sum + item.turns, 0), outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
    seconds: Math.round(usage.reduce((sum, item) => sum + item.durationMs, 0) / 1000),
    outcomes: [...new Set(group.map((row) => row.outcome))].join(",")
  };
});
console.info(JSON.stringify({ status: "structured_output_table", answersDir: process.env.CROSSLINE_RECORD_DIR }, null, 1));
console.table(table);
process.exitCode = table.some((row) => row.passed === 0) ? 1 : 0;
