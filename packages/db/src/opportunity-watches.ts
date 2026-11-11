import { randomUUID } from "node:crypto";
import {
  IGNORED_AFTER_DAYS, LESS_LOG_SETTING, OUTCOME_WEIGHT, SCOUT_NEED_PREFIX, SCOUT_STATS_SETTING, SCOUT_URGENT_DAYS, SCOUT_NEEDS_SETTING,
  WATCHES_SETTING, WATCH_TUNING_SETTING, addDays, bestRelevance, pushable, applyLess, emptyStats, exploreAccount, holdBack, mergeWatches, nextDeadline, prepStartFor, readLessLog,
  readNeeds, readScoutStats, readTuning, readWatches, retireCandidates, taskTitleOf, tFor, undoLess, watchFromNeed, weightedTokens, withOutcome,
  type LessEntry, type LessFeedback, type OpportunityOutcome, type StoredFormRun, type StoredWatch, type WatchTarget, type WatchTuning
} from "@crossline/core";
import type { CrosslineStore, StoredOpportunity } from "./index";
import { readFormRuns } from "./form-runs";
import { readLocale } from "./locale";
import { waitingIdForNeed } from "./opportunities";

/**
 * The opportunity agent's watches in the ledger (docs/opportunity-agent.md §17.2–17.4), shared by the worker that runs them and the web
 * that shows and edits them: the list itself (migrated once from `scout.needs`), the person's decisions and edits, the outcome ledger
 * that drives yield and retiring, 「少来」 with its undo, and which found opportunities may reach the person.
 */

const ownerOf = (store: CrosslineStore, workspaceId: string) => store.getWorkspaceOwnerId(workspaceId) ?? "system";
const POLLED_SETTING = "opportunity.polled";

/**
 * The old needs as watches, one to one, the first time the watches are read (§17.2): decisions kept, sources turned into the query and
 * the tools, the last poll carried over as the last run. `scout.needs`, the waiting items and the preferences are left as they are.
 */
export function migrateNeedsToWatches(store: CrosslineStore, workspaceId: string, now = new Date()): number {
  if (store.getSetting(workspaceId, WATCHES_SETTING) !== undefined) return 0;
  const needs = readNeeds(store.getSetting(workspaceId, SCOUT_NEEDS_SETTING));
  if (!needs.length) return 0;
  let polled: Record<string, string> = {};
  try { polled = JSON.parse(store.getSetting(workspaceId, POLLED_SETTING) ?? "{}") as Record<string, string>; } catch { polled = {}; }
  const watches = needs.map((need) => watchFromNeed(need, now.toISOString(), polled[need.id]));
  store.setSetting(workspaceId, WATCHES_SETTING, JSON.stringify(watches));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `opportunity.watches.migrated:${workspaceId}`, type: "opportunity.watches.migrated",
    entityId: workspaceId, payload: { count: watches.length, active: watches.filter((watch) => watch.state === "active").length } });
  return watches.length;
}

export function readWatchList(store: CrosslineStore, workspaceId: string): StoredWatch[] {
  migrateNeedsToWatches(store, workspaceId);
  return readWatches(store.getSetting(workspaceId, WATCHES_SETTING));
}
export const saveWatchList = (store: CrosslineStore, workspaceId: string, watches: StoredWatch[]) =>
  store.setSetting(workspaceId, WATCHES_SETTING, JSON.stringify(watches));
export const watchOf = (store: CrosslineStore, workspaceId: string, id: string) => readWatchList(store, workspaceId).find((watch) => watch.id === id);

function updateWatch(store: CrosslineStore, workspaceId: string, id: string, change: (watch: StoredWatch) => StoredWatch): StoredWatch | undefined {
  const list = readWatchList(store, workspaceId);
  const found = list.find((watch) => watch.id === id);
  if (!found) return undefined;
  const next = change(found);
  saveWatchList(store, workspaceId, list.map((watch) => watch.id === id ? next : watch));
  return next;
}

/**
 * What a line's derivation must not propose again (§17.5): titles of work finished or archived, of milestones the gate passed or the
 * person archived, and of watches the person turned down.
 */
