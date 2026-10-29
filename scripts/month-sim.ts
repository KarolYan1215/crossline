/**
 * A month of the owner using Crossline, fast-forwarded on a **copy** of the local ledger (docs/reports/2026-10-30-overnight/month-sim.md).
 *
 * The person is a small Markov decision agent (state: clock, energy, sleep debt, backlog, deadline pressure, trust in and fatigue with
 * the app; actions: open the app or not, start or skip a block, say done / partial / not done, answer / snooze / ignore a decision,
 * capture, commit the week). The app is the real code: every simulated minute sets `CROSSLINE_FIXED_NOW` and calls the same functions the
 * pages, the two-minute nudge pass, the ten-minute attention pass and the worker's daily rule passes call. No model runs — no Codex, no
 * provider; captures stay captures. Nothing leaves the process: `fetch` is replaced by a refusal and the supervisor URL points nowhere.
 *
 *   pnpm exec tsx scripts/month-sim.ts --strategy diligent|procrastinator|overloaded [--days 30] [--seed 7] [--start 2026-10-29]
 *     [--source <ledger>] [--out <file.json>]
 *
 * `--source` defaults to the main checkout's `data/crossline.db`, read through SQLite's online backup only (never opened for writing).
 */
import { register } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");

// ── the clock: everything in this process reads the simulated instant ──────────────────────────────────────────────────────────────
// The store stamps events, messages and sessions with `new Date()`, and the rules read those stamps (recent nudges, snoozes, the last own
// action). Pinning `CROSSLINE_FIXED_NOW` alone would leave a month of simulated actions all stamped tonight, so `Date` follows the
// simulation the way fake timers do (`now()` and an argument-less constructor; everything else is the real Date).
const RealDate = Date;
let simNow = RealDate.now();
class SimDate extends RealDate {
  constructor(...input: unknown[]) { if (input.length === 0) super(simNow); else super(...(input as [string])); }
  static override now() { return simNow; }
}
globalThis.Date = SimDate as DateConstructor;
const wall = () => performance.now();

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
type Strategy = "diligent" | "procrastinator" | "overloaded";
const strategy = (args.get("strategy") ?? "diligent") as Strategy;
const DAYS = Number(args.get("days") ?? 30);
const SEED = Number(args.get("seed") ?? 7);
const START = args.get("start") ?? "2026-10-29";
const source = args.get("source") ?? "C:/Users/karol/Documents/ChatGPT/Multi-ID/data/crossline.db";
const out = args.get("out") ?? path.join(tmpdir(), `month-sim-${strategy}.json`);

// ── isolation: a copy, no network, no supervisor, no publishing, no background solve ─────────────────────────────────────────────────
const dataDir = mkdtempSync(path.join(tmpdir(), `crossline-month-sim-${strategy}-`));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(source, { readonly: true, fileMustExist: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";
process.env.CROSSLINE_CODEX_SUPERVISOR_URL = "http://127.0.0.1:9";
let refusedFetches = 0;
globalThis.fetch = (async () => { refusedFetches += 1; throw new Error("MONTH_SIM_NO_NETWORK"); }) as typeof fetch;

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const web = await import("../apps/web/lib/crossline");
const { loadTimeline } = await import("../apps/web/lib/timeline");
const { collectAsks, loadAsks, answerAsk, snoozeAsk } = await import("../apps/web/lib/asks");
const { loadReminders, unplacedTasks } = await import("../apps/web/lib/reminders");
const { countPending } = await import("../apps/web/lib/pending");
const { nudgesFor } = await import("../apps/web/lib/nudges");
const { attentionPass } = await import("../apps/web/lib/attention");
const { confirmBlock } = await import("../apps/web/lib/confirm");
const { loadWrap, answerWrapBlock, finishWrap } = await import("../apps/web/lib/wrap");
const { answerAllPlan, runAnswerAll } = await import("../apps/web/lib/answer-all");
const { loadWeeklyCommit } = await import("../apps/web/lib/weekly-commit");
const { returnDue, returnView, answerReturn, dismissReturn } = await import("../apps/web/lib/return");
const { dateAdvancePass } = await import("../apps/worker/src/date-advance");
const { returnTidy } = await import("../apps/worker/src/return-tidy");
const { dedupePass } = await import("../apps/worker/src/dedupe");
const { materializeDatePairs, releaseWaits } = await import("../apps/worker/src/date-pairs");
const { autoApproveEligible } = await import("../apps/worker/src/auto-approval");
const { requestFinerSplits } = await import("../apps/worker/src/step-planner");
const { prepareMaterialsAhead } = await import("../apps/worker/src/manualbook");
// Optional, so the same script also runs on the code from before these existed (the before/after comparison of closed-loop-1030).
type Measured = typeof import("../apps/web/lib/measured-capacity");
const { measuredView, dayCapacityOf, measuredCapacityOn } = await import("../apps/web/lib/measured-capacity").catch(() => ({})) as Partial<Measured>;
const { AUTO_CLOSED_EVENT = "work_order.auto_closed" } = await import("../apps/web/lib/auto-close").catch(() => ({})) as { AUTO_CLOSED_EVENT?: string };
const { taskTitleOf, onPersonsBoard, bulkDoneRows } = await import("../packages/core/src/index");
const { openNeedsOf } = await import("../packages/db/src/index");

const workspace = store.listWorkspaces().map((item) => ({ item, n: store.listWorkOrders(item.id).length })).sort((a, b) => b.n - a.n)[0]!.item;
const ws = workspace.id;
const principalId = store.getWorkspaceOwnerId(ws)!;
const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "month-sim", subject: principalId },
  authMethod: "session", requestId: "month-sim" } as import("../packages/core/src/index").AccessContext;
// Nothing reaches the phone or the desktop: the copy's push devices go, and the worker's notify pass is never called.
store.setSetting(ws, "push.subscriptions", "[]");
const zone = web.effectiveSchedulePreferences(ctx).preferences.timeZone;
const instant = (day: string, clock: string) => new Date(web.toZonedInstant(day, clock, zone));
const at = (date: Date) => { simNow = date.getTime(); process.env.CROSSLINE_FIXED_NOW = date.toISOString(); return date; };
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

