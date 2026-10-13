/**
 * R1 of docs/review-2026-10-13.md on a **copy** of the live ledger, nothing mocked: how recently the person did something themselves and
 * which tier that puts background spending in; and, with the schedule recorded the way the web records it, how many tutorials and
 * assistant preparations the old rule (anything this week, never built) would start against the new one (starting within two days,
 * rebuilt when its inputs changed or it is a week old).
 *
 *   pnpm exec tsx scripts/engagement-check.ts
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-engagement-check-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";

const { CrosslineStore, listAgentTasks } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { engagementTier, spendAllows } = await import("../packages/core/src/index");
const { recordScheduledToday } = await import("../apps/web/lib/schedule-memory");
const { pendingTutorials } = await import("../apps/worker/src/manualbook");
const { stepDispatchCandidates, dispatchCandidates } = await import("../apps/worker/src/agent-dispatch");
const { startingWithin } = await import("../apps/worker/src/schedule-window");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const ws = workspace.id;
const principalId = store.getWorkspaceOwnerId(ws)!;
const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "engagement-check", subject: principalId },
  authMethod: "session", requestId: "engagement-check" } as import("../packages/core/src/index").AccessContext;
const now = new Date();

const last = store.lastPersonActivity(ws);
const tier = engagementTier(last, now, workspace.createdAt);
const allowed = (["intake", "core", "discretionary"] as const).filter((kind) => spendAllows({ mode: "normal", engagement: tier }, kind));
console.log(`last own action: ${last ?? "none"} → ${tier}; with the quota normal, allowed: ${allowed.join(", ") || "nothing"}`);

// The schedule as the web records it every ten minutes.
await recordScheduledToday(ctx, now);
let upcoming: string[] = [];
try { upcoming = JSON.parse(store.getSetting(ws, "schedule.upcoming") ?? "[]") as string[]; } catch { /* none */ }
const built = new Set(store.listEvents(ws, { type: "manualbook.built" }).map((event) => event.entityId));
const orders = new Map(store.listWorkOrders(ws).map((order) => [order.id, order]));
const oldTutorials = upcoming.filter((id) => { const order = orders.get(id);
  return order && ["approved", "ready_for_human", "active"].includes(order.state) && !built.has(id) && Boolean(store.getStepPlan(ws, id)); });
const soon = startingWithin(store, ws, now);
console.log(`work with a block this week: ${upcoming.length}; starting within 48 h: ${soon.size}`);
console.log(`tutorials — old rule (this week, never built): ${oldTutorials.length}; new rule (48 h, new or stale): ${pendingTutorials(store, ws, now).length}`);
console.log(`assistant preparation steps — unwindowed: ${stepDispatchCandidates(store, ws).length}; within 48 h: ${stepDispatchCandidates(store, ws, soon).length}`);
console.log(`assistant whole errands — unwindowed: ${dispatchCandidates(store, ws).length}; within 48 h: ${dispatchCandidates(store, ws, soon).length}`);

// What the last seven days spent on work that never started.
const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
const started = new Set(store.listExecutions(ws).map((execution) => execution.workOrderId));
const tutorialsBuilt = store.listEvents(ws, { type: "manualbook.built" }).filter((event) => event.createdAt >= since);
const agentRuns = listAgentTasks(store, ws).filter((task) => task.requestedAt >= since);
console.log(`last 7 days: ${tutorialsBuilt.length} manuals built, ${tutorialsBuilt.filter((event) => !started.has(event.entityId)).length} for work never started; `
  + `${agentRuns.length} assistant runs, ${agentRuns.filter((task) => !started.has(task.workOrderId)).length} for work never started`);
store.close();
process.exit(0);
