/**
 * The skill library's acceptance run (docs/skills-library.md), on a **copy** of the real ledger (the live database is only read, through
 * SQLite's online backup) with the real Codex:
 *
 *   compile    the media line's own skill (`crossline-mine:media`) from the person's materials — the first rule is the note the person
 *              left on the assistant's first Xiaohongshu outline (agent-97846949-1, 2026-10-14);
 *   assistant  a small media task run by the assistant, showing the line skill switched on beside `crossline-agent`;
 *   gate       the real first outline (written as a cautious research report) judged against a contract it covers: the gate must answer
 *              `partial`, naming the broken rule.
 *
 *   pnpm exec tsx scripts/skills-library-demo.ts [compile|assistant|gate|all]   (default: all)
 *
 * The runtime is the machine's own Codex home, shared with the resident worker: installing this checkout's plugin there replaces the
 * resident runtime's copy, so set `CROSSLINE_RESTORE_MARKETPLACE` to the resident checkout's `marketplace.json` and the script installs it
 * back at the end, and removes the demo's `crossline-mine` plugin. Nothing reaches the live ledger. It spends real quota; never run as a side effect.
 */
import { register } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const liveLedger = process.env.CROSSLINE_LIVE_LEDGER ?? path.join(repoRoot, "data", "crossline.db");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-skills-demo-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(liveLedger, { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;

const { CrosslineStore } = await import("../packages/db/src/index");
const { currentMineVersion, mineSkillSettingKey, readMineSkill } = await import("../packages/core/src/index");
const { setUsageSink, startCodexSupervisor } = await import("../packages/codex/src/index");
const { createInsightCompiler, INSIGHT_COMPILER, mineMaterials } = await import("../apps/worker/src/insight-compiler");
const { createAgentRunner, AGENT_SKILL } = await import("../apps/worker/src/agent-task");
const { createMilestoneGate, MILESTONE_GATE_SKILL } = await import("../apps/worker/src/milestone-gate-runner");

const step = process.argv[2] ?? "all";
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const NOTE_TASK = "agent-97846949-1";
const workspace = store.listWorkspaces().find((item) => store.listEvents(item.id, { type: "agent.task.reviewed", entityId: NOTE_TASK }).length)
  ?? store.listWorkspaces()[0]!;
const ws = workspace.id;
const line = "media";
const libraryDir = path.join(dataDir, "skill-library");
const runs: Array<{ skill: string; seconds: number; repairs: number; ok: boolean }> = [];
setUsageSink((usage) => { runs.push({ skill: usage.skillName, seconds: Math.round(usage.durationMs / 1000), repairs: usage.repairs, ok: usage.ok }); });

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: [INSIGHT_COMPILER, AGENT_SKILL, MILESTONE_GATE_SKILL] }
});
const client = () => supervisor.client;
const heading = (text: string) => console.info(`\n== ${text}`);

