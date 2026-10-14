/**
 * Grows one workflow on a **copy** of the real ledger (docs/skills-library.md §6), with the real Codex: the live database is only read,
 * through SQLite's online backup.
 *
 *   pnpm exec tsx scripts/workflow-grow-demo.ts                 the first errand the ledger shows repeated (two accepted results alike)
 *   pnpm exec tsx scripts/workflow-grow-demo.ts "以后……"        a request in the person's words (`workflow.request`)
 *
 * It runs the assistant with the runtime's own `skill-creator`, reads back what it wrote, checks the manifest, scans and reviews it,
 * installs it, prints what the person is told, and then shows a later task of the same kind switching the workflow on.
 *
 * The runtime is the machine's own Codex home, shared with the resident worker: set `CROSSLINE_RESTORE_MARKETPLACE` to the resident
 * checkout's `marketplace.json` and the script installs it back at the end, and removes the library plugins it installed. It spends real
 * quota (one assistant run and one review); never run as a side effect.
 */
import { register } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const liveLedger = process.env.CROSSLINE_LIVE_LEDGER ?? path.join(repoRoot, "data", "crossline.db");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-grow-demo-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(liveLedger, { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;

const { CrosslineStore, aiToolsFor, approveCategory, listAgentTasks, readCategories, readGrownSkills, requestWorkflow } = await import("../packages/db/src/index");
const { currentMineVersion, grownSkillFilesKey, mineSkillSettingKey, readMineSkill } = await import("../packages/core/src/index");
const { createInsightCompiler, INSIGHT_COMPILER } = await import("../apps/worker/src/insight-compiler");
const { setUsageSink, startCodexSupervisor } = await import("../packages/codex/src/index");
const { createAgentRunner, AGENT_SKILL } = await import("../apps/worker/src/agent-task");
const { growCandidates, growTask, installGrown, SKILL_CREATOR } = await import("../apps/worker/src/workflow-smith");
const { librarySkillsFor } = await import("../apps/worker/src/skill-library");
const { identityLines } = await import("../apps/worker/src/lines");

const request = process.argv[2];
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const workspace = store.listWorkspaces().find((item) => listAgentTasks(store, item.id).length) ?? store.listWorkspaces()[0]!;
const ws = workspace.id;
const heading = (text: string) => console.info(`\n== ${text}`);
const runs: Array<{ skill: string; seconds: number; repairs: number; ok: boolean }> = [];
setUsageSink((usage) => { runs.push({ skill: usage.skillName, seconds: Math.round(usage.durationMs / 1000), repairs: usage.repairs, ok: usage.ok }); });

if (request) requestWorkflow(store, ws, request, "", store.getWorkspaceOwnerId(ws)!);
const candidates = growCandidates(store, ws);
const candidate = request ? candidates.find((item) => item.origin.kind === "asked") : candidates.find((item) => item.origin.kind === "repeated");
if (!candidate) { console.error("账本副本里没有可生长的事项。"); process.exit(1); }
heading(`候选：${candidate.origin.kind === "asked" ? "本人的要求" : `${candidate.origin.taskIds.length} 次采纳的同类结果`}（主线 ${candidate.lineId}，类别 ${candidate.category}）`);
console.info(candidate.text.slice(0, 400));
// The kind of work must be one the person allowed; on this copy only, a kind not yet allowed is allowed for the demo.
if (!readCategories(store, ws)[candidate.category]) { approveCategory(store, ws, candidate.category); console.info(`（副本中临时允许「${candidate.category}」）`); }
const tools = aiToolsFor(store, ws);
heading(`本人可用的 AI 工具：${tools.map((tool) => tool.name).join("、")}`);

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: [AGENT_SKILL, "crossline:crossline-validation-reviewer", INSIGHT_COMPILER] }
});
const libraryDir = path.join(dataDir, "skill-library");
try {
  // The workflow is written the person's way: the line's own skill (their plays) is compiled first when the copy has none.
  if (!currentMineVersion(readMineSkill(store.getSetting(ws, mineSkillSettingKey(candidate.lineId))))) {
    const compiled = await createInsightCompiler(store, ws, repoRoot, () => supervisor.client)(candidate.lineId);
    heading(`先整理「${candidate.lineId}」主线的本人打法：${JSON.stringify(compiled)}`);
  }
  const input = growTask(candidate, identityLines(store, ws).map((line) => line.id), tools);
  heading(`生长任务（助手，带 $${SKILL_CREATOR}）：${input.title}`);
  const started = Date.now();
  const outcome = await createAgentRunner(store, ws, repoRoot, () => supervisor.client, { outputRoot: path.join(dataDir, "ai-output"), libraryDir, ask: async () => false })(input);
  const completed = store.listEvents(ws, { type: "agent.task.completed", entityId: input.taskId }).at(-1);
  console.info(JSON.stringify({ state: outcome.state, seconds: Math.round((Date.now() - started) / 1000),
    skillsOn: (completed?.payload as { skills?: string[] } | undefined)?.skills ?? [], ...(outcome.state === "done" ? { directory: outcome.directory } : outcome) }, null, 1));
  if (outcome.state === "done") {
    const skillDir = path.join(outcome.directory, "skill");
    const list = (dir: string, prefix = ""): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? list(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]) : [];
    heading(`写出的工作流文件：${list(skillDir).join("、")}`);
  }

  heading("读回、检查、扫描、审查、安装");
  const installed = await installGrown(store, ws, candidate, outcome, { client: supervisor.client, cwd: repoRoot });
  console.info(JSON.stringify(installed));
  const record = readGrownSkills(store, ws).at(-1);
  if (installed.state === "installed" && record) {
    console.info(JSON.stringify({ id: record.id, summary: record.manifest.summary, trigger: record.manifest.trigger, schedule: record.manifest.schedule,
      steps: record.manifest.steps, scan: { risk: record.scan.risk, injection: record.scan.injection, findings: record.scan.findings.length },
      review: record.review, files: record.files }, null, 1));
    const files = JSON.parse(store.getSetting(ws, grownSkillFilesKey(record.id)) ?? "{}") as { files?: Array<{ path: string; text: string }> };
    heading("SKILL.md");
    console.info(files.files?.find((file) => file.path === "SKILL.md")?.text ?? "");
    heading("对本人说的话");
    const said = store.listRecentNudges(ws, new Date(Date.now() - 3_600_000).toISOString()).at(-1);
    console.info((said?.payload.card as { clarify?: { question?: string } } | undefined)?.clarify?.question ?? "（无）");
    heading("之后同类任务启用它");
    const chosen = await librarySkillsFor(supervisor.client, store, ws, candidate.lineId, { cwd: repoRoot, dir: libraryDir, task: candidate.text.split("；")[0] ?? candidate.text });
    console.info(JSON.stringify(chosen));
  } else {
    const reading = path.join(path.join(dataDir, "ai-output"), input.taskId, "skill", "workflow.json");
    if (existsSync(reading)) console.info(readFileSync(reading, "utf8").slice(0, 2000));
  }
  heading(`运行：${JSON.stringify(runs)}`);
} finally {
  const restore = process.env.CROSSLINE_RESTORE_MARKETPLACE;
  if (restore) {
    await supervisor.client.request("plugin/install", { marketplacePath: restore, pluginName: "crossline" }).catch((error) => console.warn("restore failed", error));
    console.info(`已用 ${restore} 恢复常驻运行时的 crossline 插件。`);
  }
  for (const plugin of ["crossline-mine", "crossline-grown", "crossline-public"]) {
    await supervisor.client.request("plugin/uninstall", { pluginId: `${plugin}@crossline-library` }).catch(() => undefined);
  }
  store.close();
  await supervisor.stop();
  console.info(`账本副本：${dataDir}`);
}
