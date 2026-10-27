/**
 * Times what the pages derive from a ledger, each read after a write so no cache from the previous read is used (as on the hosted
 * beta, where the worker writes every tick), then counts the store reads behind one decisions list, one pending count and one schedule.
 * Run it on a **copy** (it writes a `perf.touch` setting); with `node --import tsx --cpu-prof` it gives the profile behind the numbers.
 *
 *   pnpm exec tsx scripts/perf-profile.ts <copy.db> [workspace]
 */
import { register } from "node:module";
import path from "node:path";
register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const file = process.argv[2]!;
process.env.CROSSLINE_DATA_DIR = path.dirname(file);
process.env.CROSSLINE_AUTO_PUBLISH = "off";
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";
const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(file);
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const workspace = process.argv[3] ?? store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!.id;
const principalId = store.getWorkspaceOwnerId(workspace)!;
const ctx = { principalId, workspaceId: workspace, role: "owner", identity: { provider: "credential", issuer: "bench", subject: principalId },
  authMethod: "session", requestId: "perf" } as import("../packages/core/src/index").AccessContext;
let n = 0;
const touch = () => store.setSetting(workspace, "perf.touch", String(++n));
const { openAsks } = await import("../apps/web/lib/asks");
const { countPending } = await import("../apps/web/lib/pending");
const { loadCurrentPlan, loadDashboard } = await import("../apps/web/lib/crossline");
const { startReadiness } = await import("../apps/web/lib/start-gate");
const time = async (name: string, run: () => unknown) => {
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) { touch(); const t = performance.now(); await run(); ms.push(performance.now() - t); }
  console.log(name.padEnd(20), ms.map((v) => v.toFixed(0)).join(" "));
};
await time("plan", () => loadCurrentPlan(ctx));
await time("asks", () => openAsks(ctx));
await time("pending", () => countPending(ctx));
await time("pending+asks", () => { countPending(ctx); return openAsks(ctx); });
await time("dashboard", () => loadDashboard(ctx));
await time("startGate", () => startReadiness(ctx));
{
  const counts = new Map<string, number>();
  for (const name of ["listSourceDocuments", "listEvents", "listWorkOrders", "listMilestones", "getSetting", "listProfileFacts", "listMilestoneAnchors", "listStepPlans", "listProjects"] as const) {
    const orig = (store as any)[name].bind(store);
    (store as any)[name] = (...args: any[]) => { counts.set(name, (counts.get(name) ?? 0) + 1); return orig(...args); };
  }
  touch(); openAsks(ctx); console.log("asks calls", Object.fromEntries(counts)); counts.clear();
  touch(); countPending(ctx); console.log("pending calls", Object.fromEntries(counts)); counts.clear();
  touch(); await loadCurrentPlan(ctx); console.log("plan calls", Object.fromEntries(counts)); counts.clear();
}
{
  const { interviewStatus } = await import("../apps/web/lib/interview-status");
  const { loadMilestoneBoard } = await import("../apps/web/lib/milestone-board");
  const { loadPlanBoard } = await import("../apps/web/lib/plan-board");
  await time("interviewStatus", () => interviewStatus(ctx));
  await time("milestoneBoard", () => loadMilestoneBoard(ctx));
  await time("planBoard", async () => loadPlanBoard(ctx, await loadCurrentPlan(ctx), undefined));
}
{
  const { loadTaskDetailsBatch } = await import("../apps/web/lib/task-detail");
  const ids = store.listWorkOrders(workspace).filter((order) => !["archived", "accepted"].includes(order.state)).map((order) => order.id);
  await time(`taskDetails(${ids.length})`, () => loadTaskDetailsBatch(ctx, ids));
}