export function doneTitles(store: CrosslineStore, workspaceId: string, lineId: string): string[] {
  const orders = store.listWorkOrders(workspaceId).filter((order) => order.identityId === lineId && (order.state === "accepted" || order.state === "archived"))
    .map((order) => taskTitleOf(order));
  const latest = new Map<string, { title: string; status: string }>();
  for (const milestone of store.listMilestones(workspaceId)) if (milestone.identityId === lineId) latest.set(milestone.id, milestone);
  return [...orders, ...[...latest.values()].filter((item) => item.status === "archived" || item.status === "accepted").map((item) => item.title)];
}

/** A line's new derivation merged into what is kept (`mergeWatches`); returns the line's watches after it. */
export function saveLineWatches(store: CrosslineStore, workspaceId: string, lineId: string, fresh: StoredWatch[]): StoredWatch[] {
  const next = mergeWatches(readWatchList(store, workspaceId), lineId, fresh, doneTitles(store, workspaceId, lineId));
  saveWatchList(store, workspaceId, next);
  return next.filter((watch) => watch.lineId === lineId);
}

/** New watches the scout proposed (§17.3), kept as proposals for the weekly review; one already held or done is left out. */
export function addScoutWatches(store: CrosslineStore, workspaceId: string, fresh: StoredWatch[]): number {
  let list = readWatchList(store, workspaceId);
  let added = 0;
  for (const watch of fresh) {
    const merged = mergeWatches(list, watch.lineId, [watch], doneTitles(store, workspaceId, watch.lineId));
    if (merged.length > list.length) added += 1;
    list = merged;
  }
  saveWatchList(store, workspaceId, list);
  return added;
}

/**
 * The person's answer to a proposed watch: 盯住 makes it active and, for a cycle, writes the 「预计 X 月开放」 waiting item (asked about
 * on its day); 不要 retires it, remembered as a preference so it is not proposed again. The same as the old need cards did.
 */
export function decideWatch(store: CrosslineStore, workspaceId: string, ownerId: string, id: string, decision: "active" | "retired", now = new Date(), note = ""): StoredWatch | undefined {
  const t = tFor(readLocale(store, workspaceId));
  const decided = updateWatch(store, workspaceId, id, (watch) => ({ ...watch, state: decision, decidedAt: now.toISOString(), updatedAt: now.toISOString(),
    ...(decision === "retired" ? { retiredBy: "person" as const } : { retiredBy: undefined }) }));
  if (!decided) return undefined;
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.watch.decided:${id}:${now.toISOString()}`, type: "opportunity.watch.decided",
    entityId: id, payload: { watchId: id, lineId: decided.lineId, decision, title: decided.title, origin: decided.origin } });
  const waitingId = waitingIdForNeed(id);
  if (decision === "retired") {
    store.addPreference({ workspaceId, source: "opportunity_declined", scope: decided.lineId, weight: 1, refId: id,
      text: note.trim() ? t("不要「{{title}}」这类机会：{{note}}", { title: decided.title, note: note.trim().slice(0, 200) })
        : t("不要「{{title}}」这类机会（{{why}}）", { title: decided.title, why: decided.why.slice(0, 120) }) });
    const waiting = store.listWaitingItems(workspaceId, { state: "open" }).find((item) => item.id === waitingId);
    if (waiting) store.answerWaitingItem(workspaceId, waiting.id, { kind: "cancelled" }, ownerId);
    return decided;
  }
  const opens = decided.cycle?.opens ?? decided.cycle?.closes;
  if (opens && opens > now.toISOString().slice(0, 7)) {
    const expectedAt = `${opens}-01`;
    const earlier = store.listWaitingItems(workspaceId).find((item) => item.id === waitingId);
    if (earlier) { if (earlier.state !== "open") store.reopenWaitingItem(workspaceId, earlier.id, expectedAt, ownerId); return decided; }
    store.saveWaitingItem({ id: waitingId, ownerId, workspaceId, who: "", title: t("「{{title}}」预计 {{month}} 开放", { title: decided.title, month: opens }),
      expectedAt, approximate: true, followUpAt: expectedAt, state: "open", blocks: [], source: "opportunity" });
  }
  return decided;
}

/** Pause, switch off or bring back a watch (the line card and the settings table). A watch the person switched off stays theirs to restore. */
export function setWatchState(store: CrosslineStore, workspaceId: string, ownerId: string, id: string, state: "active" | "paused" | "retired", now = new Date()): StoredWatch | undefined {
  const next = updateWatch(store, workspaceId, id, (watch) => ({ ...watch, state, updatedAt: now.toISOString(),
    ...(state === "retired" ? { retiredBy: "person" as const } : { retiredBy: undefined }) }));
  if (next) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.watch.state:${id}:${now.toISOString()}`, type: "opportunity.watch.state",
    entityId: id, payload: { watchId: id, lineId: next.lineId, state } });
  return next;
}

