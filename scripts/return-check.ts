/**
 * R3 of docs/review-2026-10-13.md on a **copy** of the live ledger, nothing mocked: is the person due the return page, what it lists
 * (the work that had a time while they were away or whose due day passed), what it archives (untouched for fourteen days), and what
 * waits for a decision before and after the clean-up.
 *
 *   pnpm exec tsx scripts/return-check.ts
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-return-check-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { returnDue, returnView, cleanStale } = await import("../apps/web/lib/return");
const { countPending } = await import("../apps/web/lib/pending");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const ws = workspace.id;
const principalId = store.getWorkspaceOwnerId(ws)!;
const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "return-check", subject: principalId },
  authMethod: "session", requestId: "return-check" } as import("../packages/core/src/index").AccessContext;
const now = new Date();

const due = returnDue(ctx, now);
console.log(`return page due: ${due ? `yes, away since ${due.since}` : "no"}`);
const since = due?.since ?? store.lastPersonActivity(ws)!;
const view = returnView(ctx, since, now);
console.log(`away ${view.daysAway} days; tasks to settle: ${view.items.length}`);
for (const item of view.items.slice(0, 12))
  console.log(`  · ${item.title} [${item.lineLabel}] planned ${item.plannedDays.length} day(s)${item.dueDay ? `, due ${item.dueDay}` : ""}, ${item.steps.filter((step) => !step.done).length} open step(s)`);
console.log(`meanwhile: ${view.happened.assistantDone} assistant results, ${view.happened.calendarChanges} calendar changes, deadlines in 7 days: ${view.happened.deadlinesSoon.map((item) => `${item.title} ${item.deadline}`).join("; ") || "none"}`);
console.log(`untouched 14+ days: ${view.stale.orders.length} task proposals, ${view.stale.milestones.length} milestone drafts`);
const before = countPending(ctx);
const cleaned = cleanStale(ctx, now);
const after = countPending(ctx);
console.log(`archived: ${cleaned.orders.length} proposals, ${cleaned.milestones.length} drafts`);
console.log(`waiting for a decision: this week ${before.total} → ${after.total}; later ${before.later.total} → ${after.later.total}`);
store.close();
process.exit(0);
