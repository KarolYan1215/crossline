import "server-only";
import { CALENDAR_PUBLISH_FAILURE, type AccessContext } from "@crossline/core";
import { effectiveSchedulePreferences, getStore, loadCurrentPlan, planToday, toZonedInstant } from "./crossline";
import { optimalWaitingMs } from "./optimal-schedule";

/** How long the automatic publish waits for the optimal plan before writing the greedy one. */
export const OPTIMAL_WAIT_MS = 60_000;

export type PublishBlockInput = { id: string; title: string; start: string; end: string; reminderMinutes?: number | null };

/** Work blocks remind ten minutes ahead (the person asked for every block); follow-ups and deadline warnings at their start. */
export const BLOCK_REMINDER_MINUTES = 10;
/** A deadline is announced this many days ahead on the Crossline calendar. */
export const DEADLINE_NOTICE_DAYS = 2;

/**
 * The blocks the scheduler placed for work orders, as instants. Only these go to the Crossline calendar: real calendar events,
 * imported class meetings and everything else on the plan came from the person and are never written back anywhere.
 * The plan takes effect by default (docs/loop-and-scout.md §1), so there is no approval to wait for; what may be written is the writer's
 * boundary: only the calendar named Crossline, only events this app made and the person has not changed, deletes only in the future.
 */
export async function blocksToPublish(ctx: AccessContext, now = new Date(), options: { waitForOptimal?: boolean } = {}):
  Promise<{ blocks: PublishBlockInput[]; pending?: true }> {
  const plan = await loadCurrentPlan(ctx);
  // The automatic publish writes the optimal plan, not the greedy one shown while it is solved (docs/loop-and-scout.md §2): for up to a
  // minute after this input was first asked for it reports `pending` and writes nothing; after that the greedy plan is written. The
  // person's own click on 发布 never waits.
  const { inputHash, optimal } = plan.schedule ?? {};
  if (options.waitForOptimal && inputHash && !optimal) {
    const waited = optimalWaitingMs(ctx, inputHash);
    if (waited !== undefined && waited < OPTIMAL_WAIT_MS) return { blocks: [], pending: true };
  }
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const blocks = plan.blocks.flatMap((block) => {
    if (!block.id.startsWith("scheduled:") || !block.day) return [];
    // The demo work orders every new account is seeded with are there to show the flow, not to claim the person's time.
    if (block.id.split(":")[1]?.endsWith("-starter-work-order")) return [];
    try {
      const start = toZonedInstant(block.day, block.start, zone);
      const end = toZonedInstant(block.day, block.end === "24:00" ? "23:59" : block.end, zone);
      return Date.parse(end) > now.getTime() && Date.parse(end) > Date.parse(start) ? [{ id: block.id, title: block.title, start, end, reminderMinutes: BLOCK_REMINDER_MINUTES }] : [];
    } catch { return []; }
  });
  return { blocks: [...blocks, ...noticeBlocks(ctx, now)] };
}

/**
 * Two kinds of short marker events beside the work blocks, each reminding at its start so Outlook and the phone
 * deliver it: the day something the person waits for is due (「跟进：师兄的数据到了吗？」), and two days before an
 * approved milestone's deadline. Fifteen minutes at the start of the day, shown as free like everything written here.
 */
export function noticeBlocks(ctx: AccessContext, now = new Date()): PublishBlockInput[] {
  const store = getStore();
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx, now);
  const marker = (id: string, title: string, day: string): PublishBlockInput[] => {
    try {
      const start = toZonedInstant(day, "09:00", zone);
      const end = toZonedInstant(day, "09:15", zone);
      return Date.parse(end) > now.getTime() ? [{ id, title, start, end, reminderMinutes: 0 }] : [];
    } catch { return []; }
  };
  const followUps = store.listWaitingItems(ctx.workspaceId, { state: "open" }).filter((item) => item.followUpAt >= today)
    .flatMap((item) => marker(`followup:${item.id}`, `跟进：${item.who ? `${item.who}的` : ""}${item.title}到了吗？`, item.followUpAt));
  const approved = new Map(store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved").map((milestone) => [milestone.id, milestone]));
  const deadlines = store.listMilestoneAnchors(ctx.workspaceId).flatMap((anchor) => {
    const milestone = approved.get(anchor.milestoneId);
    if (!milestone || !anchor.deadline) return [];
    const day = new Date(Date.parse(`${anchor.deadline}T00:00:00Z`) - DEADLINE_NOTICE_DAYS * 86_400_000).toISOString().slice(0, 10);
    return day >= today ? marker(`deadline:${milestone.id}`, `${DEADLINE_NOTICE_DAYS} 天后到期：${milestone.title}`, day) : [];
  });
  return [...followUps, ...deadlines];
}

export type PublishStatus = {
  /** An account to write with was chosen (`calendar.write.account`). */
  account: boolean;
  /** The last write that went through, and what it did. */
  last?: { at: string; created: number; updated: number; deleted: number; unchanged: number; keptAsEdited: number };
  /** The last write that did not, in the person's words; `relogin` when the account's sign-in has lapsed. */
  failure?: { at: string; text: string; relogin: boolean };
};

/** What the calendar card says about writing the Crossline calendar: when it last went through, and why it did not if it did not. */
export function publishStatus(ctx: AccessContext): PublishStatus {
  const store = getStore();
  const account = Boolean(store.getSetting(ctx.workspaceId, "calendar.write.account"));
  const event = store.listEvents(ctx.workspaceId, { type: "calendar.published" }).at(-1);
  const payload = event?.payload as { created?: number; updated?: number; deleted?: number; unchanged?: number; keptAsEdited?: number } | undefined;
  let failure: PublishStatus["failure"];
  try {
    const raw = JSON.parse(store.getSetting(ctx.workspaceId, CALENDAR_PUBLISH_FAILURE) || "null") as { code?: string; message?: string; at?: string } | null;
    if (raw?.code && raw.at) {
      const relogin = raw.code === "CALENDAR_WRITE_NOT_AUTHORIZED";
      failure = { at: raw.at, relogin, text: relogin ? "写入账号的登录已过期或未授权，需要本人重新登录" : raw.code === "CODEX_SUPERVISOR_UNAVAILABLE"
        ? "后台服务未运行，恢复后自动重试" : raw.code === "GRAPH_NOT_CONFIGURED" ? "本机没有配置 Microsoft 日历" : "上次写入未完成，下次自动重试" };
    }
  } catch { /* unreadable: none */ }
  return { account, ...(event && payload ? { last: { at: event.createdAt, created: payload.created ?? 0, updated: payload.updated ?? 0, deleted: payload.deleted ?? 0,
    unchanged: payload.unchanged ?? 0, keptAsEdited: payload.keptAsEdited ?? 0 } } : {}), ...(failure ? { failure } : {}) };
}