export type WatchEdit = { title?: string; query?: string; judge?: string; everyDays?: number; horizonDays?: number };
const urlsIn = (text: string) => [...new Set(text.match(/https:\/\/[^\s，。；、)）]+/g) ?? [])].slice(0, 6);
const clampDays = (value: number | undefined, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** The person's edit: from then on the watch is theirs (`origin: person`), so no derivation replaces it and the yield rule never retires it. */
export function editWatch(store: CrosslineStore, workspaceId: string, ownerId: string, id: string, edit: WatchEdit, now = new Date()): StoredWatch | undefined {
  const next = updateWatch(store, workspaceId, id, (watch) => {
    const query = edit.query?.trim() ? edit.query.trim().slice(0, 600) : watch.query;
    const kept = (watch.targets ?? []).filter((target) => target.tool !== "web_fetch" || query.includes(target.url));
    const fetched: WatchTarget[] = urlsIn(query).filter((url) => !kept.some((target) => target.tool === "web_fetch" && target.url === url)).map((url) => ({ tool: "web_fetch", url }));
    const targets = [...kept, ...fetched];
    return { ...watch, origin: "person", title: edit.title?.trim() ? edit.title.trim().slice(0, 80) : watch.title, query,
      judge: edit.judge?.trim() ? edit.judge.trim().slice(0, 400) : watch.judge, everyDays: clampDays(edit.everyDays, 1, 180, watch.everyDays),
      horizonDays: clampDays(edit.horizonDays, 7, 540, watch.horizonDays), targets,
      tools: [...new Set([...watch.tools, ...(fetched.length ? ["web_fetch" as const] : [])])], updatedAt: now.toISOString() };
  });
  if (next) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.watch.edited:${id}:${now.toISOString()}`, type: "opportunity.watch.edited",
    entityId: id, payload: { watchId: id, lineId: next.lineId } });
  return next;
}

/** A watch the person writes themselves on a line card: searched in words, any page it names read and watched for change. */
export function addPersonWatch(store: CrosslineStore, workspaceId: string, ownerId: string, input: { lineId: string; title: string; query: string; everyDays?: number },
  now = new Date()): StoredWatch {
  const query = input.query.trim().slice(0, 600) || input.title.trim();
  const fetched: WatchTarget[] = urlsIn(query).map((url) => ({ tool: "web_fetch", url }));
  const watch: StoredWatch = { id: `person:${input.lineId}:${randomUUID().slice(0, 8)}`, lineId: input.lineId, title: input.title.trim().slice(0, 80), why: query.slice(0, 300),
    origin: "person", basis: { factIds: [], milestoneIds: [], opportunityIds: [] }, query, tools: ["web_search", ...(fetched.length ? ["web_fetch" as const] : [])],
    targets: [...fetched, { tool: "web_search", query: query.slice(0, 160) }], judge: query.slice(0, 400), explore: false,
    everyDays: clampDays(input.everyDays, 1, 180, 7), horizonDays: 120, state: "active", stats: emptyStats(), createdAt: now.toISOString(),
    updatedAt: now.toISOString(), decidedAt: now.toISOString(), leadDays: 14, prescreen: [], weight: 1, strictness: 0 };
  saveWatchList(store, workspaceId, [...readWatchList(store, workspaceId), watch]);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.watch.added:${watch.id}`, type: "opportunity.watch.added", entityId: watch.id,
    payload: { watchId: watch.id, lineId: watch.lineId } });
  return watch;
}

/** A run's bookkeeping, kept by code (§17.2): runs, found, surfaced, cost in weighted tokens, when. */
export function noteWatchRun(store: CrosslineStore, workspaceId: string, id: string, run: { found: number; surfaced: number; cost: number; at: string }): StoredWatch | undefined {
  return updateWatch(store, workspaceId, id, (watch) => ({ ...watch, stats: { ...watch.stats, runs: watch.stats.runs + 1, found: watch.stats.found + run.found,
    surfaced: watch.stats.surfaced + run.surfaced, cost: watch.stats.cost + run.cost, lastRunAt: run.at } }));
}

