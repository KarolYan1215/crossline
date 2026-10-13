/**
 * How the scheduler does on the person's real week: the same planner input the page builds (`planningInputFor`), solved with
 * different time limits, reporting time taken, deadline work placed and line-share filler placed. Read from a **copy** of the live
 * ledger (SQLite online backup); nothing is written. Used to measure docs/loop-and-scout.md §2.
 *
 *   pnpm exec tsx scripts/schedule-bench.ts
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-schedule-bench-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { planningInputFor, planToday, loadCurrentPlan } = await import("../apps/web/lib/crossline");
const { planSchedule } = await import("../packages/planner/src/index");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const principalId = store.getWorkspaceOwnerId(workspace.id)!;
const ctx = { principalId, workspaceId: workspace.id, role: "owner", identity: { provider: "credential", issuer: "bench", subject: principalId },
  authMethod: "session", requestId: "schedule-bench" } as import("../packages/core/src/index").AccessContext;
const today = planToday(ctx);
const committed = (loadCurrentPlan(ctx).blocks ?? []).filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && !block.id.startsWith("optional:"));
const { input } = planningInputFor(ctx, today, committed);
const withDeadline = input.tasks.filter((task) => task.deadline && !task.floorOnly);
const floorOnly = new Set(input.tasks.filter((task) => task.floorOnly).map((task) => task.id));
console.log(`input: ${input.tasks.length} tasks, ${withDeadline.length} with a deadline, ${floorOnly.size} line-share filler, ${input.availability.length} slots`);

const minutes = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 60_000;
for (const [label, options] of [["greedy (limit 0.001 s)", { timeLimitSeconds: 0.001 }], ["page (limit 2 s)", { timeLimitSeconds: 2 }], ["background (limit 20 s)", { timeLimitSeconds: 20 }]] as const) {
  const started = performance.now();
  const result = await planSchedule(input, options);
  const seconds = (performance.now() - started) / 1000;
  const placed = result.plan.blocks.filter((block) => !block.frozen);
  const deadlineIds = new Set(withDeadline.map((task) => task.id));
  const deadlinePlaced = new Set(placed.filter((block) => deadlineIds.has(block.taskId)).map((block) => block.taskId)).size;
  const deadlineMinutes = placed.filter((block) => deadlineIds.has(block.taskId)).reduce((sum, block) => sum + minutes(block.start, block.end), 0);
  const floorMinutes = placed.filter((block) => floorOnly.has(block.taskId)).reduce((sum, block) => sum + minutes(block.start, block.end), 0);
  console.log(`${label}: ${seconds.toFixed(2)} s · solver ${result.solver} · deadline tasks ${deadlinePlaced}/${withDeadline.length} · deadline minutes ${Math.round(deadlineMinutes)} · line-share minutes ${Math.round(floorMinutes)}`);
}
