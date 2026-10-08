"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CalendarPanel } from "../timeline/calendar-panel";
import type { TimelineDeadline, TimelineItem } from "../timeline/model";

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
  status: "draft" | "approved" | "superseded";
  blocks: ScheduleBlockData[];
  schedule?: { status: "feasible" | "partial" | "infeasible";
    blockers: Array<{ taskId: string; code: string; message: string }>;
    solver: "optimal" | "feasible_time_limit" | "fallback" | "empty" | "no_capacity"; bufferRelaxed?: boolean;
    notes?: Array<{ taskId: string; code: string; message: string }> };
  changes: Array<{ id: string; kind: "add" | "move" | "remove" | "conflict"; explanation: string; afterBlockId?: string; status: "pending" | "approved" | "excluded" }>;
};

export type CalendarData = {
  today: string; nowIso: string; timeZone: string; items: TimelineItem[]; deadlines: TimelineDeadline[];
  labels: Record<string, string>; quietByWeekday: Record<number, Array<[string, string]>>;
};

const statusLabel = { draft: "草案", approved: "已批准", superseded: "已被替代", pending: "待处理", excluded: "已排除" } as const;
const changeLabel = { add: "新增", move: "移动", remove: "移除", conflict: "冲突" } as const;

/**
 * The plan: one calendar (day, week, month over the same blocks), what the scheduler could not place, and the
 * differences waiting for a decision. Reading the calendar is the default; the decisions are folded under it
 * and announced by a count, so they are never the first thing on the page unless there is something to decide.
 */
/**
 * The planner reports one blocker per unplaced *step*, while 「为什么这样排」 lists tasks — counting blockers said 「13 项未排入」 over a list
 * with one. Counted per task here: wholly unplaced, and placed in part (some steps have a block, some do not).
 */
function unplacedNote(plan: PlanVersionData): string {
  const blocked = new Set((plan.schedule?.blockers ?? []).map((blocker) => blocker.taskId.split("#")[0]!));
  if (!blocked.size) return "";
  const placed = new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:")).map((block) => block.id.split(":")[1]));
  const partial = [...blocked].filter((id) => placed.has(id)).length, none = blocked.size - partial;
  return [none ? `${none} 个任务未排入` : "", partial ? `${partial} 个任务部分步骤未排入` : ""].filter(Boolean).join("，");
}