/** The yield rule (§17.4): watches retired now, by the system; listed in the settings table, restorable. */
export function retireQuietWatches(store: CrosslineStore, workspaceId: string, now = new Date()): StoredWatch[] {
  const list = readWatchList(store, workspaceId);
  const retiring = new Set(retireCandidates(list, now).map((watch) => watch.id));
  if (!retiring.size) return [];
  const next = list.map((watch) => retiring.has(watch.id) ? { ...watch, state: "retired" as const, retiredBy: "system" as const, updatedAt: now.toISOString() } : watch);
  saveWatchList(store, workspaceId, next);
  for (const watch of next.filter((item) => retiring.has(item.id))) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
    idempotencyKey: `opportunity.watch.retired:${watch.id}:${now.toISOString()}`, type: "opportunity.watch.retired", entityId: watch.id,
    payload: { watchId: watch.id, lineId: watch.lineId, runs: watch.stats.runs, cost: watch.stats.cost } });
  return next.filter((watch) => retiring.has(watch.id));
}

// ── Outcomes (§17.4) ─────────────────────────────────────────────────────────────────────────────────────────────────

export const isScoutFind = (row: Pick<StoredOpportunity, "needId">) => Boolean(row.needId?.startsWith(SCOUT_NEED_PREFIX));

/**
 * One outcome of something surfaced, written once per opportunity and outcome (「少来」 may repeat): onto its watch's stats, or the
 * scout's when the scout found it. Returns whether it was new.
 */
export function recordOpportunityOutcome(store: CrosslineStore, workspaceId: string, opportunityId: string, outcome: OpportunityOutcome, at = new Date().toISOString(),
  ref = at): boolean {
  const row = store.listOpportunities(workspaceId, { id: opportunityId })[0];
  if (!row) return false;
  const key = outcome === "less" ? `opportunity.outcome:${opportunityId}:less:${ref}` : `opportunity.outcome:${opportunityId}:${outcome}`;
  const written = store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: key, type: "opportunity.outcome", entityId: opportunityId,
    payload: { opportunityId, outcome, watchId: row.needId ?? "", lineId: row.lineId, weight: OUTCOME_WEIGHT[outcome] } });
  if (!written.inserted) return false;
  if (isScoutFind(row)) {
    const stats = readScoutStats(store.getSetting(workspaceId, SCOUT_STATS_SETTING));
    store.setSetting(workspaceId, SCOUT_STATS_SETTING, JSON.stringify({ ...stats, outcomes: { ...stats.outcomes, [outcome]: (stats.outcomes[outcome] ?? 0) + 1 } }));
  } else if (row.needId) updateWatch(store, workspaceId, row.needId, (watch) => ({ ...watch, stats: withOutcome(watch.stats, outcome, at) }));
  return true;
}

export const outcomesOf = (store: CrosslineStore, workspaceId: string, opportunityId: string): Set<OpportunityOutcome> =>
  new Set(store.listEvents(workspaceId, { type: "opportunity.outcome", entityId: opportunityId }).map((event) => (event.payload as { outcome: OpportunityOutcome }).outcome));

/** The form filling confirmed the sign-up: the opportunity's own confirmed mark, written from the run (§17.8, replacing track A's mail match). */
export function confirmOpportunityFromRun(store: CrosslineStore, workspaceId: string, run: Pick<StoredFormRun, "id" | "opportunityId">, at = new Date().toISOString()): boolean {
  const confirmed = store.confirmOpportunity(workspaceId, run.opportunityId, `form:${run.id}`, at);
  if (confirmed) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `opportunity.confirmed:${run.opportunityId}`, type: "opportunity.confirmed",
    entityId: run.opportunityId, payload: { formRun: run.id, at } });
  return confirmed;
}

/**
 * The outcomes the ledger shows by itself (§17.4: written by fact, never asked for): surfaced and never answered → ignored; a sign-up
 * submitted → submitted; confirmed and its day past → attended; an application whose milestone got work → task. Runs every opportunity pass.
 */
