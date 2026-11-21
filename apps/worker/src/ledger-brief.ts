import { addDays, FIXED_EVENTS, MAIL_EVENTS_SETTING, MAIL_EVENT_RULES_SETTING, occurrences, readMailEventRules, readMailEvents, type FixedEvent } from "@crossline/core";
import { dueDateReader, type CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";

/**
 * The ledger brief (docs/plans/near-term-and-mail-bar-1120.md §3.1): what the person already has, given to every model call that adds to
 * the ledger, so it can tell new from known. Before it, mail triage saw only 60 open task titles and no calendar: a weekly meeting already
 * on the calendar came back from its invitation mail as a task, an assignment already planned came back from its release mail as another.
 *
 * Byte-stable for the prompt cache: sorted by id, without the current time (the caller puts today after it). Capped per section; what is
 * left out is counted (`more`), never silently dropped.
 */
export const BRIEF_DAYS = 21;
const CAP = { milestones: 40, open: 80, done: 30, time: 150, waits: 40, preferences: 30 } as const;
const DONE_STATES = new Set(["accepted"]);
const GONE_STATES = new Set(["archived"]);

export type BriefTask = { id: string; title: string; line: string; milestoneId: string; due: string; state: string };
export type BriefTime = { id: string; title: string; day: string; start: string; end: string; source: "calendar" | "fixed" | "file" | "mail"; line: string; state?: string };
export type LedgerBrief = {
  lines: Array<{ id: string; label: string; goal: string }>;
  milestones: Array<{ id: string; title: string; line: string; due: string; done: string }>;
  openTasks: BriefTask[];
  doneTasks: Array<{ id: string; title: string }>;
  time: BriefTime[];
  waits: Array<{ id: string; who: string; title: string; expectedAt: string }>;
  preferences: string[];
  /** How many of each section were left out by the caps; a model may name an id it did not see only through a lookup. */
  more: { milestones: number; openTasks: number; doneTasks: number; time: number };
};

const titleOf = (order: { intent: string; payload?: unknown }) => {
  const title = (order.payload as { title?: unknown } | undefined)?.title;
  return (typeof title === "string" && title.trim() ? title : order.intent).trim().slice(0, 100);
};
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** Timed items the person confirmed from files (a confirmed `dates.extracted` batch), as the web's `confirmedEvents` reads them. */
function fileEvents(store: CrosslineStore, workspaceId: string): FixedEvent[] {
  const decided = new Map(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => [event.entityId, event.payload as { superseded?: boolean; included?: string[] }]));
  type Row = { id: string; title: string; startTime?: string; endTime?: string; date?: string; weekdays?: number[]; from?: string; to?: string; exceptions?: string[] };
  const out: FixedEvent[] = [];
  for (const event of store.listEvents(workspaceId, { type: "dates.extracted" })) {
    const decision = decided.get(event.entityId);
    if (!decision || decision.superseded) continue;
    const included = new Set(decision.included ?? []);
    const payload = event.payload as { dates?: Row[]; recurring?: Row[] };
    for (const row of (payload.recurring ?? []).filter((item) => included.has(item.id))) {
      out.push({ id: `batch:${event.entityId}:${row.id}`, title: row.title, lineId: "", location: "", source: "file",
        repeat: { weekdays: row.weekdays ?? [], from: row.from ?? "", until: row.to ?? "", exceptions: row.exceptions ?? [] },
        date: row.from ?? "", start: row.startTime ?? "", end: row.endTime ?? "" });
    }
    // Dated items without a time (a due day, a release day) are still things the person knows of: listed with an empty start.
    for (const row of (payload.dates ?? []).filter((item) => included.has(item.id) && item.date)) {
      out.push({ id: `batch:${event.entityId}:${row.id}`, title: row.title, lineId: "", location: "", source: "file", repeat: null,
        date: row.date ?? "", start: row.startTime ?? "", end: row.endTime || row.startTime || "" });
    }
  }
  return out;
}