// ── randomness ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let rngState = (SEED * 2654435761 + ["diligent", "procrastinator", "overloaded"].indexOf(strategy) * 97) >>> 0;
const rand = () => { rngState = (rngState + 0x6D2B79F5) >>> 0; let t = rngState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * rand());
const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ── the person ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Priors, each with its source (see the report §2):
 * - actual/estimate ~ lognormal(ln 1.3, 0.4): planning fallacy (Buehler, Griffin & Ross 1994; Roy, Christenfeld & McKenzie 2005).
 * - start propensity rises as the deadline nears, hyperbolically: temporal motivation theory (Steel 2007), present bias β (Laibson 1997;
 *   O'Donoghue & Rabin 1999).
 * - a concrete first move raises starting: implementation intentions, d≈0.65 (Gollwitzer & Sheeran 2006).
 * - a switch between unrelated tasks costs ~10–20% of the next block: attention residue (Leroy 2009), switch costs (Monsell 2003).
 * - unfamiliar work without guidance starts less and runs longer; for familiar work extra guidance costs reading time: cognitive load and
 *   the expertise-reversal effect (Sweller 1988; Kalyuga et al. 2003).
 * - each interruption costs resumption time (~23 min to get back to the same task in the field: Mark, Gudith & Klocke 2008); we charge
 *   reading/decision seconds only, not the full resumption, to stay conservative.
 * - sleep: the person says they rise late and work 09–12, 14–18, 19:30–23; sleep need 8 h; debt lowers energy (Van Dongen et al. 2003).
 * Ego depletion is not used (failed multi-lab replication, Hagger et al. 2016).
 */
const PERSONA = {
  diligent:       { openBase: 0.95, startBias: 0.9,  adherence: 0.95, presentBias: 1.0, askBudgetS: 300, wrapProb: 0.9,  bulkDoneWhenTired: 0,   captureRate: 1.0, bed: 24 * 60 + 30, sleepH: 7.7, honest: 1 },
  procrastinator: { openBase: 0.55, startBias: -0.3, adherence: 0.7,  presentBias: 0.6, askBudgetS: 90,  wrapProb: 0.35, bulkDoneWhenTired: 0.2, captureRate: 0.6, bed: 25 * 60 + 15, sleepH: 7.2, honest: 0.9 },
  overloaded:     { openBase: 0.85, startBias: 0.4,  adherence: 0.85, presentBias: 0.8, askBudgetS: 150, wrapProb: 0.7,  bulkDoneWhenTired: 0.35, captureRate: 2.0, bed: 25 * 60 + 45, sleepH: 6.3, honest: 0.85 }
}[strategy];

/** How far each line's work is from what the person already knows (0 = home ground, 1 = new field). From the profile, kept coarse. */
function domainDistance(order: { identityId: string; intent: string; projectId: string }): number {
  const text = `${order.intent} ${order.projectId}`;
  if (/548|器件|device|MoS|忆阻|半导体物理|能带/i.test(text)) return 0.75;
  if (/555|SRAM|Cadence|电路|circuit|版图/i.test(text)) return 0.65;
  if (order.identityId === "startup") return 0.2;
  if (order.identityId === "media") return 0.45;
  if (order.identityId === "investment") return 0.55;
  if (/replay|episodic|神经|brain|reward/i.test(text)) return 0.3;
  return 0.5;
}

type Truth = { required: number; progress: number; distance: number };
const truth = new Map<string, Truth>();
const keyOfBlock = (blockId: string) => { const [, order, step] = blockId.split(":"); return /^v\d+s\d+$/.test(step ?? "") ? `${order}#${step}` : order!; };

const state = { trust: 0.6, fatigue: 0, sleepDebtH: 0.5, lastWorkedOrder: "", lastWorkedEnd: 0, absentUntil: "",
  /** The wrap-up page's 「明天的前三块」 as shown last night: kept the next morning? */
  promise: [] as Array<{ key: string; day: string; start: string }> };

function energyAt(minute: number): number {
  // Persona's own words: 09–12 high, after lunch a dip, evening high again until 23:00; sleep debt subtracts (≈4%/h, capped).
  const base = minute < 9 * 60 ? 0.45 : minute < 12 * 60 ? 0.8 : minute < 14 * 60 ? 0.55 : minute < 15 * 60 ? 0.6 : minute < 18 * 60 ? 0.7
    : minute < 19 * 60 + 30 ? 0.6 : minute < 23 * 60 ? 0.72 : 0.5;
  return clamp(base - 0.04 * state.sleepDebtH, 0.15, 1);
}

// ── metrics ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type DayRow = Record<string, number | string | boolean | null>;
const daysOut: DayRow[] = [];
const events: Array<{ day: string; at: string; kind: string; detail: string }> = [];
const note = (day: string, when: Date, kind: string, detail: string) => events.push({ day, at: when.toISOString(), kind, detail });
const askCost = (ask: { why: string; options: Array<{ fields?: Array<{ required: boolean }>; needsNote?: boolean }>; title: string }) =>
  5 + (ask.title.length + ask.why.length) / 12 + 2 * ask.options.length
  + 15 * (ask.options.find((option) => (option as { recommended?: boolean }).recommended)?.fields?.filter((field) => field.required).length ?? 0);
let previousStarts = new Map<string, string>();

function blockStarts(blocks: Array<{ id: string; day?: string; start: string }>, today: string): Map<string, string> {
  const outMap = new Map<string, string>();
  for (const block of blocks.filter((item) => item.id.startsWith("scheduled:") && item.day && item.day >= today && item.day <= addDays(today, 6))
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))) {
    const key = keyOfBlock(block.id);
    if (!outMap.has(key)) outMap.set(key, `${block.day} ${block.start}`);
  }
  return outMap;
}