export function settleOpportunityOutcomes(store: CrosslineStore, workspaceId: string, today: string, now = new Date()): number {
  const at = now.toISOString();
  let written = 0;
  const runs = new Map<string, StoredFormRun>();
  for (const run of readFormRuns(store, workspaceId)) if (!runs.has(run.opportunityId)) runs.set(run.opportunityId, run);
  const milestoneOf = new Map(store.listEvents(workspaceId, { type: "opportunity.milestone_written" })
    .map((event) => [event.entityId, (event.payload as { milestoneId?: string }).milestoneId ?? ""]));
  const served = new Set(store.listWorkOrders(workspaceId).map((order) => order.milestoneId).filter(Boolean));
  for (const row of store.listOpportunities(workspaceId)) {
    const had = outcomesOf(store, workspaceId, row.id);
    const add = (outcome: OpportunityOutcome) => { if (!had.has(outcome) && recordOpportunityOutcome(store, workspaceId, row.id, outcome, at)) written += 1; };
    const run = runs.get(row.id);
    if (run && (run.state === "submitted" || run.state === "confirmed")) add("submitted");
    if (run?.state === "confirmed") {
      confirmOpportunityFromRun(store, workspaceId, run, at);
      if (row.startsAt?.day && row.startsAt.day < today) add("attended");
    }
    const milestone = milestoneOf.get(row.id);
    if (milestone && served.has(milestone)) add("task");
    if (had.has("surfaced") && !row.decision) {
      const deadline = row.deadlines.map((item) => item.day).sort().at(-1);
      const stale = now.getTime() - Date.parse(row.foundAt) >= IGNORED_AFTER_DAYS * 86_400_000;
      if ((deadline && deadline < today) || stale) add("ignored");
    }
  }
  return written;
}

/** The person's word on an application's result (or a mail that said it): the outcome, and the line's watches derived again (§17.4). */
export function recordApplicationResult(store: CrosslineStore, workspaceId: string, ownerId: string, opportunityId: string, result: "accepted" | "rejected", at = new Date().toISOString()): boolean {
  const written = recordOpportunityOutcome(store, workspaceId, opportunityId, result, at);
  const row = store.listOpportunities(workspaceId, { id: opportunityId })[0];
  if (written && row) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.result:${opportunityId}`, type: "opportunity.result", entityId: opportunityId,
    payload: { opportunityId, result, lineId: row.lineId } });
  return written;
}

// ── 「少来」 (§17.4) ───────────────────────────────────────────────────────────────────────────────────────────────────

export const readWatchTuning = (store: CrosslineStore, workspaceId: string): WatchTuning => readTuning(store.getSetting(workspaceId, WATCH_TUNING_SETTING));
export const lessLog = (store: CrosslineStore, workspaceId: string): LessEntry[] => readLessLog(store.getSetting(workspaceId, LESS_LOG_SETTING));

/** One 「少来」 from a card or the morning brief: the adjustment, the log entry to undo it, the note as a preference, the outcome. */
export function lessOpportunity(store: CrosslineStore, workspaceId: string, ownerId: string, feedback: LessFeedback, now = new Date()): LessEntry | undefined {
  const row = store.listOpportunities(workspaceId, { id: feedback.opportunityId })[0];
  if (!row) return undefined;
  const watchId = feedback.watchId ?? (isScoutFind(row) ? undefined : row.needId);
  const list = readWatchList(store, workspaceId);
  const watch = watchId ? list.find((item) => item.id === watchId) : undefined;
  const failedRules = row.verdict.state === "ineligible" ? row.verdict.failed.map((item) => item.rule)
    : row.verdict.state === "unknown" ? row.terms.filter((term) => row.verdict.state === "unknown" && row.verdict.questions.some((question) => question.dim === term.dim)).map((term) => term.rule) : [];
  const id = `less-${randomUUID().slice(0, 10)}`;
  const t = tFor(readLocale(store, workspaceId));
  const applied = applyLess({ feedback: { ...feedback, ...(watch ? { watchId: watch.id } : {}) }, watch, tuning: readWatchTuning(store, workspaceId),
    opportunity: row, failedRules, id, at: now.toISOString(), t });
  let entry = applied.entry;
  if (feedback.note?.trim()) {
    const preference = store.addPreference({ workspaceId, source: "opportunity_less", scope: row.lineId, weight: 0.5, refId: id,
      text: t("少来「{{title}}」这类：{{note}}", { title: row.title.slice(0, 60), note: feedback.note.trim().slice(0, 200) }) });
    entry = { ...entry, undo: { ...entry.undo, preferenceRef: preference.id } };
  }
  if (applied.watch) saveWatchList(store, workspaceId, list.map((item) => item.id === applied.watch!.id ? applied.watch! : item));
  store.setSetting(workspaceId, WATCH_TUNING_SETTING, JSON.stringify(applied.tuning));
  store.setSetting(workspaceId, LESS_LOG_SETTING, JSON.stringify([...lessLog(store, workspaceId), entry].slice(-200)));
  recordOpportunityOutcome(store, workspaceId, row.id, "less", now.toISOString(), id);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.less:${id}`, type: "opportunity.less", entityId: row.id,
    payload: { lessId: id, opportunityId: row.id, watchId: entry.watchId ?? "", scope: feedback.scope, reason: feedback.reason ?? "" } });
  return entry;
}

