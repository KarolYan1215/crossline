/**
 * Measures the ledger index (token-economy.md §2) on a copy of a real ledger, with no model call: for real tasks, how many characters of
 * facts the step planner is handed whole (a route without functions) and as an index (a route that calls `read_ledger`), and for real
 * captures, how long the capture analysis's context is whole and as an index; plus what reading every cut line whole would cost, the
 * worst case of `read_ledger` (capped at `LEDGER_READ_BUDGET` a run); and, per line, what the line-skill compiler was shown on every
 * rewrite (all materials) against what it is shown now when one material is added (that one and the previous rules with their sources).
 *
 *   pnpm exec tsx scripts/ledger-index-check.ts <copy.db> [--workspace <id>] [--tasks 6] [--captures 4]
 *
 * Refuses a file in a folder named `data` (the live ledger). Opening the copy runs pending migrations on it.
 */
import path from "node:path";
import { LEDGER_READ_BUDGET, currentMineVersion, mineSkillSettingKey, readMineSkill, resolveMineSources } from "../packages/core/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { analysisLedger, buildAnalysisContext } from "../apps/worker/src/analysis";
import { mineMaterials } from "../apps/worker/src/insight-compiler";
import { identityLines } from "../apps/worker/src/lines";
import { planningContext } from "../apps/worker/src/step-planner";

const args = process.argv.slice(2);
const file = args[0];
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
if (!file) throw new Error("usage: ledger-index-check.ts <copy.db> [--workspace <id>] [--tasks 6] [--captures 4]");
if (path.basename(path.dirname(path.resolve(file))).toLowerCase() === "data") throw new Error("REFUSED_LIVE_LEDGER: pass a copy, not a file in data/");

const store = new CrosslineStore(file);
const workspaceId = flag("--workspace") ?? [...store.listWorkspaces()].sort((a, b) => store.listWorkOrders(b.id).length - store.listWorkOrders(a.id).length)[0]!.id;
const n = (value: number) => value.toLocaleString("en-US");
/** What `read_ledger` returns for every cut line of an index, summed (each line read once). */
const worstRead = (lines: string[], full: (id: string) => number) =>
  Math.min(LEDGER_READ_BUDGET, lines.filter((line) => line.endsWith("…")).reduce((sum, line) => sum + full(line.split(" ")[0]!), 0));

console.log(`## 账本索引实测：${new Date().toISOString().slice(0, 10)}，工作区 ${workspaceId}`);
console.log();
console.log("### 拆步骤：person.facts");
console.log();
console.log("| 任务 | 线 / 项目 | 全文（无工具）字符 / 条 | 索引（有工具）字符 / 条 | 被截断的行 | 全读截断行（上限 8k） |");
console.log("|---|---|---|---|---|---|");
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active"]);
const seen = new Set<string>();
const orders = store.listWorkOrders(workspaceId).filter((order) => OPEN.has(order.state) && order.identityId !== "health")
  .filter((order) => { const key = `${order.identityId}/${order.projectId}`; if (seen.has(key)) return false; seen.add(key); return true; })
  .slice(0, Number(flag("--tasks") ?? 6));
let before = 0, after = 0;
for (const order of orders) {
  const grounding = planningContext(store, workspaceId, order);
  const full = JSON.stringify(grounding.person).length;
  const index = JSON.stringify(grounding.factIndex.index).length;
  before += full; after += index;
  const cut = grounding.factIndex.index.filter((line) => line.endsWith("…"));
  const read = worstRead(grounding.factIndex.index, (id) => grounding.factIndex.tools.call("read_ledger", { ids: [id] }).toString().length);
  const title = String((order.payload as { title?: string } | undefined)?.title ?? order.intent).slice(0, 24);
  console.log(`| ${title} | ${order.identityId} / ${order.projectId} | ${n(full)} / ${grounding.person.length} | ${n(index)} / ${grounding.factIndex.index.length} | ${cut.length} | ${n(read)} |`);
}
console.log();
console.log(`合计：全文 ${n(before)} → 索引 ${n(after)}（${before ? Math.round((1 - after / before) * 100) : 0}% 少）。`);
console.log();
console.log("### 收集分析：整份上下文");
console.log();
console.log("| 收集 | 全文 字符 | 索引 字符 | 其中 existingTasks → taskIndex | relations | personProfile | 全读截断项（上限 8k） |");
console.log("|---|---|---|---|---|---|---|");
const captures = store.listCaptures(workspaceId).slice(-Number(flag("--captures") ?? 4));
let analysisBefore = 0, analysisAfter = 0;
for (const capture of captures) {
  const context = buildAnalysisContext(store, workspaceId, capture);
  const ledger = analysisLedger(context, store, workspaceId);
  const whole = JSON.stringify(context).length, indexed = JSON.stringify(ledger.indexed).length;
  analysisBefore += whole; analysisAfter += indexed;
  const size = (value: unknown) => JSON.stringify(value).length;
  const cutIds = [
    ...(ledger.indexed.taskIndex ?? []).filter((line) => line.includes("…")).map((line) => line.split("｜")[0]!),
    ...(ledger.indexed.relations ?? []).filter((relation) => relation.explanation.endsWith("…")).map((relation) => relation.explanation.split(" ")[0]!),
    ...(ledger.indexed.personProfile ?? []).filter((line) => line.endsWith("…")).map((line) => line.split(" ")[0]!)];
  const read = Math.min(LEDGER_READ_BUDGET, cutIds.reduce((sum, id) => sum + String(ledger.tools.call("read_ledger", { ids: [id] })).length, 0));
  console.log(`| ${capture.title.slice(0, 24)} | ${n(whole)} | ${n(indexed)} | ${n(size(context.existingTasks))} → ${n(size(ledger.indexed.taskIndex))} | ${n(size(context.relations))} → ${n(size(ledger.indexed.relations))} | ${n(size(context.personProfile))} → ${n(size(ledger.indexed.personProfile))} | ${n(read)}（${cutIds.length} 项） |`);
}
console.log();
console.log(`合计：全文 ${n(analysisBefore)} → 索引 ${n(analysisAfter)}（${analysisBefore ? Math.round((1 - analysisAfter / analysisBefore) * 100) : 0}% 少）。`);
console.log();
console.log("### 主线技能编译：每次重编的材料与上一版规则");
console.log();
console.log("| 主线 | 材料条数 | 改前（全部材料 + 规则文字） | 改后：新增一条（该条 + 带来源的上一版规则） |");
console.log("|---|---|---|---|");
for (const line of identityLines(store, workspaceId)) {
  const materials = mineMaterials(store, workspaceId, line.id).map(({ key: _key, ...material }) => material);
  if (!materials.length) continue;
  const rules = currentMineVersion(readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(line.id))))?.rules ?? [];
  const old = JSON.stringify({ materials, previousRules: rules.map((rule) => ({ kind: rule.kind, text: rule.text })) }).length;
  const previousRules = rules.map((rule, index) => ({ id: `r${index + 1}`, kind: rule.kind, text: rule.text, sources: resolveMineSources(rule, materials), quote: rule.quote, url: rule.url }));
  const newest = [...materials].sort((a, b) => b.at.localeCompare(a.at))[0]!;
  const incremental = JSON.stringify({ materials: [newest], previousRules }).length;
  console.log(`| ${line.label}（${line.id}） | ${materials.length} | ${n(old)} | ${n(incremental)}（规则 ${rules.length} 条） |`);
}
store.close();
