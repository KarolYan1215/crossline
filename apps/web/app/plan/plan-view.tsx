"use client";

import { useState, type ReactNode } from "react";
import type { TimelineDeadline, TimelineItem } from "../timeline/model";
import { unplacedTaskIds } from "../../lib/unplaced";

export type ScheduleBlockData = {
  id: string;
  lane: "human" | "ai";
  title: string;
  /** The calendar day this block belongs to; a block with none follows whichever day is being looked at. */
  day?: string;
  start: string;
  end: string;
  source: string;
  readOnly: boolean;
};

export type PlanVersionData = {
  id: string;
  version: number;
  blocks: ScheduleBlockData[];
  schedule?: { status: "feasible" | "partial" | "infeasible";
    blockers: Array<{ taskId: string; code: string; message: string }>;
    solver: "optimal" | "feasible_time_limit" | "fallback" | "empty" | "no_capacity"; bufferRelaxed?: boolean; optimal?: boolean;
    notes?: Array<{ taskId: string; code: string; message: string }> };
};

/** Today's calendar data (the plan page no longer draws a calendar; Today imports this type from here). */
export type CalendarData = {
  today: string; nowIso: string; timeZone: string; items: TimelineItem[]; deadlines: TimelineDeadline[];
  labels: Record<string, string>; quietByWeekday: Record<number, Array<[string, string]>>; proposals?: Array<{ id: string; title: string }>;
};


/**
 * Counted per task (`unplacedTaskIds`): wholly unplaced, and placed in part (some steps have a block, some do not). Counting blockers
 * once said 「13 项未排入」 over a list with one.
 */
function unplacedNote(plan: PlanVersionData): string {
  const blocked = unplacedTaskIds(plan.schedule?.blockers ?? []);
  if (!blocked.size) return "";
  const placed = new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:")).map((block) => block.id.split(":")[1]));
  const partial = [...blocked].filter((id) => placed.has(id)).length, none = blocked.size - partial;
  return [none ? `${none} 个任务未排入` : "", partial ? `${partial} 个任务部分步骤未排入` : ""].filter(Boolean).join("，");
}

/**
 * The plan page's top row (decided 2026-10-10: the calendar is on Today only): reading the calendar now, writing to the Crossline
 * calendar, the horizon (`aside`), and the schedule's status. The plan takes effect by default (docs/loop-and-scout.md §1): there is
 * no version to approve and no difference to settle.
 */
/**
 * `calendarWrite`: an account to write the Crossline calendar with is chosen. Without one (the hosted beta has no Microsoft calendar at
 * all) there is nothing to publish to, so the button is not offered (2026-10-17 walkthrough, W-20).
 */
export function PlanView({ plan, aside, calendarWrite = false }: { plan: PlanVersionData; aside?: ReactNode; calendarWrite?: boolean }) {
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncNote, setSyncNote] = useState("");
  const [publishState, setPublishState] = useState<"idle" | "publishing" | "done" | "error">("idle");
  const [publishNote, setPublishNote] = useState("");

  const syncNow = async () => {
    setSyncState("syncing");
    const response = await fetch("/api/calendar/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; changes?: number; code?: string } | undefined;
    if (!response?.ok || !body?.ok) {
      setSyncNote(body?.code === "CALENDAR_SYNC_UNAVAILABLE" ? "后台服务未运行或日历未登录，稍后重试" : "同步失败，稍后重试");
      setSyncState("error");
      return;
    }
    // A reload only when something moved: reloading on every click would hide the "nothing changed" answer.
    if (body.changes && body.changes > 0) { window.location.reload(); return; }
    setSyncNote("日历没有变化");
    setSyncState("done");
  };
  // Writes only the blocks the scheduler placed, and only to the calendar named Crossline; it also runs on its own every ten minutes.
  const publish = async () => {
    setPublishState("publishing");
    const response = await fetch("/api/calendar/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; message?: string; code?: string;
      result?: { created: number; updated: number; deleted: number; unchanged: number; keptAsEdited: string[] } } | undefined;
    if (!response?.ok || (body?.state && body.state !== "published")) {
      setPublishNote(body?.message ?? (body?.code === "CALENDAR_PUBLISH_UNAVAILABLE" || !response ? "后台服务未运行，稍后重试" : "写入失败，稍后重试"));
      setPublishState("error");
      return;
    }
    const r = body?.result;
    setPublishNote(r ? `Crossline 日历：新增 ${r.created}、调整 ${r.updated}、移除 ${r.deleted}、不变 ${r.unchanged}${r.keptAsEdited.length ? `；${r.keptAsEdited.length} 条已被手动修改，保持原样` : ""}。` : "已写入。");
    setPublishState("done");
  };

  return <div className="plan-view" data-plan-version={plan.id}>
    <div className="plan-bar">
      {/* Reality moves between ticks, and fifteen minutes of not knowing whether the plan has caught up is
          exactly when a person stops trusting it. This only reads the calendar. */}
      <button type="button" className="plan-sync" disabled={syncState === "syncing"} onClick={syncNow}>
        {syncState === "syncing" ? "读取日历中…" : syncState === "error" ? "同步失败，重试" : "立即同步日历"}
      </button>
      {syncState === "done" && <span role="status" className="plan-sync-note">{syncNote}</span>}
      {calendarWrite && <button type="button" className="plan-sync" disabled={publishState === "publishing"} onClick={publish}
        title="立即写入 Crossline 日历（每 10 分钟自动写入；只写名为 Crossline 的日历）">
        {publishState === "publishing" ? "写入中…" : "发布到 Crossline 日历"}
      </button>}
      {(publishState === "done" || publishState === "error") && <span role="status" className="plan-sync-note">{publishNote}</span>}
      {aside && <span className="plan-bar-aside">{aside}</span>}
    </div>

    {plan.schedule && (plan.schedule.solver !== "empty" || plan.schedule.blockers.length > 0) && <section className="schedule-status" role="status">
      <strong>{plan.schedule.status === "feasible" ? "建议时段已排入"
        : plan.schedule.status === "partial" ? "部分任务未排入" : "当前没有可行的建议时段"}</strong>
      {plan.schedule.solver === "feasible_time_limit" && <p>已显示验证过的可行安排；未证明最优。</p>}
      {plan.schedule.solver === "fallback" && (plan.schedule.optimal
        ? <p>这次没算出最优排法，先用一份简单排法，每块都核对过不冲突。</p>
        : <p>最优排法正在后台计算，算好后自动替换当前的简单排法。</p>)}
      {plan.schedule.solver === "no_capacity" && <p>可用时间里已经没有空档，下面这些暂时排不进去。</p>}
      {plan.schedule.bufferRelaxed && <p>为守住已确认截止时间，已放宽当天的缓冲规则。</p>}
      {unplacedNote(plan) && <p><a href="#why">{unplacedNote(plan)}，原因见「排程顺序」</a></p>}
      {plan.schedule.notes?.map((note) => <p key={`note-${note.taskId}`}>{note.message}</p>)}
    </section>}
  </div>;
}
