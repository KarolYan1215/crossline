import "server-only";
import type { AccessContext, AvailabilityWindow, FrozenBlock } from "@crossline/core";
import { CALENDAR_LINES, CATEGORY_LABEL, calendarLineOf, currentFiling, importedProjects, importedTitle, itemProjectResolver, inferWorkState, stepCategory, suggestAvailability, type ActivitySegment, type CalendarLines, type WorkState } from "@crossline/core";
import { isAutoHandoff, isPaused, listAgentTasks, readCategories } from "@crossline/db";
import {
  ACTIVITY_DETAIL_CONSENT, effectiveSchedulePreferences, getStore, loadCurrentPlan, planToday, readAvailability, readFrozen, toZonedInstant
} from "./crossline";
import { itemsFromPlan, toMinutes, withAgentMarks, type TimelineDeadline, type TimelineItem } from "../app/timeline/model";
import { identityLines } from "./lines";
import { inputEvents } from "./fixed-events";
import { localeFor, tOf } from "./locale";
import { tFor } from "./i18n";

export type TimelineData = {
  today: string; nowIso: string; timeZone: string;
  items: TimelineItem[]; deadlines: TimelineDeadline[];
  labels: Record<string, string>;
  quietByWeekday: Record<number, Array<[string, string]>>;
  /** Proposals waiting for approval, for the day's quick actions (「全部批准」). */
  proposals: Array<{ id: string; title: string }>;
};

/** The stretches of a day no availability window covers: sleep, meals, whatever the person marked unavailable. */
export function quietRanges(windows: AvailabilityWindow[], weekday: number): Array<[string, string]> {
  const covered = windows.filter((window) => window.days.includes(weekday))
    .map((window) => [toMinutes(window.start), Math.min(toMinutes(window.end) || 1440, 1440)] as const)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[string, string]> = [];
  const clock = (minutes: number) => minutes >= 1440 ? "24:00" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  let cursor = 0;
  for (const [from, to] of covered) {
    if (from > cursor) out.push([clock(cursor), clock(from)]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < 1440) out.push([clock(cursor), "24:00"]);
  return out;
}

const activityDetailOn = (ctx: AccessContext) => getStore().getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) === "granted";
const instantNow = () => process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();

/** What was actually in front of the person, as blocks: same-kind neighbours merged, idle and blips under five minutes dropped. */
export function activityItems(ctx: AccessContext, timeZone: string, now: Date, days = 7): TimelineItem[] {
  if (!activityDetailOn(ctx)) return [];
  const segments = getStore().listActivitySegments(ctx.workspaceId, new Date(now.getTime() - days * 86_400_000).toISOString())
    .filter((segment) => !segment.idle);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (iso: string) => { const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
  const merged: Array<{ start: string; end: string; category: string }> = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.category === segment.category && Date.parse(segment.start) - Date.parse(last.end) <= 3 * 60_000) last.end = segment.end;
    else merged.push({ start: segment.start, end: segment.end, category: segment.category });
  }
  return merged.filter((block) => Date.parse(block.end) - Date.parse(block.start) >= 5 * 60_000).flatMap((block) => {
    const from = local(block.start), to = local(block.end);
    // A block that crosses local midnight is cut at it: the views draw one day at a time.
    const end = to.day === from.day ? to.time : "24:00";
    return [{ id: `activity:${block.start}`, title: CATEGORY_LABEL[block.category as keyof typeof CATEGORY_LABEL] ?? block.category,
      day: from.day, start: from.time, end, kind: "activity" as const, source: "screen-activity", readOnly: true }];
  });
}

/**
 * A weekly availability pattern proposed from the last two weeks of screen activity, or nothing: it needs the detailed
 * consent and at least a week of observed days. It is offered in the schedule editor and never saved on its own.
 */
export function suggestedAvailabilityFor(ctx: AccessContext): AvailabilityWindow[] {
  if (!activityDetailOn(ctx)) return [];
  const now = instantNow();
  const segments = getStore().listActivitySegments(ctx.workspaceId, new Date(now.getTime() - 14 * 86_400_000).toISOString());
  return suggestAvailability({ segments, timeZone: effectiveSchedulePreferences(ctx).preferences.timeZone });
}

