import "server-only";
import { taskTitleOf, type AccessContext, type RealityChange } from "@crossline/core";
import type { PersistedScheduleBlock } from "./schedule";
import { getStore } from "./store";
import { appNow } from "./clock";

/**
 * 「作业 3 因 11:30 会议后移 30 分钟」 (docs/loop-and-scout.md §1): when a calendar change has come in since the schedule was last looked
 * at, each work block whose old time the new event now covers is named with where it went and why. Kept as `schedule.changeSummary`
 * (`{ at, realityAt, items, basis }`, the latest only); `basis` is the scheduled blocks' times the next comparison starts from. The
 * re-plan itself is derived on read and has nothing to undo, so the way back is 「钉回原位」: lock that block at its old time.
 */
export const CHANGE_SUMMARY = "schedule.changeSummary";
export type ScheduleChange = { blockId: string; title: string; day: string; from: { start: string; end: string }; to: { day: string; start: string; end: string }; cause: string };
type ChangeSummary = { at: string; realityAt: string; items: ScheduleChange[]; basis: Record<string, { day: string; start: string; end: string }> };
export function noteScheduleChanges(ctx: AccessContext, committed: PersistedScheduleBlock[], blocks: PersistedScheduleBlock[], now: Date): void {
  const store = getStore();
  let saved: Partial<ChangeSummary> = {};
  try { saved = JSON.parse(store.getSetting(ctx.workspaceId, CHANGE_SUMMARY) ?? "{}"); } catch { /* none */ }
  const basis = Object.fromEntries(blocks.filter((block) => block.id.startsWith("scheduled:") && block.day)
    .map((block) => [block.id, { day: block.day!, start: block.start, end: block.end }]));
  const reality = store.listEvents(ctx.workspaceId, { type: "plan.reality_changed" }).at(-1);
  const realityAt = reality?.createdAt ?? "";
  const sameBasis = JSON.stringify(basis) === JSON.stringify(saved.basis ?? {});
  if (sameBasis && realityAt === (saved.realityAt ?? "")) return;
  let items = saved.items ?? [];
  let at = saved.at ?? now.toISOString();
  if (reality && realityAt !== saved.realityAt && saved.basis) {
    const added = new Set(((reality.payload as { changes?: RealityChange[] }).changes ?? []).filter((change) => change.kind !== "remove").map((change) => change.blockId));
    const external = committed.filter((block) => added.has(block.id) && block.day);
    const titles = new Map(blocks.map((block) => [block.id, block.title]));
    items = Object.entries(saved.basis).flatMap(([blockId, before]) => {
      const after = basis[blockId];
      if (!after || (after.day === before.day && after.start === before.start && after.end === before.end)) return [];
      const cause = external.find((block) => block.day === before.day && block.start < before.end && block.end > before.start);
      return cause ? [{ blockId, title: titles.get(blockId) ?? blockId, day: before.day, from: { start: before.start, end: before.end },
        to: after, cause: `${cause.start} ${cause.title}` }] : [];
    });
    at = now.toISOString();
  }
  store.setSetting(ctx.workspaceId, CHANGE_SUMMARY, JSON.stringify({ at, realityAt, items, basis } satisfies ChangeSummary));
}
/** What Today shows: the last summary while it is under a day old. */
export function readChangeSummary(ctx: AccessContext, now = appNow()): ScheduleChange[] {
  try {
    const saved = JSON.parse(getStore().getSetting(ctx.workspaceId, CHANGE_SUMMARY) ?? "{}") as Partial<ChangeSummary>;
    return saved.at && now.getTime() - Date.parse(saved.at) < 86_400_000 ? saved.items ?? [] : [];
  } catch { return []; }
}

/**
 * Steps split again because they did not get done on two days (adaptive granularity, `requestFinerSplits` in the worker): named in the
 * change summary on Today for a day once the smaller plan exists. Said there and nowhere else — no push, nothing to answer.
 */
export type FinerSplitNote = { orderId: string; title: string; step: string; days: number };
/** The states the step planner plans in (`PLANNABLE` in apps/worker/src/step-planner.ts). */
const FINER_SPLIT_STATES = new Set(["approved", "preparing", "ready_for_human", "active"]);
export function readFinerSplits(ctx: AccessContext, now = appNow()): FinerSplitNote[] {
  const store = getStore();
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const planned = store.listEvents(ctx.workspaceId, { type: "task.steps_planned" });
  return store.listEvents(ctx.workspaceId, { type: "task.steps_replan_requested" }).flatMap((event) => {
    const split = (event.payload as { finerSplit?: { title?: string; days?: string[] } }).finerSplit;
    const order = orders.get(event.entityId);
    const redone = planned.find((item) => item.entityId === event.entityId && item.createdAt > event.createdAt);
    if (!split || !order || !redone || now.getTime() - Date.parse(redone.createdAt) >= 86_400_000) return [];
    // Said only while the smaller plan is the person's to do (W-280: a task whose new steps were all the assistant's, already marked
    // done, was announced as 「已拆成更小的步骤」): the task still committed, and a step of the person's still open on the calendar.
    if (!FINER_SPLIT_STATES.has(order.state)) return [];
    const steps = store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? [];
    if (!steps.some((step) => step.status === "planned" && step.schedulable && step.executor !== "agent")) return [];
    return [{ orderId: order.id, title: taskTitleOf(order), step: split.title ?? "", days: split.days?.length ?? 2 }];
  });
}

/** The most recent `plan.explained` event for today, if the explainer has ever run for it. Read from
 * the ledger like `lastNight` — there is no separate "current explanation" row, just the event trail. */
export function loadPlanExplanation(ctx: AccessContext, today: string): {
  summary: string; nextActionReason: string; alternatives: Array<{ id: string; reason: string }>;
} | null {
  const event = [...getStore().listEvents(ctx.workspaceId, { type: "plan.explained", entityId: today })].at(-1);
  if (!event) return null;
  const payload = event.payload as { summary?: string; nextActionReason?: string; alternatives?: Array<{ id: string; reason: string }> };
  if (!payload.summary || !payload.nextActionReason) return null;
  return { summary: payload.summary, nextActionReason: payload.nextActionReason, alternatives: payload.alternatives ?? [] };
}

export type CalendarConnectorState = {
  /** A stored delta cursor is proof a sync really completed; nothing else writes one. */
  synced: boolean;
  importedBlocks: number;
  lastChangeAt: string | null;
  lastChangeCount: number;
};

/**
 * What the calendar connector has actually done, read from the ledger rather than declared.
 *
 * The Connections page used to say "未配置凭据，未执行探测" for every row including the one connector
 * that was working — the page whose whole job is "what is connected" was wrong about the only thing
 * that was. Declared status and observed status are different claims, and only the second is useful.
 */
export function loadCalendarConnectorState(ctx: AccessContext): CalendarConnectorState {
  const store = getStore();
  const plan = store.listPlanVersions(ctx.workspaceId)[0];
  const blocks = ((plan?.payload as { blocks?: Array<{ id?: string }> } | undefined)?.blocks ?? [])
    .filter((block) => String(block.id).startsWith("graph_calendar:"));
  const last = store.listEvents(ctx.workspaceId, { type: "plan.reality_changed" }).at(-1);
  return {
    synced: store.hasAnySyncCursor(ctx.workspaceId, "graph_calendar"),
    importedBlocks: blocks.length,
    lastChangeAt: last?.createdAt ?? null,
    lastChangeCount: ((last?.payload as { changes?: unknown[] } | undefined)?.changes ?? []).length
  };
}