export function PlanView({ plan, calendar }: { plan: PlanVersionData; calendar: CalendarData }) {
  const [approvalState, setApprovalState] = useState<"idle" | "saving" | "error">("idle");
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncNote, setSyncNote] = useState("");
  const [publishState, setPublishState] = useState<"idle" | "publishing" | "done" | "error">("idle");
  const [publishNote, setPublishNote] = useState("");
  const pending = plan.changes.filter((change) => change.status === "pending");

  const syncNow = async () => {
    setSyncState("syncing");
    const response = await fetch("/api/calendar/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; changes?: number; code?: string } | undefined;
    if (!response?.ok || !body?.ok) {
      setSyncNote(body?.code === "CALENDAR_SYNC_UNAVAILABLE" ? "worker 不可用或未登录日历" : body?.code ?? "同步失败");
      setSyncState("error");
      return;
    }
    // A reload only when something moved: reloading on every click would hide the "nothing changed" answer.
    if (body.changes && body.changes > 0) { window.location.reload(); return; }
    setSyncNote("日历没有变化");
    setSyncState("done");
  };
  // Writes only the blocks the scheduler placed, and only to the calendar named Crossline. Only an approved plan is written; the route enforces it.
  const publish = async () => {
    setPublishState("publishing");
    const response = await fetch("/api/calendar/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; message?: string; code?: string;
      result?: { created: number; updated: number; deleted: number; unchanged: number; keptAsEdited: string[] } } | undefined;
    if (!response?.ok || (body?.state && body.state !== "published")) {
      setPublishNote(body?.message ?? (body?.code === "CALENDAR_PUBLISH_UNAVAILABLE" || !response ? "worker 不可用" : body?.code ?? "写入失败"));
      setPublishState("error");
      return;
    }
    const r = body?.result;
    setPublishNote(r ? `Crossline 日历：新增 ${r.created}、调整 ${r.updated}、移除 ${r.deleted}、不变 ${r.unchanged}${r.keptAsEdited.length ? `；${r.keptAsEdited.length} 条已被手动修改，保持原样` : ""}。` : "已写入。");
    setPublishState("done");
  };
  const resolve = async (changeId: string, status: "approved" | "excluded") => {
    const response = await fetch(`/api/plans/changes/${encodeURIComponent(changeId)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status })
    });
    if (response.ok) location.reload(); else setApprovalState("error");
  };
  const approve = async () => {
    setApprovalState("saving");
    const response = await fetch(`/api/plans/${encodeURIComponent(plan.id)}/approve`, { method: "POST" });
    if (!response.ok) { setApprovalState("error"); return; }
    window.location.reload();
  };

  // The version's approval, shown on its own when there are no differences and under the ledger when there are.
  const approval = <footer>
    {plan.status === "draft" ? <Dialog.Root>
      <Dialog.Trigger asChild><button type="button">批准本批变更</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-sheet">
          <Dialog.Title>批准计划 v{plan.version}？</Dialog.Title>
          <Dialog.Description>{pending.length} 项待处理差异一并批准；批准后 Crossline 日历按本版本写入。</Dialog.Description>
          {approvalState === "error" && <p role="alert">批准未完成：请先处理冲突类差异。</p>}
          <div className="dialog-actions">
            <Dialog.Close asChild><button type="button" className="secondary">返回检查</button></Dialog.Close>
            <button type="button" disabled={approvalState === "saving"} onClick={approve}>{approvalState === "saving" ? "批准中…" : "确认批准"}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root> : <strong className="approved-mark">✓ 本版本已批准</strong>}
    <small>批准后写入 Crossline 日历</small>
  </footer>;
  return <div className="plan-view" data-plan-version={plan.id}>
    <div className="plan-bar">
      <span className="tag">计划 v{plan.version} · {statusLabel[plan.status]}</span>
      {pending.length > 0 && <a className="plan-pending" href="#plan-changes">{pending.length} 项差异待处理 ↓</a>}
      {/* Reality moves between ticks, and fifteen minutes of not knowing whether the plan has caught up is
          exactly when a person stops trusting it. This only reads the calendar. */}
      <button type="button" className="plan-sync" disabled={syncState === "syncing"} onClick={syncNow}>
        {syncState === "syncing" ? "读取日历中…" : syncState === "error" ? "同步失败，重试" : "立即同步日历"}
      </button>
      {syncState === "done" && <span role="status" className="plan-sync-note">{syncNote}</span>}
      {/* The one place the app writes to a calendar: a separate calendar named Crossline, events it made itself. */}
      {/* Publishing also runs on its own every ten minutes; this is the manual nudge, so it is an icon rather than a labelled button. */}
      <button type="button" className="plan-sync plan-sync-icon" disabled={publishState === "publishing" || plan.status !== "approved"} onClick={publish}
        aria-label="立即写入 Crossline 日历"
        title={plan.status === "approved" ? "立即写入 Crossline 日历（每 10 分钟自动写入；只写名为 Crossline 的日历）" : "计划批准后写入 Crossline 日历"}>
        {publishState === "publishing" ? "…" : "⇪"}
      </button>
      {(publishState === "done" || publishState === "error") && <span role="status" className="plan-sync-note">{publishNote}</span>}
    </div>

    {plan.schedule && (plan.schedule.solver !== "empty" || plan.schedule.blockers.length > 0) && <section className="schedule-status" role="status">
      <strong>{plan.schedule.status === "feasible" ? "建议时段已排入"
        : plan.schedule.status === "partial" ? "部分任务未排入" : "当前没有可行的建议时段"}</strong>
      {plan.schedule.solver === "feasible_time_limit" && <p>已显示验证过的可行安排；未证明最优。</p>}
      {plan.schedule.solver === "fallback" && <p>这次没算出最优排法，先用一份简单排法，每块都核对过不冲突。</p>}
      {plan.schedule.solver === "no_capacity" && <p>可用时间里已经没有空档，下面这些暂时排不进去。</p>}
      {plan.schedule.bufferRelaxed && <p>为守住已确认截止时间，已放宽当天的缓冲规则。</p>}
      {unplacedNote(plan) && <p><a href="#why">{unplacedNote(plan)}，原因见「为什么这样排」</a></p>}
      {plan.schedule.notes?.map((note) => <p key={`note-${note.taskId}`}>{note.message}</p>)}
    </section>}

    <CalendarPanel items={calendar.items} deadlines={calendar.deadlines} today={calendar.today} nowIso={calendar.nowIso}
      timeZone={calendar.timeZone} labels={calendar.labels} quietByWeekday={calendar.quietByWeekday} />

    {/* With no differences there is nothing to fold: only the version's approval is shown. The ledger of differences is a fold
        (low-frequency history) that opens by itself while something in it waits for a decision. */}
    {plan.changes.length === 0 ? <section className="plan-changes" id="plan-changes"><div className="change-ledger">
      {approval}
    </div></section> : <details className="plan-changes advanced" id="plan-changes" open={pending.length > 0}>
      <summary>计划差异（{pending.length} 项待处理，共 {plan.changes.length} 项）</summary>
      <div className="change-ledger">
        {plan.changes.map((change) => <article key={change.id}>
          <b>{changeLabel[change.kind]}</b>
          <p>{change.explanation}</p>
          <span>
            {statusLabel[change.status]}
            {/* A conflict with no way out would block approval forever, so every pending one is resolvable here.
                Excluding is a decision the ledger records, not a deletion. */}
            {change.status === "pending" && <span className="change-resolve">
              <button type="button" onClick={() => void resolve(change.id, "approved")}>采纳</button>
              <button type="button" onClick={() => void resolve(change.id, "excluded")}>排除</button>
            </span>}
          </span>
        </article>)}
        {approval}
      </div>
    </details>}
  </div>;
}
