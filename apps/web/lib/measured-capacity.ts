import "server-only";
import {
  ACTIVITY_HOURLY, AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, CAPACITY_LOOKBACK_DAYS, MEASURED_CAPACITY_SETTING, PRODUCTIVE, SOURCE_FOLDERS_SETTING,
  dayCapacityMinutes, measuredCapacity, measuredWeeklyHours, measuredWorkDays, mergeSpans, minutesWithin, planBasisOf, readSourceFolders, sourceFolderIndexSetting, weeklyAvailableHours,
  type AccessContext, type ActivityCategory, type ActivityHour, type AgentHistorySummary, type PlanCapacityBasis, type FolderIndexEntry, type MeasuredCapacity,
  type MeasuredCapacityRecord, type MeasuredDay, type MeasuredSignals, type Span
} from "@crossline/core";
import { formatInTimeZone } from "date-fns-tz";
import { ACTIVITY_DETAIL_CONSENT, LOCAL_ACTIVITY_CONSENT, appNow, effectiveSchedulePreferences, getStore, planToday, readAvailability, toZonedInstant } from "./crossline";
import { memoByLedger } from "./ledger-memo";

/**
 * Measured work time and the capacity planned from it (docs/plans/closed-loop-1030.md §1; rules in `packages/core/src/measured-capacity.ts`).
 * Gathers the four signals from the ledger — timed sessions, screen activity by category (never a title: `listActivitySegments` returns
 * none), Codex and Claude Code sessions, file changes in authorized folders — for the last 28 days, today left out.
 *
 * `CROSSLINE_MEASURED_CAPACITY=on|off` decides whether the plan, the forecast and the weekly commitment use it; off under vitest and e2e
 * (their boards were recorded against the stated hours), on everywhere else. The numbers are measured and shown either way.
 */
let enabled = process.env.CROSSLINE_MEASURED_CAPACITY ? process.env.CROSSLINE_MEASURED_CAPACITY !== "off"
  : !process.env.VITEST && !process.env.CROSSLINE_E2E_DATA_DIR;
/** Tests: plan by measured capacity (or not). */
export function configureMeasuredCapacity(on: boolean): void { enabled = on; }
export const measuredCapacityOn = () => enabled;

const DAY = 86_400_000;
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** Timed sessions as spans: each session from start to end (a running one to now, while its order is under way), pauses taken out. */
function timerSpans(ctx: AccessContext, now: Date, orderId?: string): Span[] {
  const store = getStore();
  const running = new Set(store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "active").map((order) => order.id));
  return store.listExecutions(ctx.workspaceId, orderId).filter((execution) => execution.endedAt || running.has(execution.workOrderId)).flatMap((execution) => {
    const start = Date.parse(execution.startedAt), end = Math.min(execution.endedAt ? Date.parse(execution.endedAt) : now.getTime(), now.getTime());
    if (!(end > start)) return [];
    let pieces: Span[] = [{ start, end }];
    for (const pause of execution.interruptions) {
      const from = Date.parse(pause.pausedAt), to = pause.resumedAt ? Date.parse(pause.resumedAt) : end;
      pieces = pieces.flatMap((piece) => to <= piece.start || from >= piece.end ? [piece]
        : [{ start: piece.start, end: Math.min(piece.end, from) }, { start: Math.max(piece.start, to), end: piece.end }].filter((item) => item.end > item.start));
    }
    return pieces;
  });
}

