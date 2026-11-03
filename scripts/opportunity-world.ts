/**
 * The synthetic world's report (docs/opportunity-agent.md §17.9 ③): every scenario's outcome, the §17.0 numbers, the counterfactual pairs,
 * the 60-day run and the defects found, for the code in this checkout. Nothing here touches the network or a real ledger.
 *
 *   pnpm exec tsx scripts/opportunity-world.ts                 the deterministic report (what CI runs, as numbers)
 *   pnpm exec tsx scripts/opportunity-world.ts --live[=3]      plus a real model reading the world's tricky pages k times, reported as pass^k
 *   … --out=<file.md>                                          also write the report to a file
 *
 * `--live` runs the real reader Skill (`crossline-opportunity-reader`) on a Codex home of its own: `CROSSLINE_STATE_DIR` (default
 * `C:\Users\karol\codex-home-opp`, which holds `codex-home`, signed in beforehand). The resident app's Codex home is never used. The model
 * reads each scenario page as its text (fed as a mail the triage found, so no web search and no request leaves the machine); quotes,
 * eligibility, deadlines and feasibility are then judged by the code as in production, and a scenario passes a round when the outcome is
 * the one fixed in advance. It spends quota; never run as a side effect.
 */
import { register } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const liveArg = args.find((arg) => arg.startsWith("--live"));
const rounds = liveArg ? Number(liveArg.split("=")[1] ?? 3) || 3 : 0;
const outFile = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
if (rounds) process.env.CROSSLINE_STATE_DIR ??= "C:\\Users\\karol\\codex-home-opp";

// The runner's per-run usage lines are not part of the report.
const log = console.info.bind(console);
console.info = (...items: unknown[]) => { if (!(typeof items[0] === "string" && items[0].startsWith('{"type":"skill.run"'))) log(...items); };

const harness = await import("../apps/worker/src/testing/opportunity-world/harness");
const { DEFECTS } = await import("../apps/worker/src/testing/opportunity-world/defects");
const { SCENARIOS, buildWorld } = await import("../apps/worker/src/testing/opportunity-world/scenarios");
const { searchWorld } = await import("../apps/worker/src/testing/opportunity-world/world");
const { htmlToText } = await import("../apps/worker/src/safe-fetch");
const { addMailCandidate, runWatch, OPPORTUNITY_NEEDS, OPPORTUNITY_READER } = await import("../apps/worker/src/opportunities");
const { readWatchList } = await import("../packages/db/src/index");

const lines: string[] = [];
const say = (text = "") => { lines.push(text); log(text); };
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const T = harness.THRESHOLDS;

const engines = [harness.watchEngine(), ...(harness.feasibilityOf ? [harness.watchEngine(harness.feasibilityOf)] : [])];
say(`# 合成世界报告（${new Date().toISOString().slice(0, 10)}）`);
say();
say(`引擎：${engines.map((engine) => engine.name).join("；")}${harness.feasibilityOf ? "" : "（② 未合入：时空场景挂起）"}`);

