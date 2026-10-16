/**
 * Domestic-model evaluation matrix (docs/beta-launch.md §10.4): for each model connection in a config file, the same four questions
 * the hosted version depends on, through the same path the worker uses (model gateway → Codex app-server → Skill → validators), on a
 * throwaway ledger:
 *
 *   conformance  every exported Skill schema and the adversarial cases (`provider-conformance.ts`'s gate, including what it would admit)
 *   web          three questions with checkable answers, answered with Crossline's `web_search`/`web_fetch` stand-ins; scored on the
 *                answer, on every cited page having been fetched in the run, and on each quote being found in that page
 *   agent        the real assistant (`createAgentRunner`) on a small data task in a throwaway folder: done, checks passed, the numbers
 *                right in its summary
 *   images       each image model in `images[]` draws the portrait figure from the fictional fixture report, saved for a person to judge
 *
 * Interview quality is measured separately, per model, by `onboarding-eval.ts --provider <config>:<id>` (hours of quota each).
 *
 *   pnpm exec tsx scripts/provider-matrix.ts <config.json> [--only id1,id2] [--stages conformance,web,agent,images]
 *
 * Copy `scripts/provider-matrix.example.json`, fill in what was bought; keys come from the environment variables it names.
 * `PROBE_CASES=A,B` narrows the conformance stage to those cases (a smoke test). Writes `data/eval/provider-matrix-<time>.{md,json}`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { admittedSkills, characterPrompt, conformanceCases, jsonSchemaProblems, SKILL_NEEDS, THIRD_PARTY_CAPABILITIES, type PortraitReport } from "../packages/core/src/index";
import { enterUsageWorkspace, runCodexSkill, setUsageSink, startCodexAppServer, startCodexSupervisor, threadProvider, type SkillTools } from "../packages/codex/src/index";
import { imageBackend, webSearchFromEnv } from "../packages/connectors/src/index";
import { approveCategory, CrosslineStore } from "../packages/db/src/index";
import { createAgentRunner } from "../apps/worker/src/agent-task";
import { createWebTools } from "../apps/worker/src/web-tools";
import { costOf, readMatrixConfig, startProviderHarness, type ProviderSpec } from "./provider-harness";

const args = process.argv.slice(2);
const configFile = args.find((arg) => arg.endsWith(".json"));
if (!configFile) { console.error("usage: provider-matrix.ts <config.json> [--only id1,id2] [--stages conformance,web,agent,images]"); process.exit(2); }
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1]?.split(",").map((item) => item.trim()).filter(Boolean) : undefined; };
const only = flag("--only");
const stages = new Set(flag("--stages") ?? ["conformance", "web", "agent", "images"]);
const config = readMatrixConfig(configFile);
const providers = config.providers.filter((spec) => !only?.length || only.includes(spec.id));

const repoRoot = path.resolve(import.meta.dirname, "..");
process.env.CROSSLINE_CODEX_PATH ??= path.resolve(repoRoot, "../../../vendor/codex/codex-rs/target/debug/codex.exe");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-matrix-"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(repoRoot, "data", "eval");
mkdirSync(outDir, { recursive: true });

const tokens = new Map<string, { inputTokens: number; cachedInputTokens: number; outputTokens: number }>();
setUsageSink((usage) => {
  if (!usage.workspaceId) return;
  const row = tokens.get(usage.workspaceId) ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  row.inputTokens += usage.inputTokens ?? 0; row.cachedInputTokens += usage.cachedInputTokens ?? 0; row.outputTokens += usage.outputTokens ?? 0;
  tokens.set(usage.workspaceId, row);
});

const supervisor = await startCodexSupervisor({ port: 3390 + Math.floor(Math.random() * 9), sidecarFactory: () => startCodexAppServer(path.join(dataDir, "codex-home")),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot, requiredSkills: ["crossline:crossline-conformance", "crossline:crossline-agent"] } });
const harness = await startProviderHarness(store, supervisor.client, repoRoot);
const search = webSearchFromEnv();
if (stages.has("web") && !search) console.warn(JSON.stringify({ step: "warn", message: "no search API (BOCHA_API_KEY / TAVILY_API_KEY): web stage skipped" }));

// ── Stage: web ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const WEB_SCHEMA = { type: "object", additionalProperties: false, required: ["answer", "sources"], properties: {
  answer: { type: "string", minLength: 1, maxLength: 400 },
  sources: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["url", "quote"], properties: {
    url: { type: "string", minLength: 8, maxLength: 500 }, quote: { type: "string", minLength: 4, maxLength: 300 } } } } } };
const WEB_QUESTIONS = [
  { id: "sqlite-autocheckpoint", prompt: "联网核实测试：SQLite 的 WAL 自动检查点（wal_autocheckpoint）默认是多少页？在官方文档里查证。", expect: /1000/ },
  { id: "highs-origin", prompt: "联网核实测试：开源线性规划求解器 HiGHS 最初是在哪所大学开发的？", expect: /Edinburgh|爱丁堡/i },
  { id: "python-313", prompt: "联网核实测试：Python 3.13.0 正式版是哪一天发布的？", expect: /2024-10-07|2024\s*年\s*10\s*月\s*7\s*日|October 7,? 2024|7 October 2024/i }
];
const squash = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const sameUrl = (a: string, b: string) => a.replace(/[#?].*$/, "").replace(/\/+$/, "") === b.replace(/[#?].*$/, "").replace(/\/+$/, "");

async function webStage(workspaceId: string, spec: ProviderSpec) {
  const results: Array<{ id: string; ok: boolean; correct: boolean; cited: number; fetchedCited: number; quotesFound: number; searches: number; ms: number; code?: string }> = [];
  const routing = harness.service.routing(workspaceId);
  if (!routing || !search) return results;
  for (const question of WEB_QUESTIONS) {
    const tools = createWebTools(search);
    const pages = new Map<string, string>();
    const watched: SkillTools = { specs: tools.specs, call: async (name, input) => {
      const out = await tools.call(name, input);
      if (name === "web_fetch") { const page = JSON.parse(out) as { url: string; text: string }; pages.set(page.url, page.text); }
      return out;
    } };
    const started = Date.now();
    const input = { version: "crossline.conformance.v1", caseId: `WEB_${question.id}`, prompt: question.prompt };
    const result = await runCodexSkill<{ answer: string; sources: Array<{ url: string; quote: string }> }>(supervisor.client, input, {
      skillName: "crossline:crossline-conformance", cwd: repoRoot, provider: threadProvider(routing, spec.model), webTools: watched, allowWebSearch: true,
      developerInstructions: "Answer the conformance case as the Skill describes. Return raw JSON only.", outputSchema: WEB_SCHEMA,
      prepareInput: () => input, onAudit: () => {}, timeoutMs: 20 * 60_000,
      validateOutput: (output) => {
        const problems = jsonSchemaProblems(output, WEB_SCHEMA);
        if (problems.length) throw Object.assign(new Error("CONFORMANCE_SCHEMA_VIOLATED"), { detail: problems.slice(0, 6).join("; ") });
        return output as { answer: string; sources: Array<{ url: string; quote: string }> };
      } });
    const used = tools.used();
    if (!result.ok) { results.push({ id: question.id, ok: false, correct: false, cited: 0, fetchedCited: 0, quotesFound: 0, searches: used.searches, ms: Date.now() - started, code: result.blocker.code }); continue; }
    const sources = result.output.sources;
    const fetchedCited = sources.filter((source) => [...pages.keys()].some((url) => sameUrl(url, source.url))).length;
    const quotesFound = sources.filter((source) => {
      const page = [...pages.entries()].find(([url]) => sameUrl(url, source.url))?.[1];
      return page !== undefined && squash(page).includes(squash(source.quote));
    }).length;
    results.push({ id: question.id, ok: true, correct: question.expect.test(result.output.answer), cited: sources.length, fetchedCited, quotesFound,
      searches: used.searches, ms: Date.now() - started });
  }
  return results;
}

// ── Stage: agent ───────────────────────────────────────────────────────────────────────────────────────────────────────

const SCORES = [["学生", "作业1", "作业2", "作业3"], ["甲", "88", "92", "79"], ["乙", "75", "81", "90"], ["丙", "95", "87", "91"], ["丁", "60", "72", "68"]];
const classAverage = (() => { const all = SCORES.slice(1).flatMap((row) => row.slice(1).map(Number)); return all.reduce((a, b) => a + b, 0) / all.length; })();

async function agentStage(workspaceId: string) {
  const folder = mkdtempSync(path.join(dataDir, "agent-input-"));
  const csv = path.join(folder, "scores.csv");
  writeFileSync(csv, SCORES.map((row) => row.join(",")).join("\n"), "utf8");
  approveCategory(store, workspaceId, "data_code_sim");
  harness.force(workspaceId);
  const started = Date.now();
  const run = createAgentRunner(store, workspaceId, repoRoot, () => supervisor.client, { outputRoot: path.join(dataDir, "agent-output", workspaceId), ask: async () => false });
  const outcome = await run({ title: "整理作业成绩", category: "data_code_sim", inputs: [csv], humanPart: "本人只看结论。",
    what: "读 scores.csv（每行一名学生的三次作业分数），算出每人平均分和全班平均分（保留一位小数），写 summary.md：一张表加两句结论。"
      + "本机有 Python 和 matplotlib 时再画 chart.png（每人平均分的柱状图），没有就在 summary.md 里说明跳过。" });
  const ms = Date.now() - started;
  if (outcome.state !== "done") return { ok: false, ms, code: outcome.state === "blocked" ? outcome.code : outcome.state };
  const summaryFile = outcome.artifacts.find((artifact) => /summary\.md$/i.test(artifact.path));
  const summary = summaryFile ? (() => { try { return readFileSync(path.resolve(outcome.directory, summaryFile.path), "utf8"); } catch { return ""; } })() : "";
  return { ok: true, ms, checksPassed: outcome.checksPassed, artifacts: outcome.artifacts.length, commands: outcome.audit.commands.length,
    numbersRight: summary.includes(classAverage.toFixed(1)), chart: outcome.artifacts.some((artifact) => /chart\.png$/i.test(artifact.path)) };
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = { spec: ProviderSpec; conformance?: { passRate: number; repairRate: number; p95Ms: number; admitted: string[]; criticalOk: boolean; failures: Array<{ case: string; code: string }> };
  web?: Awaited<ReturnType<typeof webStage>>; agent?: Awaited<ReturnType<typeof agentStage>>; tokens?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  cost?: number; error?: string };
const rows: Row[] = [];
for (const spec of providers) {
  const row: Row = { spec };
  rows.push(row);
  const { workspace } = store.createPrincipalWithWorkspace(`matrix-${spec.id}`, spec.id);
  enterUsageWorkspace(workspace.id);
  console.info(JSON.stringify({ step: "provider", id: spec.id, model: spec.model }));
  try {
    await harness.add(workspace.id, spec);
    if (stages.has("conformance")) {
      const cases = conformanceCases().filter((item) => !process.env.PROBE_CASES || process.env.PROBE_CASES.split(",").includes(item.id));
      const record = await harness.service.runConformance(workspace.id, cases);
      if ("blocked" in record) throw new Error(record.blocked);
      const capabilities = { ...THIRD_PARTY_CAPABILITIES, webSearch: Boolean(search) };
      const admitted = admittedSkills(record, capabilities);
      const critical = Object.entries(SKILL_NEEDS).filter(([, needs]) => needs.critical).map(([skill]) => skill);
      row.conformance = { passRate: record.passRate, repairRate: record.repairRate, p95Ms: record.p95Ms, admitted, failures: record.failures,
        criticalOk: critical.every((skill) => admitted.includes(skill)) };
      console.info(JSON.stringify({ step: "conformance", id: spec.id, passRate: record.passRate, admitted: admitted.length }));
    }
    if (stages.has("web") && search) { row.web = await webStage(workspace.id, spec); console.info(JSON.stringify({ step: "web", id: spec.id, results: row.web })); }
    if (stages.has("agent")) { row.agent = await agentStage(workspace.id); console.info(JSON.stringify({ step: "agent", id: spec.id, result: row.agent })); }
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); console.error(JSON.stringify({ step: "error", id: spec.id, error: row.error })); }
  const used = tokens.get(workspace.id);
  if (used) { row.tokens = used; const cost = costOf(used, spec.price); if (cost !== undefined) row.cost = cost; }
}

const images: Array<{ id: string; model: string; ok: boolean; ms: number; file?: string; error?: string }> = [];
if (stages.has("images") && config.images?.length) {
  const fixture = JSON.parse(readFileSync(path.join(repoRoot, "e2e", "fixtures", "portrait-report.json"), "utf8")) as PortraitReport;
  const prompt = characterPrompt(fixture);
  const imageDir = path.join(outDir, `provider-matrix-${stamp}-images`);
  mkdirSync(imageDir, { recursive: true });
  for (const spec of config.images) {
    const key = process.env[spec.keyEnv]?.trim();
    const started = Date.now();
    if (!key || !prompt) { images.push({ id: spec.id, model: spec.model, ok: false, ms: 0, error: key ? "no prompt" : `${spec.keyEnv} not set` }); continue; }
    try {
      const backend = imageBackend({ apiKey: key, baseUrl: spec.baseUrl, model: spec.model, size: spec.size ?? "1024x1024",
        style: spec.style ?? (/siliconflow/i.test(spec.baseUrl) ? "siliconflow" : "openai") });
      const bytes = await backend.generate(prompt, { seed: 42 });
      const file = path.join(imageDir, `${spec.id}.png`);
      writeFileSync(file, bytes);
      images.push({ id: spec.id, model: spec.model, ok: true, ms: Date.now() - started, file });
    } catch (error) { images.push({ id: spec.id, model: spec.model, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : "failed" }); }
  }
}

await harness.close();
await supervisor.stop();

const pct = (value: number) => `${Math.round(value * 100)}%`;
const lines = [`# 模型评测矩阵 ${stamp}`, "", `配置：${path.basename(configFile)} · 阶段：${[...stages].join("、")} · 搜索：${search?.id ?? "未配置"}`, "",
  "| 模型 | schema 通过 | 修正率 | p95 秒 | 收集分析/验收判定 | 可承担功能数 | 联网答对 | 引用已打开 | 引文属实 | 助手 | 助手算对 | tokens 入/出 | 估算花费 |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
for (const row of rows) {
  const c = row.conformance; const web = row.web ?? []; const agent = row.agent;
  const cited = web.reduce((sum, item) => sum + item.cited, 0);
  lines.push(`| ${row.spec.label} (${row.spec.model}) | ${c ? pct(c.passRate) : "—"} | ${c ? pct(c.repairRate) : "—"} | ${c ? Math.round(c.p95Ms / 1000) : "—"} | ${c ? (c.criticalOk ? "通过" : "未通过") : "—"} | ${c ? c.admitted.length : "—"} `
    + `| ${web.length ? `${web.filter((item) => item.correct).length}/${web.length}` : "—"} | ${cited ? `${web.reduce((sum, item) => sum + item.fetchedCited, 0)}/${cited}` : "—"} | ${cited ? `${web.reduce((sum, item) => sum + item.quotesFound, 0)}/${cited}` : "—"} `
    + `| ${agent ? (agent.ok ? (agent.checksPassed ? "完成" : "完成·检查未过") : `失败 ${agent.code}`) : "—"} | ${agent && agent.ok ? (agent.numbersRight ? "是" : "否") : "—"} `
    + `| ${row.tokens ? `${Math.round(row.tokens.inputTokens / 1000)}k/${Math.round(row.tokens.outputTokens / 1000)}k` : "—"} | ${row.cost !== undefined ? `${row.cost.toFixed(2)} ${row.spec.price?.currency}` : "—"} |`);
  if (row.error) lines.push(`|  ↳ 出错：${row.error.slice(0, 200)} |||||||||||||`);
}
if (images.length) {
  lines.push("", "## 画像插图", "", "| 画图模型 | 结果 | 秒 | 文件 |", "|---|---|---|---|");
  for (const image of images) lines.push(`| ${image.id} (${image.model}) | ${image.ok ? "成功" : `失败：${image.error}`} | ${Math.round(image.ms / 1000)} | ${image.file ? path.relative(repoRoot, image.file) : ""} |`);
}
lines.push("", "判读：收集分析和验收判定要求每次一次答对；其余功能要求全部 schema 通过率 ≥90%。联网三项都满分才算可用。画像图要本人看图判断像不像 MBTI 测评形象的风格。",
  "访谈质量另跑：`pnpm exec tsx scripts/onboarding-eval.ts --provider <config>:<id>`。");
const mdFile = path.join(outDir, `provider-matrix-${stamp}.md`);
writeFileSync(mdFile, `${lines.join("\n")}\n`, "utf8");
writeFileSync(path.join(outDir, `provider-matrix-${stamp}.json`), JSON.stringify({ config: path.basename(configFile), stages: [...stages], rows, images }, null, 2), "utf8");
console.info(lines.join("\n"));
console.info(JSON.stringify({ step: "done", report: mdFile, dataDir }));
process.exit(0);