try {
  if (step === "compile" || step === "all") {
    heading(`「${line}」主线的材料（${mineMaterials(store, ws, line).length} 条，非访谈事实如下）`);
    for (const material of mineMaterials(store, ws, line).filter((item) => item.kind !== "fact")) console.info(JSON.stringify({ id: material.id, kind: material.kind, label: material.label, text: material.text.slice(0, 200) }));
    const started = Date.now();
    const outcome = await createInsightCompiler(store, ws, repoRoot, client)(line);
    heading(`整理结果（${Math.round((Date.now() - started) / 1000)} 秒）：${JSON.stringify(outcome)}`);
    const version = currentMineVersion(readMineSkill(store.getSetting(ws, mineSkillSettingKey(line))));
    console.info(version?.markdown ?? "（没有写成）");
    console.info(JSON.stringify(store.listEvents(ws, { type: "skill.mine.rewritten" }).map((event) => event.payload)));
  }

  if (step === "assistant" || step === "all") {
    const order = store.listWorkOrders(ws).find((item) => item.id === "0219e5b6-5753-46c9-8a92-1c3897846949")
      ?? store.listWorkOrders(ws).find((item) => item.identityId === line)!;
    const outputRoot = path.join(dataDir, "ai-output");
    const run = createAgentRunner(store, ws, repoRoot, client, { outputRoot, libraryDir, ask: async () => false });
    heading(`助手运行：任务挂在「${order.intent}」（${order.identityId}）下`);
    const outcome = await run({ taskId: `demo-mine-${Date.now()}`, workOrderId: order.id, category: "read_research_organize",
      title: "小红书第二篇笔记：标题与开头", humanPart: "选定标题、拍摄与发布",
      what: "为小红书第二篇笔记（主题：科研如何实际发生）写 3 个标题备选和开头 5 句，存为 opening.md。" });
    const completed = store.listEvents(ws, { type: "agent.task.completed" }).at(-1);
    console.info(JSON.stringify({ state: outcome.state, skills: (completed?.payload as { skills?: string[] } | undefined)?.skills ?? [],
      ...(outcome.state === "done" ? { artifacts: outcome.artifacts.map((item) => item.path), summary: outcome.summary.summary } : outcome) }, null, 1));
    if (outcome.state === "done") {
      const opening = path.join(outcome.directory, "opening.md");
      if (existsSync(opening)) console.info(readFileSync(opening, "utf8").slice(0, 2000));
    }
  }

  if (step === "gate" || step === "all") {
    const outline = path.join(process.env.USERPROFILE ?? "", "Crossline", "ai-output", NOTE_TASK, "首篇笔记提纲与来源.md");
    const evidence = path.join(dataDir, "首篇笔记提纲与来源.md");
    copyFileSync(outline, evidence);
    const milestone = store.listMilestones(ws).find((item) => item.identityId === line && item.status === "approved")!;
    const owner = store.getWorkspaceOwnerId(ws)!;
    const estimate = { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
    store.saveWorkOrder({ id: "demo-gate-outline", ownerId: owner, workspaceId: ws, identityId: line, projectId: "", milestoneId: milestone.id,
      intent: "小红书首篇笔记提纲（演示：用真实的第一版提纲送验收）", state: "ready_for_human", riskTier: "milestone", estimate,
      payload: { evidenceContract: [{ kind: "record", description: "首篇笔记的提纲，含叙事主线、分页文案骨架与 3 个公开来源", why: "本任务的交付物", required: true }] } });
    store.transitionWorkOrder(ws, "demo-gate-outline", { type: "human.started" }, "demo:start");
    store.transitionWorkOrder(ws, "demo-gate-outline", { type: "human.completed" }, "demo:done",
      { evidence: [{ kind: "file", uri: pathToFileURL(evidence).href, description: "首篇笔记提纲与来源.md" }] });
    heading(`验收：真实的第一版提纲，挂在「${milestone.title}」下`);
    const outcome = await createMilestoneGate(store, ws, repoRoot, client)("demo-gate-outline");
    const review = (store.listWorkOrders(ws).find((item) => item.id === "demo-gate-outline")!.payload as { gateReview?: unknown }).gateReview as
      { verdict: string; contractCoverage: unknown; fit?: unknown } | undefined;
    console.info(JSON.stringify({ outcome, verdict: review?.verdict, contractCoverage: review?.contractCoverage, fit: review?.fit }, null, 1));
  }
  heading(`运行：${JSON.stringify(runs)}`);
} finally {
  const restore = process.env.CROSSLINE_RESTORE_MARKETPLACE;
  if (restore) {
    await supervisor.client.request("plugin/install", { marketplacePath: restore, pluginName: "crossline" }).catch((error) => console.warn("restore failed", error));
    console.info(`已用 ${restore} 恢复常驻运行时的 crossline 插件。`);
  }
  await supervisor.client.request("plugin/uninstall", { pluginId: "crossline-mine@crossline-library" }).catch(() => undefined);
  store.close();
  await supervisor.stop();
  console.info(`账本副本：${dataDir}`);
}