function gatedViolations(blocks: Array<{ id: string; day?: string }>, today: string): { violations: number; checked: number; detail: string[] } {
  const waiting = store.listWaitingItems(ws, { state: "open" });
  const blockedOrders = new Set(waiting.filter((item) => item.followUpAt > today || item.expectedAt > today).flatMap((item) => item.blocks));
  let violations = 0, checked = 0;
  const detail: string[] = [];
  for (const block of blocks.filter((item) => item.id.startsWith("scheduled:") && item.day === today)) {
    checked += 1;
    const [, orderId, stepId] = block.id.split(":");
    const plan = store.getStepPlan(ws, orderId!);
    const step = plan?.steps.find((item) => item.id === stepId);
    const waitBefore = step && plan!.steps.some((other) => other.status === "planned" && other.role === "wait" && step.dependsOn.includes(other.id));
    const needs = step && plan ? openNeedsOf(plan, step).length : 0;
    if (blockedOrders.has(orderId!) || (step && !step.schedulable) || waitBefore || needs) { violations += 1; detail.push(`${block.id} ${step?.title ?? ""}`); }
  }
  return { violations, checked, detail };
}

// ── the app's daily rule passes (the worker's, without any model) ─────────────────────────────────────────────────────────────────────
async function workerPasses(now: Date, today: string) {
  at(now);
  const tidy = await returnTidy(store, ws, { now }).catch((error: unknown) => { note(today, now, "error", `returnTidy ${String(error)}`); return undefined; });
  if (tidy) note(today, now, "return_tidy", JSON.stringify({ moved: (tidy as { moved?: unknown[] }).moved?.length, archived: (tidy as { archived?: unknown[] }).archived?.length }));
  let advance: unknown;
  try { advance = dateAdvancePass(store, ws, { now }); } catch (error) { note(today, now, "error", `dateAdvance ${String(error)}`); }
  if (advance) note(today, now, "date_advance", JSON.stringify(advance).slice(0, 400));
  const merged = await dedupePass({ store, workspaceId: ws, cwd: dataDir, client: () => undefined, spend: async () => ({}) as never, paused: () => false,
    enterUsage: () => undefined, now }).catch((error: unknown) => { note(today, now, "error", `dedupe ${String(error)}`); return []; });
  if (merged.length) note(today, now, "dedupe", merged.map((item) => item.merged).join(" | "));
  try { const pairs = materializeDatePairs(store, ws, now); if (pairs.length) note(today, now, "date_pairs", pairs.join(",")); } catch (error) { note(today, now, "error", `datePairs ${String(error)}`); }
  try { releaseWaits(store, ws); } catch (error) { note(today, now, "error", `releaseWaits ${String(error)}`); }
  try { const approved = autoApproveEligible(store, ws, undefined, now); if (approved.length) note(today, now, "auto_approved", approved.join(",")); } catch (error) { note(today, now, "error", `autoApprove ${String(error)}`); }
  try { requestFinerSplits(store, ws, now); } catch (error) { note(today, now, "error", `finerSplits ${String(error)}`); }
  // Materials for work starting within a day (closed-loop-1030 §5): a rule pass, no model.
  if (typeof prepareMaterialsAhead === "function") try { const moved = prepareMaterialsAhead(store, ws, now); if (moved.length) note(today, now, "materials_ahead", moved.join(",")); } catch (error) { note(today, now, "error", `materialsAhead ${String(error)}`); }
  if (!STAND_INS) return;
  // Stand-ins for what a model or another person does in the real system (no model runs here; rates assumed, report §3.4): the assistant's
  // preparation steps finish (0.8 a day once ready), someone else's reply arrives (a wait step, 0.2 a day), the person hands over material
  // they hold (a provide step, 0.3 a day), the worker prepares a task's materials (0.9 a day).
  try {
    for (const plan of store.listStepPlans(ws)) {
      const order = store.getWorkOrder(ws, plan.workOrderId);
      if (!order || !["approved", "preparing", "ready_for_human", "active"].includes(order.state)) continue;
      const done = new Set(plan.steps.filter((step) => step.status !== "planned").map((step) => step.id));
      for (const step of plan.steps.filter((item) => item.status === "planned" && item.dependsOn.every((dep) => done.has(dep)))) {
        const kind = step.executor === "agent" ? "agent" : step.role === "wait" ? "wait" : step.provides ? "provide" : "";
        if (!kind || rand() >= { agent: 0.8, wait: 0.2, provide: 0.3 }[kind]) continue;
        store.updateStepProgress(ws, order.id, step.id, { status: "done" }, principalId, kind === "agent" ? "agent" : "person");
        standIns[kind] += 1;
      }
    }
    for (const order of store.listWorkOrders(ws).filter((item) => item.state === "preparing"))
      if (rand() < 0.9 && web.markMaterialsReady(ctx, order.id, "ai").ok) standIns.materials += 1;
  } catch (error) { note(today, now, "error", `standIns ${String(error)}`); }
}
const STAND_INS = args.get("stand-ins") !== "off";
/** The first day each deadline was warned about: `m:<milestone>` a risk card, `o:<order>` a 「来不及」 message (closed-loop-1030 §4). */
const firstWarned = new Map<string, string>();
const standIns = { agent: 0, wait: 0, provide: 0, materials: 0 };