/** Work-category screen segments (never a title) and the days any segment was recorded; empty without the detail consent. */
function screenSpans(ctx: AccessContext, since: string, zone: string): { spans: Span[]; days: string[] } {
  const store = getStore();
  if (store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") return { spans: [], days: [] };
  const segments = store.listActivitySegments(ctx.workspaceId, since);
  const days = new Set(segments.map((segment) => formatInTimeZone(new Date(segment.start), zone, "yyyy-MM-dd")));
  const spans = segments.filter((segment) => !segment.idle && PRODUCTIVE.has(segment.category as ActivityCategory))
    .map((segment) => ({ start: Date.parse(segment.start), end: Date.parse(segment.end) }));
  return { spans, days: [...days] };
}

function agentSpans(ctx: AccessContext): Span[] {
  const store = getStore();
  if (store.getSetting(ctx.workspaceId, AGENT_HISTORY_CONSENT) !== "on") return [];
  const summary = json<AgentHistorySummary | null>(store.getSetting(ctx.workspaceId, AGENT_HISTORY_SUMMARY), null);
  return (summary?.spans ?? []).map((span) => ({ start: Date.parse(span.start), end: Date.parse(span.end) }));
}

function hourlyActive(ctx: AccessContext): ActivityHour[] {
  const store = getStore();
  const consented = store.getSetting(ctx.workspaceId, LOCAL_ACTIVITY_CONSENT) === "granted" || store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) === "granted";
  return consented ? json<ActivityHour[]>(store.getSetting(ctx.workspaceId, ACTIVITY_HOURLY), []) : [];
}

function fileChanges(ctx: AccessContext, since: number): number[] {
  const store = getStore();
  return readSourceFolders(store.getSetting(ctx.workspaceId, SOURCE_FOLDERS_SETTING) ?? undefined).flatMap((folder) =>
    Object.values(json<Record<string, FolderIndexEntry>>(store.getSetting(ctx.workspaceId, sourceFolderIndexSetting(folder.id)), {}))
      .map((entry) => entry.mtimeMs).filter((at) => Number.isFinite(at) && at >= since));
}

function confirmedDays(ctx: AccessContext, since: string): string[] {
  return [...new Set(getStore().listEvents(ctx.workspaceId, { type: "block.confirmed" })
    .map((event) => String((event.payload as { day?: string }).day ?? "")).filter((day) => day >= since))];
}

export type MeasuredView = {
  /** The last 28 days, oldest first, today left out. */
  days: MeasuredDay[];
  capacity: MeasuredCapacity;
  basis: PlanCapacityBasis;
  hasScreen: boolean;
  /** The typical measured week (mean measured day × 7), undefined with no day measured. */
  weeklyHours?: number;
};

/** The measured days and the capacity they give, kept until the ledger changes (it is read on every schedule derivation). */
export function measuredView(ctx: AccessContext, now = appNow()): MeasuredView {
  const today = planToday(ctx, now);
  return memoByLedger(getStore(), `measured:${ctx.workspaceId}:${today}`, 10 * 60_000, () => {
    const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
    const first = plusDays(today, -CAPACITY_LOOKBACK_DAYS);
    const dayList = Array.from({ length: CAPACITY_LOOKBACK_DAYS + 1 }, (_, index) => plusDays(first, index));
    const dayStarts = dayList.flatMap((day) => { try { return [{ day, start: Date.parse(toZonedInstant(day, "00:00", zone)) }]; } catch { return []; } });
    const since = dayStarts[0]?.start ?? now.getTime() - CAPACITY_LOOKBACK_DAYS * DAY;
    const screen = screenSpans(ctx, new Date(since).toISOString(), zone);
    const hourly = hourlyActive(ctx).filter((hour) => Date.parse(hour.start) >= since);
    const signals: MeasuredSignals = { timer: timerSpans(ctx, now), screen: screen.spans, agent: agentSpans(ctx), hourly, segmentDays: screen.days,
      confirmedDays: confirmedDays(ctx, first), fileChanges: fileChanges(ctx, since) };
    const days = measuredWorkDays(signals, dayStarts);
    const hasScreen = screen.days.length > 0 || hourly.some((hour) => hour.active > 0);
    const capacity = measuredCapacity(days, { hasScreen });
    const weeklyHours = measuredWeeklyHours(days);
    return { days, capacity, basis: planBasisOf(capacity), hasScreen, ...(weeklyHours !== undefined ? { weeklyHours } : {}) };
  });
}

/**
 * The minutes of work `day` may hold: the measured cap, or half of what the person's own hours leave that day (`statedMinutes`). With
 * measured capacity off (tests), the stated minutes as they are.
 */