for (const engine of engines) {
  say();
  say(`## ${engine.name}`);
  for (const persona of ["faithful", "adversarial"] as const) {
    const run = await harness.runWorld({ engine, persona });
    const judged = harness.judgeRun(run, engine);
    const ready = harness.metricsOf(judged, run);
    say();
    say(`### ${persona === "faithful" ? "忠实模型" : "对抗模型"}`);
    say();
    say(`| 指标 | 数值 | 门槛 |`);
    say(`|---|---|---|`);
    say(`| 召回 | ${pct(ready.recall)}（${ready.found}/${ready.planted}） | ≥ ${pct(T.recall)} |`);
    say(`| 精度 | ${pct(ready.precision)}（${ready.correctPushes}/${ready.pushed}） | ≥ ${pct(T.precision)} |`);
    say(`| 不可行推送 | ${ready.infeasiblePushes} | ${T.infeasiblePushes} |`);
    say(`| 注入执行 | ${ready.injectionsExecuted} | ${T.injectionsExecuted} |`);
    say(`| 场景判对 | ${pct(ready.labelAccuracy)} | — |`);
    say(`| 每日打扰（7 天均值 / 最多） | ${(run.interruptionsByDay.reduce((a, b) => a + b, 0) / run.interruptionsByDay.length).toFixed(2)} / ${Math.max(...run.interruptionsByDay)} | — |`);
    say();
    say(`| 场景 | 应 | 实 | 问题 |`);
    say(`|---|---|---|---|`);
    for (const verdict of judged.verdicts) say(`| ${verdict.ok ? "✓" : verdict.pending ? "…" : "✗"} ${verdict.scenario.id} | ${verdict.scenario.expect} | ${verdict.got} | ${verdict.pending ? `挂起（等 ${(verdict.scenario.requires ?? []).filter((need) => !engine.capabilities.has(need)).join("、")}）` : verdict.problems.join("；")} |`);
    if (judged.strays.length) say(`\n不属于任何场景的推送：${judged.strays.map((push) => push.title).join("、")}`);
  }
  const pairs = await harness.runPairs(engine);
  const ready = pairs.filter((pair) => !pair.pending);
  say();
  say(`### 反事实对：翻转一致 ${ready.filter((pair) => pair.consistent).length}/${ready.length}（门槛 ≥ ${pct(T.flipConsistency)}；另 ${pairs.length - ready.length} 对挂起）`);
  say();
  say(`| 对 | 改了什么 | 原 应/实 | 翻转后 应/实 |`);
  say(`|---|---|---|---|`);
  for (const pair of pairs) say(`| ${pair.consistent ? "✓" : pair.pending ? "…" : "✗"} ${pair.id} | ${pair.what} | ${pair.expectBase}/${pair.base} | ${pair.expectFlipped}/${pair.flipped} |`);
  const long = await harness.runLong(engine);
  say();
  say(`### 60 天长跑（第 ${harness.LONGRUN_NODE.day} 天 ${harness.LONGRUN_NODE.id} 验收）`);
  say();
  say(`- 监视项变化：${long.changedOnDay === undefined ? "没有变化" : `第 ${long.changedOnDay} 天`}${engine.capabilities.has("watches") ? "" : "（① 未合入，按节点重推挂起）"}`);
  say(`- 节点后的「研讨会报告」机会：${long.talksFoundOnDay === undefined ? "没找到" : `第 ${long.talksFoundOnDay} 天`}`);
  say(`- 每日打扰：均值 ${long.meanInterruptions.toFixed(2)}，最多 ${long.maxInterruptions}`);
  const spend = long.run.spend;
  say(`- 探索占比：${spend ? pct(spend.explore / Math.max(1, spend.total)) : "无（侦察是 ① 的，未合入）"}`);
}

say();
say(`## 发现的缺陷`);
say();
for (const defect of DEFECTS) say(`- **${defect.id}**（${defect.owner}，${defect.where}）：${defect.what}`);

if (rounds) await live(rounds);
if (outFile) writeFileSync(outFile, `${lines.join("\n")}\n`);

/**
 * The real reader on the world's pages: each scenario page as a mail candidate of the watch whose search leads to it, one run of that watch,
 * then the same pushes and judgement as the deterministic run. pass^k: a scenario counts only when every round got it right.
 */