// ── one session of the person looking at the app ───────────────────────────────────────────────────────────────────────────────────
async function openApp(now: Date, today: string, row: DayRow, reason: string) {
  at(now);
  row.opens = Number(row.opens ?? 0) + 1;
  // Coming back after two days or more: the return page comes first.
  const back = returnDue(ctx, now);
  if (back) {
    const view = returnView(ctx, back.since, now, back.until);
    row.returnItems = view.items.length;
    note(today, now, "return_page", `${view.daysAway}d away, ${view.items.length} items`);
    if (rand() < (strategy === "diligent" ? 0.9 : 0.5)) {
      for (const item of view.items) {
        const known = truth.get(item.stepId ? `${item.orderId}#${item.stepId}` : item.orderId);
        const verdict = known && known.progress >= known.required ? "done" : known && known.progress > 0 ? "partial" : "rolled";
        answerReturn(ctx, item.orderId, verdict as "done", item.stepId ? { stepId: item.stepId, ...(verdict === "partial" ? { stepIds: [] } : {}) } : {}, now);
      }
      row.decisionS = Number(row.decisionS ?? 0) + 4 * view.items.length + 10;
      row.decisions = Number(row.decisions ?? 0) + view.items.length;
    } else { dismissReturn(ctx, back.since); row.decisionS = Number(row.decisionS ?? 0) + 3; }
  }
  // What Today shows: the day's timeline, next steps, the decisions stack, reminders.
  const dashboard = await web.loadDashboard(ctx);
  const plan = await web.loadCurrentPlan(ctx);
  const timeline = await loadTimeline(ctx, plan);
  const all = await loadAsks(ctx, now);
  // Today's 待决 card (apps/web/app/today/needs-card.tsx `needRows`): this week's, not 「later」, now first, at most four.
  const week = all.filter((ask) => !ask.entersOn);
  const urgentWeek = week.filter((ask) => ask.kind !== "missed_block" && ask.urgency !== "later");
  const asks = [...urgentWeek.filter((ask) => ask.urgency === "now"), ...urgentWeek.filter((ask) => ask.urgency !== "now")].slice(0, 4);
  const reminders = (() => { try { return loadReminders(ctx, plan, timeline.items, asks); } catch { return []; } })();
  const todayItems = timeline.items.filter((item) => item.day === today);
  const next = (dashboard as { nextActions?: Array<{ title?: string; reason?: string }> }).nextActions ?? [];
  if (reason === "morning") {
    row.todayTimelineItems = todayItems.length;
    row.todayNextCards = next.length;
    row.todayAsks = asks.length; row.weekAsks = week.length; row.laterAsks = all.length - week.length;
    row.todayReminders = reminders.length;
    const chars = todayItems.reduce((sum, item) => sum + String((item as { title?: string }).title ?? "").length, 0)
      + next.slice(0, 3).reduce((sum, item) => sum + String(item.title ?? "").length + String(item.reason ?? "").length, 0)
      + asks.slice(0, 3).reduce((sum, ask) => sum + ask.title.length + ask.why.length, 0)
      + reminders.reduce((sum, item) => sum + JSON.stringify(item).length / 3, 0);
    row.todayChars = Math.round(chars);
    row.askKinds = [...new Set(week.map((ask) => ask.kind))].join(",");
  }
  await handleAsks(now, today, row, asks);
  // 待确认 (「每天一次」 in scenarios.md): every one of this week's decisions, on the person's own rhythm.
  const visit = { diligent: 1, procrastinator: 0.15, overloaded: 0.5 }[strategy];
  if (reason === "morning" && rand() < visit) {
    row.approvalsVisit = true;
    await handleAsks(now, today, row, (await loadAsks(ctx, now)).filter((ask) => !ask.entersOn), true);
  }
}

