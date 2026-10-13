/**
 * What is waiting for a decision, by how soon it matters: each pending item with the date it bears on (a task's due day or its
 * milestone's deadline, an ask's due day, a draft's deadline) bucketed into this week, later and no date. Read
 * from a **copy** of the live ledger (SQLite online backup); nothing is written.
 *
 *   pnpm exec tsx scripts/pending-horizon.ts
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-pending-horizon-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { countPending } = await import("../apps/web/lib/pending");
const { openAsks } = await import("../apps/web/lib/asks");
const { planToday } = await import("../apps/web/lib/crossline");
const { listAgentTasks } = await import("../packages/db/src/index");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const principalId = store.getWorkspaceOwnerId(workspace.id)!;
const ctx = { principalId, workspaceId: workspace.id, role: "owner", identity: { provider: "credential", issuer: "horizon", subject: principalId },
  authMethod: "session", requestId: "pending-horizon" } as import("../packages/core/src/index").AccessContext;
const today = planToday(ctx);
const week = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
const bucket = (day: string) => !day ? "无日期" : day < today ? "已过" : day <= week ? "7 天内" : "更晚";
const anchors = new Map(store.listMilestoneAnchors(workspace.id).map((anchor) => [anchor.milestoneId, anchor.deadline]));
const rows: Array<{ kind: string; title: string; day: string }> = [];
for (const order of store.listWorkOrders(workspace.id).filter((item) => item.state === "awaiting_plan_approval")) {
  const payload = order.payload as { dueDate?: string; notBefore?: string; libraryUntil?: string };
  rows.push({ kind: "任务提案", title: order.intent.slice(0, 40), day: payload.dueDate || anchors.get(order.milestoneId) || "" });
}
for (const milestone of store.listMilestones(workspace.id).filter((item) => item.status === "draft")) rows.push({ kind: "里程碑草稿", title: milestone.title.slice(0, 40), day: anchors.get(milestone.id) ?? "" });
for (const ask of openAsks(ctx)) rows.push({ kind: `待决:${ask.kind}`, title: ask.title.slice(0, 40), day: ask.dueDay ?? "" });
for (const task of listAgentTasks(store, workspace.id).filter((item) => item.status === "needs_review")) {
  const order = store.listWorkOrders(workspace.id).find((item) => item.id === task.workOrderId);
  rows.push({ kind: "助手成果", title: task.title.slice(0, 40), day: order ? (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "" : "" });
}
const counts = countPending(ctx);
console.info(JSON.stringify({ today, week, counts }, null, 1));
const table = new Map<string, Record<string, number>>();
for (const row of rows) {
  const entry = table.get(row.kind) ?? {};
  entry[bucket(row.day)] = (entry[bucket(row.day)] ?? 0) + 1;
  table.set(row.kind, entry);
}
console.info(JSON.stringify(Object.fromEntries(table), null, 1));
for (const row of rows.sort((a, b) => (a.day || "9999").localeCompare(b.day || "9999"))) console.info(`${bucket(row.day)}\t${row.day || "—"}\t${row.kind}\t${row.title}`);
store.close();
process.exit(0);