async function live(k: number) {
  const { startCodexSupervisor } = await import("../packages/codex/src/index");
  const supervisor = await startCodexSupervisor({ port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
    plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
      requiredSkills: [OPPORTUNITY_NEEDS, OPPORTUNITY_READER] } }) as unknown as { client: unknown; stop: () => Promise<void> };
  const world = buildWorld((await import("../apps/worker/src/testing/opportunity-world/person")).BASE_PERSON);
  const subset = SCENARIOS.filter((scenario) => (scenario.scope ?? "main") === "main" && !scenario.requires?.some((need) => need !== "feasibility")
    && scenario.urls.every((url) => world.pages.has(new URL(url).toString())) && (harness.feasibilityOf || !scenario.requires?.length));
  const base = harness.watchEngine(harness.feasibilityOf);
  const liveEngine = (): typeof base => ({
    ...base,
    name: "真读取器",
    tick: async (ctx, now) => {
      if (ctx.world.day > 0) return;
      // Each page goes to the watch whose web search leads to it: the reader drops a page that holds nothing of its watch's kind.
      const wanted = new Set(subset.flatMap((scenario) => scenario.urls.map((url) => new URL(url).toString())));
      for (const watch of readWatchList(ctx.store, ctx.workspaceId).filter((item) => item.state === "active")) {
        const urls = new Set((watch.targets ?? []).flatMap((target) => target.tool === "web_search" ? searchWorld(ctx.world, target.query) : [])
          .flatMap((hit) => [hit.reading, ...(hit.adversarial ?? [])]).flatMap((item) => item ? [new URL(item.url).toString()] : []).filter((url) => wanted.has(url)));
        if (!urls.size) continue;
        for (const url of urls) addMailCandidate(ctx.store, ctx.workspaceId, { key: `live:${url}`, lineId: watch.lineId, subject: "", from: "",
          text: htmlToText(ctx.world.pages.get(url)!.body), url, at: now.toISOString() });
        await runWatch(ctx.store, ctx.workspaceId, { ...watch, targets: [] }, { client: () => supervisor.client as never, cwd: repoRoot, now: () => now,
          ...(harness.feasibilityOf ? { feasibility: harness.worldFeasibility(ctx, harness.feasibilityOf) } : {}) });
      }
    }
  });
  const engine = liveEngine();
  const passes = new Map(subset.map((scenario) => [scenario.id, 0]));
  const notes = new Map<string, string[]>();
  try {
    for (let round = 1; round <= k; round += 1) {
      const started = Date.now();
      const run = await harness.runWorld({ engine, days: 1 });
      const { verdicts } = harness.judgeRun(run, engine);
      for (const verdict of verdicts.filter((item) => passes.has(item.scenario.id))) {
        if (verdict.ok) passes.set(verdict.scenario.id, passes.get(verdict.scenario.id)! + 1);
        else {
          // What the record says, so a miss can be told apart: the model's reading or the code's judgement.
          const rows = run.opportunities.filter((row) => verdict.scenario.urls.some((url) => new URL(url).toString() === new URL(row.url).toString()));
          const said = rows.map((row) => `${row.verdict.state}${row.verdict.state === "unknown" ? `（${row.verdict.questions.map((item) => item.question).join("；")}）` : ""}`
            + ` 截止 ${row.deadlines.map((item) => item.day).join("、") || "无"}`).join("；") || "账本里没有";
          notes.set(verdict.scenario.id, [...(notes.get(verdict.scenario.id) ?? []),
            `第 ${round} 轮 ${verdict.got}${verdict.problems.length ? `：${verdict.problems.join("；")}` : ""}（${said}）`]);
        }
      }
      console.info(`第 ${round} 轮 ${Math.round((Date.now() - started) / 1000)} 秒`);
    }
  } finally { await supervisor.stop(); }
  const all = [...passes.values()].filter((n) => n === k).length;
  say();
  say(`## 真模型（${engine.name}，k=${k}）：pass^${k} = ${all}/${subset.length}`);
  say();
  say(`| 场景 | 通过轮数 | 失败 |`);
  say(`|---|---|---|`);
  for (const scenario of subset) say(`| ${passes.get(scenario.id) === k ? "✓" : "✗"} ${scenario.id} | ${passes.get(scenario.id)}/${k} | ${(notes.get(scenario.id) ?? []).join("；")} |`);
}