async function handleAsks(now: Date, today: string, row: DayRow, asks: Awaited<ReturnType<typeof loadAsks>>, approvalsPage = false) {
  let budget = PERSONA.askBudgetS * (1 - 0.5 * state.fatigue);
  // The overloaded person reaches for 「全部按推荐」 first (it is on 待确认 and the wrap-up).
  if (approvalsPage && strategy === "overloaded" && rand() < 0.7) {
    const plan = answerAllPlan(ctx, now);
    if (plan.asks.length + plan.results.length + plan.proposals.length > 0) {
      const done = await runAnswerAll(ctx, now).catch(() => undefined);
      if (done) { row.answerAllDone = Number(row.answerAllDone ?? 0) + done.done; row.decisions = Number(row.decisions ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + 12; budget -= 12; }
      asks = (await loadAsks(ctx, now)).filter((ask) => !ask.entersOn);
    }
  }
  const weight = { now: 3, soon: 1.5, later: 0.5 } as const;
  for (const ask of asks) {
    const cost = askCost(ask);
    const value = weight[ask.urgency] * (ask.important ? 2 : 1) * (0.5 + state.trust) * PERSONA.presentBias * 20;
    const recommended = ask.options.find((option) => option.recommended && !option.href && !option.needsNote)
      ?? ask.options.find((option) => !option.href && !option.needsNote);
    if (!recommended || cost > budget || value < cost) {
      // Best response when answering costs more than it is worth: put it off (cheap) or leave it.
      if (budget > 3 && rand() < (strategy === "procrastinator" ? 0.6 : 0.4)) {
        snoozeAsk(ctx, ask.id, rand() < 0.7 ? "tomorrow" : "week", now, 3);
        row.snoozed = Number(row.snoozed ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + 3; budget -= 3;
      } else row.ignored = Number(row.ignored ?? 0) + 1;
      continue;
    }
    const values: Record<string, string> = {};
    for (const field of recommended.fields ?? []) if (field.required) values[field.id] = field.initial || (field.kind === "date" ? addDays(today, 3) : "按建议");
    const result = await answerAsk(ctx, ask.id, { optionIds: [recommended.id], seconds: Math.round(cost) }, values, now).catch((error: unknown) => ({ ok: false, code: String(error) }));
    budget -= cost;
    row.decisions = Number(row.decisions ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + Math.round(cost);
    if (!result.ok) { row.askErrors = Number(row.askErrors ?? 0) + 1; note(today, now, "ask_error", `${ask.kind} ${ask.id} → ${(result as { code?: string }).code}`); }
    else row[`ans_${ask.kind}`] = Number(row[`ans_${ask.kind}`] ?? 0) + 1;
  }
  state.fatigue = clamp(state.fatigue + Math.max(0, (Number(row.decisionS ?? 0) - 240) / 1200), 0, 1);
}

// ── one simulated day ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Started = { blockId: string; orderId: string; start: string; end: string; worked: number; outcome?: "done" | "partial" | "not_done";
  /** When the timer started (an instant): it runs for the minutes really worked, not the whole block (closed-loop-1030, second round). */
  timerFrom: number };
const startedAll: Started[] = [];
const acceptedBefore = new Set(store.listWorkOrders(ws).filter((order) => order.state === "accepted").map((order) => order.id));
const dueAtStart = new Map<string, string>();
for (const order of store.listWorkOrders(ws)) {
  if (!["approved", "preparing", "ready_for_human", "active", "evidence_review", "awaiting_plan_approval"].includes(order.state) || !onPersonsBoard(order)) continue;
  const due = (order.payload as { dueDate?: string }).dueDate || (order.milestoneId ? web.milestoneDeadline(ctx, order.milestoneId) : undefined);
  if (due) dueAtStart.set(order.id, due);
}

async function simulateDay(index: number, today: string) {
  const row: DayRow = { day: today, weekday: weekdayOf(today) };
  // Sleep last night.
  const slept = PERSONA.sleepH + 0.6 * normal() - (weekdayOf(today) === 1 && strategy === "overloaded" ? 0.7 : 0);
  state.sleepDebtH = clamp(state.sleepDebtH * 0.85 + (8 - slept), 0, 12);
  row.sleptH = Math.round(slept * 10) / 10; row.sleepDebtH = Math.round(state.sleepDebtH * 10) / 10;
  const wake = clamp(Math.round(PERSONA.bed - 24 * 60 + slept * 60), 7 * 60, 11 * 60);

  await workerPasses(instant(today, "04:00"), today);
  await attentionPass(at(instant(today, "06:00")));

  // Does the person use the app today? (absence streaks are what the procrastinator does)
  const pOpen = clamp(PERSONA.openBase * (0.5 + state.trust) * (1 - 0.5 * state.fatigue), 0.05, 0.99);
  const absent = state.absentUntil && today <= state.absentUntil;
  const opens = !absent && rand() < pOpen;
  if (!opens && strategy === "procrastinator" && !absent && rand() < 0.35) state.absentUntil = addDays(today, 1 + Math.floor(rand() * 3));
  row.usesApp = opens;
  const morning = instant(today, clockOf(wake + 20));
  if (opens) await openApp(morning, today, row, "morning").catch((error: unknown) => note(today, morning, "error", `openApp: ${String((error as Error)?.stack ?? error).slice(0, 400)}`));

  // Morning schedule snapshot for the metrics.
  at(morning);
  const plan0 = await web.loadCurrentPlan(ctx);
  const mine = plan0.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day === today);
  row.scheduledMin = mine.reduce((sum, block) => sum + minutesOf(block.end) - minutesOf(block.start), 0);
  const capacity = web.netCapacity(ctx, 1).capacity.find((day) => day.day === today);
  row.availableMin = Math.round(capacity?.netMinutes ?? 0);
  // The measured cap the plan is held to today (closed-loop-1030 §1), and its basis.
  if (measuredView && dayCapacityOf && measuredCapacityOn) try { const view = measuredView(ctx, morning); row.capMin = measuredCapacityOn() ? dayCapacityOf(ctx, today, Number(row.availableMin), view) : null; row.capBasis = view.basis; row.capFactor = (view as { factor?: { factor: number } }).factor?.factor ?? null; }
  catch (error) { note(today, morning, "error", `measured ${String(error)}`); }
  // Deadline warnings (closed-loop-1030 §4): the first morning each milestone at risk is on a card.
  try {
    for (const ask of collectAsks(ctx, morning)) {
      const ids = ask.kind === "milestone_risk" || ask.kind === "milestone_risk_review" ? [ask.entityId] : ask.kind === "risk_digest" ? (ask.items ?? []).map((item) => item.id.replace(/^risk(review)?:/, "")) : [];
      for (const id of ids) if (!firstWarned.has(`m:${id}`)) firstWarned.set(`m:${id}`, today);
    }
  } catch (error) { note(today, morning, "error", `warned ${String(error)}`); }
  row.feasibility = row.availableMin ? Math.round((Number(row.scheduledMin) / Number(row.availableMin)) * 100) / 100 : null;
  const unplaced = unplacedTasks(plan0); row.unplacedNone = unplaced.none; row.unplacedPartial = unplaced.partial;
  row.blocksToday = mine.length;
  row.distinctTasksToday = new Set(mine.map((block) => block.id.split(":")[1])).size;
  row.switchesToday = mine.slice(1).filter((block, i) => block.id.split(":")[1] !== mine[i]!.id.split(":")[1]).length;
  row.blocksUnder30 = mine.filter((block) => minutesOf(block.end) - minutesOf(block.start) < 30).length;
  const withStep = mine.filter((block) => /^v\d+s\d+$/.test(block.id.split(":")[2] ?? ""));
  row.firstActionCoverage = withStep.length ? Math.round(withStep.filter((block) => {
    const [, orderId, stepId] = block.id.split(":");
    return Boolean(store.getStepPlan(ws, orderId!)?.steps.find((step) => step.id === stepId)?.firstAction);
  }).length / withStep.length * 100) / 100 : null;
  row.blocksWithoutStepPlan = mine.length - withStep.length;
  // Point 2 of the brief: does each of today's steps say what goes in, what comes out, and where to start?
  const triple = withStep.map((block) => {
    const [, orderId, stepId] = block.id.split(":");
    const plan = store.getStepPlan(ws, orderId!);
    const step = plan?.steps.find((item) => item.id === stepId) as (Record<string, unknown> & { firstAction?: string; deliverable?: string; doneCriterion?: string; uses?: string[]; covers?: string[] }) | undefined;
    const input = Boolean(step?.uses?.length || step?.covers?.length || store.listSourceDocuments(ws, { projectId: store.getWorkOrder(ws, orderId!)?.projectId ?? "-" }).length > 0);
    return { first: Boolean(step?.firstAction), output: Boolean(step?.deliverable && step?.doneCriterion), input, tutorial: Boolean((step as { product?: string } | undefined)?.product === "ability"),
      distance: domainDistance(store.getWorkOrder(ws, orderId!) ?? { identityId: "", intent: "", projectId: "" }), firstLen: String(step?.firstAction ?? "").length };
  });
  row.stepsOutputKnown = triple.filter((item) => item.output).length; row.stepsInputKnown = triple.filter((item) => item.input).length;
  row.stepsAllThree = triple.filter((item) => item.first && item.output && item.input).length; row.stepsToday = triple.length;
  row.farSteps = triple.filter((item) => item.distance >= 0.6).length; row.farStepsAbility = triple.filter((item) => item.distance >= 0.6 && item.tutorial).length;
  row.firstActionLenMedian = triple.length ? triple.map((item) => item.firstLen).sort((a, b) => a - b)[Math.floor(triple.length / 2)]! : 0;
  const gate = gatedViolations(mine, today); row.gatedViolations = gate.violations;
  if (gate.violations) note(today, morning, "gated_violation", gate.detail.join(" | "));
  const starts = blockStarts(plan0.blocks, today);
  let moved = 0, compared = 0;
  for (const [key, startAt] of starts) { const before = previousStarts.get(key); if (before && before.slice(0, 10) >= today) { compared += 1; if (Math.abs((Date.parse(before.replace(" ", "T")) - Date.parse(startAt.replace(" ", "T"))) / 60_000) >= 15) moved += 1; } }
  row.churnMoved = moved; row.churnCompared = compared; previousStarts = starts;
  // Only blocks still ahead when the person looks (a block whose time passed while they slept is rightly moved).
  state.promise = state.promise.filter((promised) => promised.day === today && minutesOf(promised.start) >= wake + 20);
  if (state.promise.length) {
    const kept = state.promise.filter((promised) => mine.some((block) => keyOfBlock(block.id) === promised.key && Math.abs(minutesOf(block.start) - minutesOf(promised.start)) < 15));
    row.promiseShown = state.promise.length; row.promiseKept = kept.length;
    state.promise = [];
  }
  // Each task's first block in the coming week, for the stability analysis (report §4.1).
  row.firstStarts = JSON.stringify(Object.fromEntries([...starts].map(([key, value]) => [key, value.slice(5)])));
  const pending = countPending(ctx); row.pendingTotal = pending.total; row.pendingAsks = (pending as { asks?: number }).asks ?? null; row.pendingLater = (pending as { later?: number }).later ?? null;
  row.asksOpenAll = collectAsks(ctx, morning).length;
  // The weekly commitment's own numbers (what /commit would show this morning).
  try {
    const wc = loadWeeklyCommit(ctx, morning);
    row.wcWeek = wc.week; row.wcCapacity = wc.capacityMinutes; row.wcDemand = wc.demandMinutes; row.wcDue = wc.due ?? "";
    row.wcDefer = wc.rows.filter((item) => item.suggestion.group === "defer").length; row.wcDrop = wc.rows.filter((item) => item.suggestion.group === "drop").length;
    row.wcCommitted = wc.last?.week === wc.week;
  } catch (error) { note(today, morning, "error", `weeklyCommit ${String(error)}`); }
  // Steps the app would offer as the next move: how many open person steps carry a first action at all.
  const openPerson = store.listStepPlans(ws).filter((plan) => { const order = store.getWorkOrder(ws, plan.workOrderId); return order && ["approved", "ready_for_human", "active"].includes(order.state) && onPersonsBoard(order); })
    .flatMap((plan) => plan.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent"));
  row.openPersonSteps = openPerson.length; row.openPersonStepsWithFirstAction = openPerson.filter((step) => step.firstAction).length;
  row.captureBacklog = store.listCaptures(ws).filter((capture) => capture.state === "captured" || capture.state === "blocked").length;

  // The day, tick by tick: the two-minute nudge pass at the moments that matter, the person acting at the same moments.
  let minute = Math.max(wake + 21, 7 * 60);
  const end = 23 * 60 + 50;
  const decided = new Set<string>();
  const running = new Map<string, Started>();
  let nudges = 0, counted = 0, urgent = 0;
  const wrapAt = minutesOf((loadWrap(ctx, morning).at ?? "23:00"));
  let wrapped = false;
  const attentionAt = [12 * 60, 18 * 60];
  while (minute <= end) {
    let nextMinute = minute + 30;
    try {
    const now = at(instant(today, clockOf(minute)));
    if (attentionAt.length && minute >= attentionAt[0]!) { attentionAt.shift(); await attentionPass(now); }
    const planned = await nudgesFor(ctx, now).catch((error: unknown) => { note(today, now, "error", `nudges ${String(error)}`); return []; });
    nudges += planned.length; counted += planned.filter((item) => item.counted).length; urgent += planned.filter((item) => item.urgent).length;
    for (const item of planned) note(today, now, `nudge:${item.kind}`, item.text.slice(0, 120));
    for (const item of planned.filter((entry) => entry.kind === "latest_start")) {
      const orderId = item.fingerprint.split(":")[1] ?? "";
      if (!firstWarned.has(`o:${orderId}`)) firstWarned.set(`o:${orderId}`, today);
    }
    const plan = await web.loadCurrentPlan(ctx);
    const todays = plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day === today);
    const clock = clockOf(minute);
    // Blocks that end now: the person knows how it went.
    for (const [id, run] of running) if (minutesOf(run.end) <= minute) {
      const key = keyOfBlock(id);
      const real = truth.get(key)!;
      real.progress += run.worked;
      run.outcome = real.progress >= real.required ? "done" : run.worked > 0 ? "partial" : "not_done";
      state.lastWorkedOrder = run.orderId; state.lastWorkedEnd = minute;
      // The floating timer's 结束 is a pause (TimerFloat): the person presses it when the block is over.
      // The timer runs for what was really worked (block × adherence × energy), then the person stops it; it used to run to the block's
      // end, which made every started block read as fully worked (closed-loop-results.md, first round).
      web.pauseWorkOrderExecution(ctx, run.orderId, "块结束", new Date(Math.min(now.getTime(), run.timerFrom + run.worked * 60_000)).toISOString());
      running.delete(id);
    }
    // Blocks under way now: start or not.
    for (const block of todays.filter((item) => item.start <= clock && clock < item.end && !decided.has(item.id))) {
      decided.add(block.id);
      const [, orderId, stepId] = block.id.split(":");
      const order = store.getWorkOrder(ws, orderId!);
      if (!order) continue;
      const key = keyOfBlock(block.id);
      const step = stepId ? store.getStepPlan(ws, orderId!)?.steps.find((item) => item.id === stepId) : undefined;
      const distance = domainDistance(order);
      if (!truth.has(key)) {
        const p50 = step?.estimate.p50Minutes ?? order.estimate.p50Minutes;
        const guidance = step?.firstAction ? 0.15 : 0;
        truth.set(key, { required: Math.round(p50 * Math.exp(Math.log(1.3) + 0.4 * normal()) * (1 + 0.5 * distance - guidance)), progress: 0, distance });
      }
      const due = (order.payload as { dueDate?: string }).dueDate || (order.milestoneId ? web.milestoneDeadline(ctx, order.milestoneId) : undefined);
      const daysLeft = due ? Math.max(0, (Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : 30;
      const urgency = 1 / (1 + 0.5 * daysLeft); // hyperbolic (Steel 2007)
      const energy = energyAt(minute);
      const switching = state.lastWorkedOrder && state.lastWorkedOrder !== orderId && minute - state.lastWorkedEnd < 20 ? 1 : 0;
      const length = minutesOf(block.end) - minutesOf(block.start);
      const x = PERSONA.startBias + 2.2 * (energy - 0.6) + (step?.firstAction ? 0.6 : 0) - 1.2 * distance * (step?.firstAction ? 0.6 : 1)
        + 2.5 * urgency * (1 / PERSONA.presentBias) + 0.8 * (state.trust - 0.5) - 0.3 * switching - (length < 25 ? 0.3 : 0) + (opens ? 0.4 : -1.2);
      const p = logistic(x);
      const go = rand() < p;
      note(today, now, go ? "start" : "skip", `${taskTitleOf(order)} · ${step?.title ?? ""} p=${p.toFixed(2)} e=${energy.toFixed(2)} d=${distance}`);
      if (!go) { row.skipped = Number(row.skipped ?? 0) + 1; continue; }
      // Same task as a paused timer: 继续, as the floating timer offers; otherwise 开始计时.
      const paused = store.listExecutions(ws, orderId!).some((execution) => !execution.endedAt && execution.interruptions.some((pause) => !pause.resumedAt));
      const result = paused ? web.resumeWorkOrderExecution(ctx, orderId!, now.toISOString()) : web.startWorkOrderExecution(ctx, orderId!, now.toISOString());
      if (!result.ok) note(today, now, "start_refused", `${orderId} ${result.code}`);
      const worked = Math.round(length * PERSONA.adherence * (switching ? 0.85 : 1) * clamp(energy + 0.2, 0.5, 1.1));
      const run: Started = { blockId: block.id, orderId: orderId!, start: block.start, end: block.end, worked, timerFrom: now.getTime() };
      running.set(block.id, run); startedAll.push(run);
      row.started = Number(row.started ?? 0) + 1; row.workedMin = Number(row.workedMin ?? 0) + worked;
    }
    // A block's own completion question (only blocks due by tomorrow ask by themselves since 2026-10-28).
    for (const message of store.listRecentNudges(ws, new Date(now.getTime() - 90 * 60_000).toISOString())) {
      const nudge = message.payload.nudge as { kind?: string; block?: { id: string } } | undefined;
      if (nudge?.kind !== "block_confirm" || !nudge.block || message.payload.answeredBySim) continue;
      const run = startedAll.find((item) => item.blockId === nudge.block!.id && item.outcome);
      const attentive = rand() < (opens ? 0.8 : 0.3);
      store.updateConversationPayload(ws, message.id, { ...message.payload, answeredBySim: true });
      if (!attentive) continue;
      const outcome = run?.outcome ?? "not_done";
      const answer = outcome === "done" ? { kind: "as_planned" as const } : outcome === "partial" ? { kind: "partial" as const } : { kind: "not_done" as const };
      const result = confirmBlock(ctx, message.id, answer as never, now);
      row.confirmAnswered = Number(row.confirmAnswered ?? 0) + 1; row.decisions = Number(row.decisions ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + 6;
      if (!result.ok) note(today, now, "confirm_error", JSON.stringify(result));
    }
    // A capture now and then.
    if (rand() < PERSONA.captureRate / 10) {
      const lines = ["research", "startup", "media", "investment"];
      const line = lines[Math.floor(rand() * lines.length)]!;
      const title = { research: "看一下导师发的那篇 paper", startup: "Crossline 内测反馈整理", media: "小红书选题：研究生时间管理", investment: "看 NVDA 财报电话会纪要" }[line]!;
      web.addCapturedTaskWithId(ctx, { title }, `sim-cap-${today}-${minute}`, `sim-cap-${today}-${minute}`);
      row.captures = Number(row.captures ?? 0) + 1;
    }
    // The evening wrap-up.
    if (!wrapped && minute >= wrapAt) {
      wrapped = true;
      const view = loadWrap(ctx, now);
      row.wrapRows = view.rows.length; row.wrapOpenBefore = view.open;
      const tired = energyAt(minute) < 0.5 || state.fatigue > 0.5;
      if ((opens || rand() < 0.3) && rand() < PERSONA.wrapProb) {
        row.wrapped = true;
        const bulk = tired && rand() < PERSONA.bulkDoneWhenTired;
        // The one-tap button covers only what the app offers it for (bulkDoneRows: blocks worked in, under 70% as 部分); the rest a tired
        // person leaves open. Otherwise the rows come prefilled with the inference (closed-loop-1030 §2): the person changes the ones that
        // are wrong, one tap each, and takes the rest with 「推断都对」.
        const bulkRows = new Map(bulk ? bulkDoneRows(view.rows, {}).map((item) => [item.blockId, item.outcome]) : []);
        let acceptedInferred = 0;
        for (const r of view.rows.filter((item) => !item.answered)) {
          if (bulk && !bulkRows.has(r.blockId)) { row.wrapLeftOpen = Number(row.wrapLeftOpen ?? 0) + 1; continue; }
          const run = startedAll.find((item) => item.blockId === r.blockId);
          let outcome: "done" | "partial" | "not_done" = run?.outcome ?? (running.has(r.blockId) ? "partial" : "not_done");
          row.inferRows = Number(row.inferRows ?? 0) + 1;
          if (r.inferred === outcome) row.inferAgree = Number(row.inferAgree ?? 0) + 1;
          note(today, now, "wrap_row", `${r.inferred ?? "-"} truth=${outcome} work=${r.workMinutes ?? "-"} timed=${r.timedMinutes} ${r.start}-${r.end}`);
          if (bulk) { const given = bulkRows.get(r.blockId) ?? "done"; if (given === "done" && outcome !== "done") row.falseDone = Number(row.falseDone ?? 0) + 1; outcome = given; }
          else if (outcome !== "done" && rand() > PERSONA.honest) { row.falseDone = Number(row.falseDone ?? 0) + 1; outcome = "done"; }
          const inferredTaken = !bulk && r.inferred === outcome;
          const result = answerWrapBlock(ctx, r.blockId, outcome, now, undefined, inferredTaken ? { inferred: true } : {});
          if (!result.ok) note(today, now, "wrap_error", `${r.blockId} ${JSON.stringify(result)}`);
          if (inferredTaken) acceptedInferred += 1;
          else if (!bulk) { row.decisions = Number(row.decisions ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + 4; row.wrapTaps = Number(row.wrapTaps ?? 0) + 1; }
        }
        if (acceptedInferred) { row.decisions = Number(row.decisions ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + 3; row.allRight = Number(row.allRight ?? 0) + 1; row.wrapTaps = Number(row.wrapTaps ?? 0) + 1; }
        if (bulk) { row.decisions = Number(row.decisions ?? 0) + 1; row.decisionS = Number(row.decisionS ?? 0) + 3; row.bulkDone = true; row.wrapTaps = Number(row.wrapTaps ?? 0) + 1; }
        await finishWrap(ctx, now);
        // What the page showed as tomorrow's first three blocks (loadTimeline's next day, as `app/wrap/page.tsx` reads it).
        const later = await web.loadCurrentPlan(ctx);
        state.promise = later.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day === addDays(today, 1)).sort((a, b) => a.start.localeCompare(b.start))
          .slice(0, 3).map((block) => ({ key: keyOfBlock(block.id), day: block.day!, start: block.start }));
      }
    }
    // Next moment worth looking at: a block starting or ending, else half an hour on.
    const marks = todays.flatMap((block) => [minutesOf(block.start), minutesOf(block.end)]).filter((value) => value > minute).map((value) => value + 1);
    if (!wrapped && wrapAt > minute) marks.push(wrapAt);
    nextMinute = Math.min(minute + 30, ...marks);
    } catch (error) {
      // An app function throwing is itself a finding (a route would answer 500): recorded, and the day goes on.
      note(today, instant(today, clockOf(minute)), "error", `tick ${clockOf(minute)}: ${String((error as Error)?.stack ?? error).slice(0, 400)}`);
    }
    minute = nextMinute;
  }
  // Midday second look for the diligent and the overloaded.
  row.nudges = nudges; row.nudgesCounted = counted; row.nudgesUrgent = urgent;
  const pendingNight = countPending(ctx); row.pendingTotalNight = pendingNight.total;
  row.trust = Math.round(state.trust * 100) / 100; row.fatigue = Math.round(state.fatigue * 100) / 100;
  // Trust moves with whether the day's plan was workable and the app's cost (counted interruptions over 4, decision seconds over 4 minutes).
  const feasible = row.feasibility === null || Number(row.feasibility) <= 1;
  state.trust = clamp(state.trust + (feasible ? 0.02 : -0.03) - 0.01 * Math.max(0, counted - 4) - (moved > 5 ? 0.02 : 0) + (Number(row.started ?? 0) > 0 ? 0.01 : 0), 0.05, 0.95);
  state.fatigue = clamp(state.fatigue * 0.8, 0, 1);
  daysOut.push(row);
  console.log(`[${strategy}] ${today} opens=${row.usesApp} sched=${row.scheduledMin}/${row.availableMin} started=${row.started ?? 0} skipped=${row.skipped ?? 0} pending=${row.pendingTotal} asks=${row.asksOpenAll} nudges=${nudges}/${counted} dec=${row.decisions ?? 0}/${row.decisionS ?? 0}s trust=${row.trust}`);
}

const t0 = wall();
for (let index = 0; index < DAYS; index++) await simulateDay(index, addDays(START, index));

// ── deadlines and what the app believes vs what happened ───────────────────────────────────────────────────────────────────────────
const endDay = addDays(START, DAYS - 1);
const acceptedAt = new Map<string, string>();
for (const event of store.listEvents(ws, { type: "work_order.transitioned" })) {
  const payload = event.payload as { to?: string };
  if (payload.to === "accepted" && !acceptedAt.has(event.entityId)) acceptedAt.set(event.entityId, event.createdAt);
}
const deadlines = [...dueAtStart].filter(([, due]) => due <= endDay).map(([id, due]) => {
  const order = store.getWorkOrder(ws, id);
  const doneAt = acceptedBefore.has(id) ? undefined : acceptedAt.get(id);
  const finalDue = order ? ((order.payload as { dueDate?: string }).dueDate || (order.milestoneId ? web.milestoneDeadline(ctx, order.milestoneId) : undefined)) : undefined;
  const warned = [firstWarned.get(`o:${id}`), order?.milestoneId ? firstWarned.get(`m:${order.milestoneId}`) : undefined].filter((day): day is string => Boolean(day)).sort()[0] ?? null;
  return { id, title: order ? taskTitleOf(order) : id, line: order?.identityId, due, finalDue: finalDue ?? null, state: order?.state ?? "gone", warned,
    acceptedDay: doneAt ? new Date(doneAt).toLocaleDateString("sv-SE", { timeZone: zone }) : null,
    archivedBy: order?.state === "archived" ? (store.listEvents(ws, { type: "work_order.archived", entityId: id }).at(-1)?.payload as { reason?: string } | undefined)?.reason ?? "" : null };
});
const truthDone = [...truth.values()].filter((item) => item.progress >= item.required).length;
const result = { strategy, seed: SEED, start: START, days: DAYS, workspace: ws.slice(0, 8), runtimeS: Math.round((wall() - t0) / 1000), refusedFetches,
  persona: PERSONA, daysOut, deadlines, truth: { steps: truth.size, done: truthDone },
  started: startedAll.length, standIns: STAND_INS ? standIns : null, autoClosed: store.listEvents(ws, { type: AUTO_CLOSED_EVENT }).length,
  overdueAsked: store.listEvents(ws, { type: "task.overdue_resolved" }).length, events };
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`[${strategy}] wrote ${out} in ${result.runtimeS}s; refused fetches ${refusedFetches}`);
store.close();
process.exit(0);
