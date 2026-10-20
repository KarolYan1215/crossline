/**
 * Measures context selection (docs/context-selection.md) on a copy of a real ledger, with no model call: for a handful of real tasks it
 * prints how many characters of material and facts the step planner, the capture analysis and the backplanner were handed before
 * (the project's files cut at 16k each and 48k in all; the first fifty facts; the opening of the first eight files) and now (the
 * passages chosen for the task, with and without lookups; facts ranked within a budget), and the headings of the passages chosen, so
 * whether they belong to the task can be read.
 *
 *   pnpm exec tsx scripts/context-selection-check.ts <copy.db> [--workspace <id>] [--tasks 5]
 *
 * Refuses a file in a folder named `data` (the live ledger). Writes to the copy: migration 19 builds the passage index there.
 */
import path from "node:path";
import { CONTEXT_BUDGETS, relevantDocuments } from "../packages/core/src/index";
import { CrosslineStore, type StoredWorkOrder } from "../packages/db/src/index";
import { analysisMaterialInputs, lineDocumentIds, materialExcerpts } from "../apps/worker/src/material-context";
import { identityLines } from "../apps/worker/src/lines";
import { folderDocuments } from "../apps/worker/src/source-folders";
import { planningContext, taskQuery } from "../apps/worker/src/step-planner";

type Raw = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown }; pragma: (sql: string, options?: { simple: boolean }) => unknown; close: () => void };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string) => Raw;

const args = process.argv.slice(2);
const file = args[0];
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
if (!file) throw new Error("usage: context-selection-check.ts <copy.db> [--workspace <id>] [--tasks 5]");
if (path.basename(path.dirname(path.resolve(file))).toLowerCase() === "data") throw new Error("REFUSED_LIVE_LEDGER: pass a copy, not a file in data/");

const raw = new Database(file);
const fromVersion = Number(raw.pragma("user_version", { simple: true }));
raw.close();
const opened = Date.now();
const store = new CrosslineStore(file);
const openMs = Date.now() - opened;

const workspaceId = flag("--workspace") ?? (() => {
  const counts = new Map<string, number>();
  for (const ws of store.listWorkspaces()) counts.set(ws.id, store.listWorkOrders(ws.id).length);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
})();
const indexed = store.reindexDocuments(workspaceId);
const projects = new Map(store.listProjects(workspaceId, { includeArchived: true }).map((project) => [project.id, project]));
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active"]);

/** The step planner's material and facts as they were before (step-planner.ts up to 2026-10-20). */
function before(order: StoredWorkOrder) {
  const project = projects.get(order.projectId);
  const readable = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done");
  const relevant = relevantDocuments(readable, { projectId: order.projectId, projectName: project?.name });
  const fromFolders = folderDocuments(store, workspaceId);
  const lineFolderDocs = relevant.length >= 3 ? [] : readable.filter((doc) => !doc.projectId && !relevant.includes(doc)
    && (fromFolders.get(doc.id)?.lines ?? []).includes(order.identityId));
  let budget = 48_000;
  const documents = [...relevant, ...lineFolderDocs].map((doc) => {
    const text = doc.extractedText.slice(0, Math.max(0, Math.min(16_000, budget)));
    budget -= text.length;
    return { name: doc.fileName, text };
  }).filter((doc) => doc.text.trim());
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" || fact.value.startsWith("假设"));
  const own = (fact: (typeof facts)[number]) => fact.projectId === order.projectId ? 0 : fact.identityId === order.identityId ? 1 : 2;
  const person = facts.filter((fact) => own(fact) < 2 && !fact.slot.startsWith("step_answer")).sort((a, b) => own(a) - own(b)).slice(0, 50)
    .map((fact) => `${fact.slot}：${fact.value.slice(0, 240)}`);
  const analysis = readable.filter((doc) => doc.extractedText.trim()).slice(0, 8)
    .map((doc) => `用户此前已交给系统的资料《${doc.fileName}》（已读取）。开头：${doc.extractedText.trim().replace(/\s+/g, " ").slice(0, 300)}`);
  return { documents, materialChars: JSON.stringify(documents).length, factChars: JSON.stringify(person).length, facts: person.length,
    analysisChars: JSON.stringify(analysis).length };
}

// Five real tasks of different lines and projects: those with files of their own first, at least one without.
const orders = store.listWorkOrders(workspaceId).filter((order) => OPEN.has(order.state) && order.identityId !== "health");
const withFiles = (order: StoredWorkOrder) => before(order).documents.length > 0;
const picked: StoredWorkOrder[] = [];
const seen = new Set<string>();
const want = Number(flag("--tasks") ?? 5);
for (const order of [...orders.filter(withFiles), ...orders.filter((order) => !withFiles(order))]) {
  const key = `${order.identityId}/${order.projectId}`;
  if (seen.has(key) && picked.length < orders.length) continue;
  if (picked.length === want - 1 && picked.every(withFiles) && withFiles(order)) continue;
  seen.add(key);
  picked.push(order);
  if (picked.length >= want) break;
}