/** Takes one 「少来」 back: only what that one changed is put back, and its note leaves the preferences. */
export function undoLessEntry(store: CrosslineStore, workspaceId: string, ownerId: string, id: string, now = new Date()): boolean {
  const log = lessLog(store, workspaceId);
  const entry = log.find((item) => item.id === id);
  if (!entry || entry.undoneAt) return false;
  const list = readWatchList(store, workspaceId);
  const watch = entry.watchId ? list.find((item) => item.id === entry.watchId) : undefined;
  const restored = undoLess(entry, watch, readWatchTuning(store, workspaceId), now.toISOString());
  if (restored.watch) saveWatchList(store, workspaceId, list.map((item) => item.id === restored.watch!.id ? restored.watch! : item));
  store.setSetting(workspaceId, WATCH_TUNING_SETTING, JSON.stringify(restored.tuning));
  if (entry.undo.preferenceRef) store.deletePreference(workspaceId, entry.undo.preferenceRef, now.toISOString());
  store.setSetting(workspaceId, LESS_LOG_SETTING, JSON.stringify(log.map((item) => item.id === id ? { ...item, undoneAt: now.toISOString() } : item)));
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `opportunity.less_undone:${id}`, type: "opportunity.less_undone", entityId: entry.opportunityId, payload: { lessId: id } });
  return true;
}

// ── What reaches the person ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Found opportunities that may reach the person today: undecided (or put off to a day now come), not ruled out, not past their deadline,
 * not infeasible, and not held back by an adjustment (`holdBack`). `inbox: false` for a scout find that is not urgent and for one no line
 * holds at `PUSH_RELEVANCE` (§18): it waits for the weekly review's 视野外 instead of the morning brief and 待决 (§17.3). Most relevant first.
 */
export function surfacedOpportunities(store: CrosslineStore, workspaceId: string, today: string): Array<StoredOpportunity & { watch?: StoredWatch | undefined; inbox: boolean }> {
  const watches = new Map(readWatchList(store, workspaceId).map((watch) => [watch.id, watch]));
  const tuning = readWatchTuning(store, workspaceId);
  return store.listOpportunities(workspaceId).flatMap((row) => {
    if (row.decision && !(row.decision === "later" && (row.laterUntil ?? "") <= today)) return [];
    if (row.deadlines.length && !nextDeadline(row, today)) return [];
    const watch = row.needId ? watches.get(row.needId) : undefined;
    if (holdBack({ opportunity: row, verdict: row.verdict, feasibility: row.feasibility, watch, tuning })) return [];
    const scout = isScoutFind(row);
    const start = prepStartFor(nextDeadline(row, today), 14) ?? nextDeadline(row, today);
    // Pushed only when one line holds it at the push threshold (§18 item 1); a weaker find waits for the weekly review's 视野外.
    const inbox = pushable(row) && (!scout || Boolean(start && start <= addDays(today, SCOUT_URGENT_DAYS)));
    return [{ ...row, ...(watch ? { watch } : {}), inbox }];
  }).sort((a, b) => bestRelevance(b) - bestRelevance(a));
}

/** Weighted tokens per usage purpose since `sinceIso` (what the watches' costs and the 20% share are counted in). */
export function opportunityCosts(store: CrosslineStore, workspaceId: string, sinceIso: string): Array<{ purpose: string; weighted: number }> {
  const sums = new Map<string, number>();
  for (const row of store.modelUsageByPurpose(workspaceId, sinceIso)) {
    if (!row.purpose.startsWith("opportunity:")) continue;
    sums.set(row.purpose, (sums.get(row.purpose) ?? 0) + weightedTokens(row));
  }
  return [...sums.entries()].map(([purpose, weighted]) => ({ purpose, weighted }));
}

/** This week's exploration share and whether a new exploration may start (§17.3). */
export const exploreThisWeek = (store: CrosslineStore, workspaceId: string, now = new Date()) =>
  exploreAccount(opportunityCosts(store, workspaceId, new Date(now.getTime() - 7 * 86_400_000).toISOString()));