export function buildLedgerBrief(store: CrosslineStore, workspaceId: string, now: Date): LedgerBrief {
  const today = now.toISOString().slice(0, 10);
  const days = Array.from({ length: BRIEF_DAYS }, (_, index) => addDays(today, index));
  const last = days[days.length - 1]!;
  const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, goal: (line.goals?.[0] ?? line.goal ?? "").slice(0, 160) }))
    .sort(byId);
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const milestones = store.listMilestones(workspaceId).filter((item) => item.status === "approved")
    .map((item) => ({ id: item.id, title: item.title.slice(0, 100), line: item.identityId, due: anchors.get(item.id) ?? "",
      done: (item.successCriteria?.[0]?.statement ?? "").slice(0, 120) })).sort(byId);
  const due = dueDateReader(store, workspaceId);
  const orders = store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && !GONE_STATES.has(order.state));
  const open = orders.filter((order) => !DONE_STATES.has(order.state))
    .map((order) => ({ id: order.id, title: titleOf(order), line: order.identityId, milestoneId: order.milestoneId, due: due(order) ?? "", state: order.state }))
    .sort(byId);
  const done = orders.filter((order) => DONE_STATES.has(order.state)).slice(-CAP.done).map((order) => ({ id: order.id, title: titleOf(order) })).sort(byId);

  const time: BriefTime[] = [];
  // The imported calendars (Graph, iCal links): stored already expanded, one block per occurrence, in the current plan's reality.
  const plan = store.listPlanVersions(workspaceId).find((version) => version.status === "current") ?? store.listPlanVersions(workspaceId)[0];
  for (const block of (plan?.payload as { blocks?: Array<{ id?: string; title?: string; day?: string; start?: string; end?: string; readOnly?: boolean }> } | undefined)?.blocks ?? []) {
    if (!block.readOnly || !block.id || !block.day || block.day < today || block.day > last) continue;
    time.push({ id: block.id, title: (block.title ?? "").slice(0, 100), day: block.day, start: block.start ?? "", end: block.end ?? "", source: "calendar", line: "" });
  }
  const expand = (event: FixedEvent, source: BriefTime["source"]) => {
    for (const day of occurrences(event, days)) {
      time.push({ id: event.repeat ? `${event.id}@${day}` : event.id, title: event.title.slice(0, 100), day, start: event.start, end: event.end, source, line: event.lineId });
    }
  };
  for (const event of parse<FixedEvent[]>(store.getSetting(workspaceId, FIXED_EVENTS), [])) if (event?.id && event.date) expand(event, "fixed");
  for (const event of fileEvents(store, workspaceId)) expand(event, "file");
  for (const event of readMailEvents(store.getSetting(workspaceId, MAIL_EVENTS_SETTING))) {
    if (event.date < today || event.date > last || event.state === "skip") continue;
    time.push({ id: `mail-${event.id}`, title: event.title.slice(0, 100), day: event.date, start: event.start, end: event.end, source: "mail", line: event.lineId, state: event.state });
  }
  time.sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

  const waits = store.listWaitingItems(workspaceId, { state: "open" })
    .map((item) => ({ id: item.id, who: item.who, title: item.title.slice(0, 100), expectedAt: item.expectedAt ?? "" })).sort(byId);
  // What the person told the system (stated corrections first), and their per-sender rules for mail events.
  // i18n-ignore-start: model-facing
  const rules = readMailEventRules(store.getSetting(workspaceId, MAIL_EVENT_RULES_SETTING))
    .map((rule) => rule.cap === "optional" ? `来自 ${rule.source} 的活动：本人连续两次不去，默认不必去` : `来自 ${rule.source} 的活动：本人去过要求参加的，算必须去`);
  // i18n-ignore-end
  const preferences = [...store.preferenceLines(workspaceId, ["mail", "intake"], CAP.preferences), ...rules].slice(0, CAP.preferences);

  return {
    lines, milestones: milestones.slice(0, CAP.milestones), openTasks: open.slice(0, CAP.open), doneTasks: done, time: time.slice(0, CAP.time),
    waits: waits.slice(0, CAP.waits), preferences,
    more: { milestones: Math.max(0, milestones.length - CAP.milestones), openTasks: Math.max(0, open.length - CAP.open), doneTasks: 0, time: Math.max(0, time.length - CAP.time) }
  };
}

/** Every id the brief names, for the validator: a model's `serves` and `known` must point at one of these. */
export function briefIds(brief: LedgerBrief): { milestones: Set<string>; lines: Set<string>; known: Set<string> } {
  return {
    milestones: new Set(brief.milestones.map((item) => item.id)),
    lines: new Set(brief.lines.map((item) => item.id)),
    known: new Set([...brief.openTasks.map((item) => item.id), ...brief.doneTasks.map((item) => item.id), ...brief.time.map((item) => item.id)])
  };
}