const out: string[] = [];
const say = (line = "") => { out.push(line); console.log(line); };
const docs = store.listSourceDocuments(workspaceId);
say(`## 实测：${new Date().toISOString().slice(0, 10)}，本人账本只读副本`);
say();
say(`- 副本 user_version ${fromVersion} → ${store.schemaVersion()}，打开并迁移 ${openMs} ms；本工作区 ${docs.length} 份文件、${docs.reduce((sum, doc) => sum + doc.extractedText.length, 0).toLocaleString("en-US")} 字，切成 ${indexed} 段。`);
const probe = Date.now();
for (let i = 0; i < 20; i += 1) store.searchDocChunks(workspaceId, "ECE 548 midterm 讲义 作业");
say(`- 检索一次平均 ${((Date.now() - probe) / 20).toFixed(1)} ms（20 次，含两字词 LIKE）。`);
say();
say("| 任务 | 线 / 项目 | 改前给的文件数 | 改前 材料 / 事实 | 改后 有工具 / 无工具 / 事实 | 捕获分析 改前 → 改后 | 倒推 片段 |");
say("|---|---|---|---|---|---|---|");
const detail: string[] = [];
for (const order of picked) {
  const old = before(order);
  const grounding = planningContext(store, workspaceId, order);
  const view = JSON.stringify(grounding.material.view()).length;
  const fallback = JSON.stringify(grounding.material.fallback()).length;
  const facts = JSON.stringify(grounding.person).length;
  const query = taskQuery(store, workspaceId, order);
  const analysis = JSON.stringify(analysisMaterialInputs(store, workspaceId, order.intent)).length;
  // As the backplanner does: the project's files, else the line's.
  const ownExcerpts = materialExcerpts(store, workspaceId, query, { projectId: order.projectId, identityId: order.identityId, within: "project" });
  const excerpts = ownExcerpts.length ? ownExcerpts : materialExcerpts(store, workspaceId, query, { identityId: order.identityId, within: "line" });
  const title = String((order.payload as { title?: string } | undefined)?.title ?? order.intent).slice(0, 28);
  say(`| ${title} | ${order.identityId} / ${projects.get(order.projectId)?.name ?? order.projectId} | ${old.documents.length} | ${old.materialChars.toLocaleString("en-US")} / ${old.factChars.toLocaleString("en-US")}（${old.facts} 条） | ${view.toLocaleString("en-US")} / ${fallback.toLocaleString("en-US")} / ${facts.toLocaleString("en-US")}（${grounding.person.length} 条） | ${old.analysisChars.toLocaleString("en-US")} → ${analysis.toLocaleString("en-US")} | ${JSON.stringify(excerpts).length.toLocaleString("en-US")} |`);
  detail.push(`### ${title}`, "", `检索词：${query.slice(0, 160)}`, "");
  const ranked = grounding.material.ranked();
  const shown = new Set(grounding.material.view().passages.map((passage) => passage.id));
  for (const passage of ranked.slice(0, 10)) detail.push(`- ${shown.has(passage.id) ? "全文" : "候选"} ${passage.id} ${passage.own ? "（本任务文件）" : ""}${passage.heading} · 第 ${passage.at} 段 · ${passage.score}`);
  if (!ranked.length) detail.push("- （没有候选段落）");
  const analysisPicked = analysisMaterialInputs(store, workspaceId, order.intent).filter((input) => input.id !== "uploaded-other-files")
    .map((input) => input.text.match(/《(.+?)》/)?.[1] ?? input.id);
  detail.push(`- 捕获分析拿到的段落来自：${analysisPicked.join("、") || "（无）"}`);
  const sample = grounding.material.tools.call("search_material", { query: projects.get(order.projectId)?.name ?? order.identityId, scope: "line" });
  detail.push(`- 模拟一次 search_material（本线）：${String(sample).split("\n").length} 条，${String(sample).length} 字`, "");
}
say();
say(`预算：有工具时候选 ≤ ${CONTEXT_BUDGETS.candidates}、全文 ≤ ${CONTEXT_BUDGETS.topFull}；无工具 ≤ ${CONTEXT_BUDGETS.noTools}；事实 ≤ ${CONTEXT_BUDGETS.facts}；捕获分析 ≤ ${CONTEXT_BUDGETS.analysis}；倒推/里程碑片段 ≤ ${CONTEXT_BUDGETS.excerpts}（字符）。`);
say();
for (const line of detail) say(line);
say("里程碑设计（每条线一次，检索词为该线的名称、长期目标与项目名）：");
say();
for (const pack of identityLines(store, workspaceId)) {
  const names = store.listProjects(workspaceId).filter((project) => project.identityId === pack.id).map((project) => project.name).join(" ");
  const excerpts = materialExcerpts(store, workspaceId, `${pack.label} ${pack.goal ?? ""} ${names}`, { identityId: pack.id, within: "line" });
  say(`- ${pack.label}（${pack.id}）：本线文件 ${lineDocumentIds(store, workspaceId, pack.id).size} 份，片段 ${excerpts.length} 段 ${JSON.stringify(excerpts).length} 字：${[...new Set(excerpts.map((item) => item.file))].slice(0, 4).join("、") || "（无）"}`);
}
store.close();