/** The person's work state right now, from the last quarter hour of screen activity and today's calendar. Absent without the detail consent. */
export function currentWorkState(ctx: AccessContext, plan: Awaited<ReturnType<typeof loadCurrentPlan>>): (WorkState & { label: string }) | undefined {
  if (!activityDetailOn(ctx)) return undefined;
  const now = instantNow();
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx);
  const calendar = plan.blocks.filter((block) => (block.day ?? today) === today && !block.id.startsWith("scheduled:"))
    .flatMap((block) => { try { return [{ start: toZonedInstant(block.day ?? today, block.start, zone), end: toZonedInstant(block.day ?? today, block.end === "24:00" ? "23:59" : block.end, zone) }]; } catch { return []; } });
  const segments: ActivitySegment[] = getStore().listActivitySegments(ctx.workspaceId, new Date(now.getTime() - 20 * 60_000).toISOString())
    .map((segment) => ({ start: segment.start, end: segment.end, app: segment.app, category: segment.category as ActivitySegment["category"], idle: segment.idle }));
  const locale = localeFor(ctx);
  const state = inferWorkState({ segments, now: now.toISOString(), calendar, locale });
  const label = tFor(locale)({ focused: "专注", switching: "频繁切换", in_meeting: "会议中", away: "离开键盘", leisure: "娱乐", mixed: "说不准", unknown: "数据不足" }[state.state]);
  return { ...state, label };
}

const DATE_KIND_LABEL: Record<string, string> = { class: "上课", quiz: "小测", homework_out: "作业发布", homework_due: "作业截止", exam: "考试",
  project_due: "项目截止", deadline: "截止", meeting: "会议", other: "其他" };

/**
 * Why a work block keeps its time (`schedule.frozen`), whether the person accepted an overlap and whether the lock came from their
 * calendar app. Only when the block still sits at the frozen time: an entry the planner let go may share its id with a block placed anew.
 */
function withFrozenState(item: TimelineItem, held: Map<string, FrozenBlock>, zone: string): TimelineItem {
  const entry = item.kind === "scheduled" ? held.get(item.id) : undefined;
  if (!entry) return item;
  try {
    if (Date.parse(toZonedInstant(item.day, item.start, zone)) !== Date.parse(entry.start)) return item;
  } catch { return item; }
  return { ...item, frozen: entry.reason, ...(entry.overlapOk ? { overlapOk: true } : {}), ...(entry.via ? { lockedVia: entry.via } : {}) };
}