export function dayCapacityOf(ctx: AccessContext, day: string, statedMinutes: number, view = measuredView(ctx)): number {
  return enabled ? Math.min(statedMinutes, dayCapacityMinutes(view.capacity, day, statedMinutes)) : statedMinutes;
}

/**
 * Work minutes inside one block, every signal joined in time: this task's own timer, the screen in work categories, Codex and Claude
 * Code. What the block's inferred outcome is read from (`inferBlockOutcome`).
 */
export function blockWorkMinutes(ctx: AccessContext, orderId: string, from: string, to: string, now = appNow()): number {
  const start = Date.parse(from), end = Math.min(Date.parse(to), now.getTime());
  if (!(end > start)) return 0;
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const spans = mergeSpans([...timerSpans(ctx, now, orderId), ...screenSpans(ctx, new Date(start).toISOString(), zone).spans, ...agentSpans(ctx)]);
  return Math.round(minutesWithin(spans, start, end));
}

/** For the worker (`date-advance`, `schedule-window`): the minutes each kind of day may hold, written by the web's attention timer. */
export function writeMeasuredCapacity(ctx: AccessContext, now = appNow()): void {
  if (!enabled) return;
  const view = measuredView(ctx, now);
  const { minutes: stated } = statedDaily(ctx);
  const record: MeasuredCapacityRecord = { at: now.toISOString(), basis: view.basis,
    weekday: view.capacity.weekday.minutes ?? Math.round(stated * 0.5), weekend: view.capacity.weekend.minutes ?? Math.round(stated * 0.5) };
  getStore().setSetting(ctx.workspaceId, MEASURED_CAPACITY_SETTING, JSON.stringify(record));
}

/** What the person said a day holds, on average: the weekly pattern's hours over seven days. */
function statedDaily(ctx: AccessContext): { minutes: number } {
  return { minutes: Math.round(weeklyAvailableHours(readAvailability(ctx)) * 60 / 7) };
}

/**
 * The minutes of work each planned day may still hold (`PlanningInput.dailyCapMinutes`): the day's cap, and for today the cap less what
 * was already worked today outside the blocks the plan keeps frozen (those count against the cap in the planner). `statedByDay` is what
 * the person's own hours leave each day after the calendar. Undefined with measured capacity off.
 */
export function dailyCapsFor(ctx: AccessContext, today: string, statedByDay: Map<string, number>, frozen: Span[], now = appNow()): Record<string, number> | undefined {
  if (!enabled) return undefined;
  const view = measuredView(ctx, now);
  const caps: Record<string, number> = {};
  for (const [day, stated] of statedByDay) caps[day] = dayCapacityOf(ctx, day, stated, view);
  if (caps[today] === undefined) return caps;
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  let from: number;
  try { from = Date.parse(toZonedInstant(today, "00:00", zone)); } catch { return caps; }
  const to = now.getTime();
  const worked = mergeSpans([...timerSpans(ctx, now), ...screenSpans(ctx, new Date(from).toISOString(), zone).spans, ...agentSpans(ctx)]);
  const inFrozen = mergeSpans(frozen).reduce((sum, span) => sum + minutesWithin(worked, Math.max(from, span.start), Math.min(to, span.end)), 0);
  const outside = Math.max(0, minutesWithin(worked, from, to) - inFrozen);
  caps[today] = Math.max(0, Math.round(caps[today]! - outside));
  return caps;
}

/** The plan's basis in numbers, for the pages: what the person said a week holds, what was measured, and which the plan follows. */
export type CapacityLine = { statedWeekly: number | null; measuredWeekly: number | null; basis: PlanCapacityBasis | "off" };
export function capacityLine(ctx: AccessContext, statedWeekly: number | null, now = appNow()): CapacityLine {
  const view = measuredView(ctx, now);
  return { statedWeekly, measuredWeekly: view.weeklyHours ?? null, basis: enabled ? view.basis : "off" };
}
