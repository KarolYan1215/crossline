/**
 * How the scheduler does on the person's real week: the same planner input the page builds (`planningInputFor`), solved with
 * different time limits, reporting time taken, deadline work placed and line-share filler placed; then the page's own path (greedy at
 * once, the optimal plan solved on the solver thread and cached). Read from a **copy** of the live ledger (SQLite online backup);
 * nothing is written to the live ledger. Used to measure docs/loop-and-scout.md §2.
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
process.env.CROSSLINE_BACKGROUND_SOLVE = "on";

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { planningInputFor, planToday, loadCurrentPlan, scheduleHashOf } = await import("../apps/web/lib/crossline");
const { optimalIdle } = await import("../apps/web/lib/optimal-schedule");
const { planSchedule } = await import("../packages/planner/src/index");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const principalId = store.getWorkspaceOwnerId(workspace.id)!;
const ctx = { principalId, workspaceId: workspace.id, role: "owner", identity: { provider: "credential", issuer: "bench", subject: principalId },
  authMethod: "session", requestId: "schedule-bench" } as import("../packages/core/src/index").AccessContext;
const today = planToday(ctx);
const committed = (await loadCurrentPlan(ctx)).blocks.filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && !block.id.startsWith("optional:"));
await optimalIdle();
const { input, instants, currentEnergy } = planningInputFor(ctx, today, committed);
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

// The page's path (§2 acceptance): (a) a read is the greedy plan; (b) reads while the background solve runs; (c) the optimal plan is
// cached within a minute, with line-share minutes; (d) crossing into the next slot changes the cache key.
const { OPTIMAL_SETTING } = await import("../apps/web/lib/optimal-schedule");
store.setSetting(workspace.id, OPTIMAL_SETTING, "");
const timed = async () => { const started = performance.now(); await loadCurrentPlan(ctx); return performance.now() - started; };
// One read after another (the reads are JavaScript on one thread: run all at once, they queue behind each other and time the queue).
const quiet: number[] = [];
const busy: number[] = [];
const asked = performance.now();
const first = await timed();
for (let i = 0; i < 10; i++) busy.push(await timed());
await optimalIdle();
const solvedMs = performance.now() - asked;
for (let i = 0; i < 10; i++) quiet.push(await timed());
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
console.log(`(a) first read (greedy, asks for the optimal plan): ${first.toFixed(0)} ms`);
console.log(`(b) 10 reads in a row while solving: median ${median(busy).toFixed(0)} ms · 10 reads after: median ${median(quiet).toFixed(0)} ms`);
const cached = JSON.parse(store.getSetting(workspace.id, OPTIMAL_SETTING) || "null") as { result: import("../packages/planner/src/index").PlanResult } | null;
const cachedFloor = (cached?.result.plan.blocks ?? []).filter((block) => !block.frozen && floorOnly.has(block.taskId))
  .reduce((sum, block) => sum + minutes(block.start, block.end), 0);
const plan = await loadCurrentPlan(ctx);
console.log(`(c) optimal plan cached ${cached ? "yes" : "no"} after ${(solvedMs / 1000).toFixed(1)} s more (solver ${cached?.result.solver ?? "-"}) · page now optimal: ${plan.schedule.optimal} · line-share minutes ${Math.round(cachedFloor)}`);
const slot = instants.find((item) => Date.parse(item.end) > input.now.getTime());
if (slot) {
  const later = new Date(Date.parse(slot.end) + 60_000);
  process.env.CROSSLINE_FIXED_NOW = later.toISOString();
  const next = planningInputFor(ctx, planToday(ctx, later), committed);
  console.log(`(d) slot boundary ${slot.end}: key ${scheduleHashOf(input, instants, currentEnergy).slice(0, 8)} -> ${scheduleHashOf(next.input, next.instants, next.currentEnergy).slice(0, 8)}`);
  delete process.env.CROSSLINE_FIXED_NOW;
}
process.exit(0);