/** Everything the three calendar views draw, read once: the plan's blocks, what is due, and the person's own hours. */
export async function loadTimeline(ctx: AccessContext, loaded?: Awaited<ReturnType<typeof loadCurrentPlan>>): Promise<TimelineData> {
  const store = getStore();
  const t = tOf(ctx);
  const plan = loaded ?? await loadCurrentPlan(ctx);
  const today = planToday(ctx);
  const milestones = store.listMilestones(ctx.workspaceId);
  const titleOf = new Map(milestones.map((milestone) => [milestone.id, milestone.title]));
  const meta = Object.fromEntries(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id,
    { identityId: order.identityId, ...(order.milestoneId && titleOf.has(order.milestoneId) ? { milestone: titleOf.get(order.milestoneId)! } : {}) }]));
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  // Calendar events and file dates take the line the classifier filed them under (`calendar.lines`, by title; never filed by hand).
  // A file date is shown with its course in front when its title left it out (dates imported before titles had to name it).
  const filing = calendarFiling(ctx);
  const eventLine = new Map(inputEvents(ctx).map((event) => [event.id, event.lineId]));
  const knownProjects = store.listProjects(ctx.workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  const projectOfItem = itemProjectResolver(knownProjects, store.listSourceDocuments(ctx.workspaceId));
  const imported = importedProjects(store.listEvents(ctx.workspaceId, { type: "dates.extracted" }), projectOfItem);
  const held = new Map(readFrozen(ctx, instantNow()).map((entry) => [entry.blockId, entry]));
  const items = [...withAgentMarks(itemsFromPlan(plan.blocks, today, meta), agentMarks(ctx)).map((item) => {
    if (item.kind !== "calendar" && item.kind !== "import") return item;
    const named = item.kind === "import" ? { ...item, title: importedTitle(item.id, item.title, imported) } : item;
    if (named.identityId) return named;
    // An event the person added names its line itself; only when it does not is it filed like any calendar title.
    const lineId = (item.id.startsWith("event:") ? eventLine.get(item.id.split(":")[1]!) : "") || calendarLineOf(filing, named.title);
    return lineId ? { ...named, identityId: lineId } : named;
  }).map((item) => withFrozenState(item, held, zone)), ...activityItems(ctx, zone, instantNow())];

  // What is due: each live milestone's deadline, and every confirmed dated fact the person's files gave us.
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const projects = store.listProjects(ctx.workspaceId, { includeArchived: true });
  const deadlines: TimelineDeadline[] = [
    ...milestones.filter((milestone) => milestone.status !== "archived" && anchors.get(milestone.id)?.deadline).map((milestone) => ({
      id: `milestone:${milestone.id}`, day: anchors.get(milestone.id)!.deadline, title: milestone.title, identityId: milestone.identityId,
      detail: milestone.status === "draft" ? t("里程碑截止 · 草稿") : t("里程碑截止") })),
    ...store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.slot.startsWith("date_") && fact.status === "confirmed" && /^\d{4}-\d{2}-\d{2} /.test(fact.value))
      .map((fact) => {
        // The course by name in front of the item (「ECE 555 · 作业 2 截止」), and what kind of date it is with the file's own words on hover.
        // The fact's own project, or — when the interview could not tell which course — the project its source file has since been filed under.
        const resolved = projectOfItem({ project: fact.projectId, sourceRef: fact.sourceRef });
        const project = projects.find((item) => item.id === fact.projectId || item.name === fact.projectId || item.name === resolved);
        const kind = t(DATE_KIND_LABEL[/^date_\d{8}_(\w+)$/.exec(fact.slot)?.[1] ?? ""] ?? "日期");
        return { id: `fact:${fact.identityId}:${fact.projectId}:${fact.slot}`, day: fact.value.slice(0, 10),
          title: project ? `${project.name} · ${fact.value.slice(11)}` : fact.value.slice(11), identityId: fact.identityId,
          detail: fact.sourceQuote ? t("{{kind}} · 原文「{{quote}}」", { kind, quote: fact.sourceQuote.slice(0, 80) }) : kind };
      })
  ];

  const windows = readAvailability(ctx);
  const nowIso = instantNow().toISOString();
  return {
    today, nowIso, timeZone: zone, items, deadlines,
    labels: Object.fromEntries(identityLines(ctx).map((pack) => [pack.id, t(pack.label)])),
    quietByWeekday: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((weekday) => [weekday, quietRanges(windows, weekday)])),
    proposals: store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval" && !(order.payload as { seeded?: boolean }).seeded)
      .map((order) => ({ id: order.id, title: order.intent }))
  };
}

/**
 * Which blocks the assistant has (「Agent 执行中」 / 「Agent 将执行」 on the day view). Running: a run with no outcome yet, keyed by step
 * (or by order for a whole-task run). Planned: with 「自动交给 Agent」 on and the assistant not paused, a planned step the system can do
 * (`executor: "mixed"`), of a kind the person allowed, not yet handed over — the worker's own rule (`autoHandoffCandidates`), less the
 * timing, which the block itself shows.
 */
function agentMarks(ctx: AccessContext): { running: Set<string>; planned: Set<string> } {
  const store = getStore();
  const tasks = listAgentTasks(store, ctx.workspaceId);
  const running = new Set(tasks.filter((task) => task.status === "running").map((task) => task.stepId ? `${task.workOrderId}#${task.stepId}` : task.workOrderId));
  const planned = new Set<string>();
  if (isAutoHandoff(store, ctx.workspaceId) && !isPaused(store, ctx.workspaceId)) {
    const approved = readCategories(store, ctx.workspaceId);
    const handed = new Set(tasks.filter((task) => task.stepId).map((task) => `${task.workOrderId}#${task.stepId}`));
    for (const plan of store.listStepPlans(ctx.workspaceId)) for (const step of plan.steps) {
      const category = stepCategory(step);
      if (step.executor === "mixed" && step.status === "planned" && step.schedulable && category && approved[category] && !handed.has(`${plan.workOrderId}#${step.id}`))
        planned.add(`${plan.workOrderId}#${step.id}`);
    }
  }
  return { running, planned };
}

/** The calendar filing against the current lines (`currentFiling`: a changed set of lines keeps only the person's own answers). */
export function calendarFiling(ctx: AccessContext): CalendarLines {
  let stored: CalendarLines | null = null;
  try { stored = JSON.parse(getStore().getSetting(ctx.workspaceId, CALENDAR_LINES) ?? "null") as CalendarLines | null; } catch { /* none */ }
  return currentFiling(stored, identityLines(ctx));
}

