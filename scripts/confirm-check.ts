/**
 * The completion check on the person's real ECE work (docs/loop-and-scout.md §3, plan task 3.9), on a **copy** of the live ledger:
 * the scheduler places a real ECE task's step, the nudge pass holds the block in its commit window, sees it under way and asks once it
 * has ended; the worker's notify pass shows that question as a real desktop notification; answering 「超出预估 · 30 分钟」 writes a
 * closed session and finishes the step; confirming a task's last step submits the task and leaves a one-tap duration observation.
 * Nothing is mocked. The copy's phone subscriptions are removed, so no phone is notified; only the confirm question reaches the desktop.
 *
 *   pnpm exec tsx scripts/confirm-check.ts
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-confirm-check-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";
// The greedy plan only: the background solve would re-place blocks between the steps of this check.
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { loadCurrentPlan, toZonedInstant, effectiveSchedulePreferences } = await import("../apps/web/lib/crossline");
const { nudgesFor } = await import("../apps/web/lib/nudges");
const { confirmBlock, confirmView } = await import("../apps/web/lib/confirm");
const { notifyPass } = await import("../apps/worker/src/notify");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).some((order) => /ECE/i.test(order.intent + order.projectId)))!;
const ws = workspace.id;
const principalId = store.getWorkspaceOwnerId(ws)!;
const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "confirm-check", subject: principalId },
  authMethod: "session", requestId: "confirm-check" } as import("../packages/core/src/index").AccessContext;
store.setSetting(ws, "push.subscriptions", "[]");
const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
const ece = (orderId: string) => { const order = store.listWorkOrders(ws).find((item) => item.id === orderId); return Boolean(order && /ECE/i.test(order.intent + order.projectId)); };
const instant = (day: string, clock: string) => toZonedInstant(day, clock, zone);
const shift = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000);
const at = (date: Date) => { process.env.CROSSLINE_FIXED_NOW = date.toISOString(); return date; };
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(label); };

/** The next ECE block from `from` on whose step passes `pick`, re-solved at its own commit window as the two-minute pass would see it. */
async function nextBlock(from: Date, pick: (block: { id: string }) => boolean) {
  let cursor = from;
  for (let tries = 0; tries < 6; tries++) {
    at(cursor);
    const plan = await loadCurrentPlan(ctx);
    const block = plan.blocks.filter((item) => item.id.startsWith("scheduled:") && item.day && ece(item.id.split(":")[1]!) && pick(item))
      .map((item) => ({ ...item, startAt: instant(item.day!, item.start) })).filter((item) => Date.parse(item.startAt) > cursor.getTime())
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    if (!block) return undefined;
    const window = shift(block.startAt, -10);
    if (window.getTime() <= cursor.getTime()) return block;
    cursor = window;
  }
  return undefined;
}

/** Commit window, under way, after the end: the confirm message the pass writes for this block. */
async function askAbout(block: { id: string; day?: string; start: string; end: string; startAt: string }) {
  await nudgesFor(ctx, at(shift(block.startAt, -10)));
  const plan = await loadCurrentPlan(ctx);
  const held = plan.blocks.find((item) => item.id === block.id)!;
  await nudgesFor(ctx, at(shift(instant(held.day!, held.start), 1)));
  const after = at(shift(instant(held.day!, held.end), 2));
  const said = await nudgesFor(ctx, after);
  const message = store.listRecentNudges(ws, shift(after.toISOString(), -60).toISOString())
    .find((item) => (item.payload.nudge as { kind?: string; block?: { id: string } }).kind === "block_confirm"
      && (item.payload.nudge as { block?: { id: string } }).block?.id === block.id);
  return { held, after, said, message };
}

const lastPlanned = (orderId: string, stepId: string) => (store.getStepPlan(ws, orderId)?.steps ?? [])
  .every((step) => step.id === stepId || step.status === "done" || step.status === "skipped");

// 1. A step that is not the task's last.
const now = new Date();
const first = await nextBlock(now, (block) => { const [, orderId, stepId] = block.id.split(":"); return Boolean(stepId) && !lastPlanned(orderId!, stepId!); });
check("a real ECE step is scheduled", Boolean(first), first ? `${first.title} ${first.day} ${first.start}–${first.end}` : "none in the next days");
if (first) {
  const { held, after, said, message } = await askAbout(first);
  check("the commit window held the block at its time", held.start === first.start, `${first.start} → ${held.start}`);
  check("the pass asked once after it ended", said.some((item) => item.kind === "block_confirm") && Boolean(message));
  if (message) {
    check("the question waits for the desktop and phone", (message.payload.nudge as { delivery?: string }).delivery === "pending");
    // Only this question goes out: the other nudges the pass wrote into the copy are marked sent, and the brief is off.
    for (const other of store.listRecentNudges(ws, shift(after.toISOString(), -24 * 60).toISOString()))
      if (other.id !== message.id && (other.payload.nudge as { delivery?: string }).delivery === "pending")
        store.updateConversationPayload(ws, other.id, { ...other.payload, nudge: { ...(other.payload.nudge as object), delivery: "pushed" } });
    const level = store.getSetting(ws, "notify.level") ?? "normal";
    store.setSetting(ws, "notify.level", "off");
    const delivered = await notifyPass(store, ws, shift(after.toISOString(), 1));
    store.setSetting(ws, "notify.level", level);
    check("the desktop showed it once", delivered.some((key) => key.startsWith("nudge:confirm:")), delivered.join(", "));
    const view = confirmView(ctx, message.id)!;
    const before = store.listExecutions(ws, view.orderId).length;
    const outcome = confirmBlock(ctx, message.id, { kind: "over", minutes: 30 });
    const sessions = store.listExecutions(ws, view.orderId);
    const step = store.getStepPlan(ws, view.orderId)?.steps.find((item) => item.id === held.id.split(":")[2]);
    check("「超出预估 · 30 分钟」 wrote one closed session", outcome.ok && sessions.length === before + 1 && sessions.at(-1)!.outcome === "confirmed",
      JSON.stringify(outcome));
    check("the step is done", step?.status === "done", step?.title ?? "");
  }
}

// 2. The last step of a task.
const fromLast = new Date(Date.parse(process.env.CROSSLINE_FIXED_NOW ?? now.toISOString()) + 60_000);
const last = await nextBlock(fromLast, (block) => { const [, orderId, stepId] = block.id.split(":"); return Boolean(stepId) && lastPlanned(orderId!, stepId!); });
check("a real ECE task's last step is scheduled", Boolean(last), last ? `${last.title} ${last.day} ${last.start}–${last.end}` : "none");
if (last) {
  const { message } = await askAbout(last);
  check("the pass asked about the last step", Boolean(message));
  if (message) {
    const orderId = last.id.split(":")[1]!;
    const outcome = confirmBlock(ctx, message.id, { kind: "as_planned" });
    const order = store.listWorkOrders(ws).find((item) => item.id === orderId)!;
    const observation = store.listAllDurationObservations(ws).find((row) => row.workOrderId === orderId);
    check("confirming it submitted the task", outcome.ok && ["evidence_review", "accepted"].includes(order.state), `${order.state} ${JSON.stringify(outcome)}`);
    check("a one-tap duration observation was written", observation?.actualSource === "one_tap", observation ? `${observation.observedMinutes} min` : "none");
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
store.close();
process.exit(failures.length ? 1 : 0);
