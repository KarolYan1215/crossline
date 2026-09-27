"use client";

import { useState, type KeyboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CalendarDetail } from "./calendar-detail";

export type ScheduleBlockData = {
  id: string;
  lane: "human" | "ai";
  title: string;
  /**
   * The calendar day this block belongs to. Absent on the seeded example blocks on purpose: they
   * illustrate a typical day, so they follow whichever day you are looking at instead of being pinned
   * to a date that goes stale tomorrow.
   */
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
    solver: "optimal" | "feasible_time_limit" | "fallback"; bufferRelaxed?: boolean };
  changes: Array<{ id: string; kind: "add" | "move" | "remove" | "conflict"; explanation: string; afterBlockId?: string; status: "pending" | "approved" | "excluded" }>;
};

const tabs = [["B", "双轨时间轴"], ["C", "计划差异"], ["A", "日 / 周"]] as const;
const statusLabel = { draft: "草案", approved: "已批准", superseded: "已被替代", pending: "待处理", excluded: "已排除" } as const;
const changeLabel = { add: "新增", move: "移动", remove: "移除", conflict: "冲突" } as const;

export function PlanView({ plan, today, workOrderMilestones = {} }: { plan: PlanVersionData; today: string; workOrderMilestones?: Record<string, string> }) {
  // Only a `scheduled:<workOrderId>` (optionally `:<index>` for a repeated occurrence) block traces back
  // to one work order; a real calendar import or a seeded example carries no such id, so it gets no
  // milestone tag rather than a wrong one.
  const milestoneOf = (block: ScheduleBlockData) => block.id.startsWith("scheduled:")
    ? workOrderMilestones[block.id.split(":")[1]!] : undefined;
  const [view, setView] = useState<"B" | "C" | "A">("B");
  const [approvalState, setApprovalState] = useState<"idle" | "saving" | "error">("idle");
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [syncNote, setSyncNote] = useState("");
  const syncNow = async () => {
    setSyncState("syncing");
    const response = await fetch("/api/calendar/sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as
      { ok?: boolean; changes?: number; state?: string; code?: string } | undefined;
    if (!response?.ok || !body?.ok) {
      setSyncNote(body?.code === "CALENDAR_SYNC_UNAVAILABLE" ? "worker 不可用或未登录日历" : body?.code ?? "同步失败");
      setSyncState("error");
      return;
    }
    // A reload only when something moved: reloading on every click would hide the "nothing changed"
    // answer, which is the one the person is usually checking for.
    if (body.changes && body.changes > 0) { window.location.reload(); return; }
    setSyncNote("日历没有变化");
    setSyncState("done");
  };
  const resolve = async (changeId: string, status: "approved" | "excluded") => {
    const response = await fetch(`/api/plans/changes/${encodeURIComponent(changeId)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status })
    });
    if (response.ok) location.reload(); else setApprovalState("error");
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!new Set(["ArrowLeft", "ArrowRight", "Home", "End"]).has(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const id = tabs[next]![0];
    setView(id);
    (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
  };
  const approve = async () => {
    setApprovalState("saving");
    const response = await fetch(`/api/plans/${encodeURIComponent(plan.id)}/approve`, { method: "POST" });
    if (!response.ok) {
      setApprovalState("error");
      return;
    }
    window.location.reload();
  };
  const lane = (kind: "human" | "ai", title: string) => <section className={`plan-lane ${kind}`}>
    <header><span>{title}</span><small>{kind === "human" ? "现实约束与人工核心" : "提前准备，不占用人工时间"}</small></header>
    {/* B is a day strip: a block for another day belongs in the A lens, not stacked onto today. */}
    <div className="lane-track">{plan.blocks.filter((block) => block.lane === kind && (block.day ?? today) === today).map((block) => <article key={block.id} className={block.readOnly ? "readonly" : "draft"}>
      <time>{block.start}—{block.end}</time><strong>{block.title}</strong>{/* Not 「待写回」: calendar write-back is switched off by design (Gate 3), so nothing is queued to
          be written anywhere. A label promising a pending external write would be describing a feature
          this build deliberately does not have. */}
      {milestoneOf(block) && <span className="card-milestone">→ {milestoneOf(block)}</span>}
      <small>{block.source} {block.id.startsWith("scheduled:") ? "· 仅本地" : block.readOnly ? "· 只读"
        : plan.status === "approved" ? "· 已批准 · 仅本地" : "· 草案 · 仅本地"}</small>
    </article>)}</div>
  </section>;

  return <div className="plan-view" data-plan-version={plan.id}>
    <div className="plan-tabs" role="tablist" aria-label="计划视图">
      {tabs.map(([id, label], index) => <button id={`plan-tab-${id}`} aria-controls={`plan-panel-${id}`} aria-selected={view === id}
        tabIndex={view === id ? 0 : -1} key={id} onClick={() => setView(id)} onKeyDown={(event) => moveTab(event, index)} role="tab">{id} · {label}</button>)}
      <span>PLAN v{plan.version} · {statusLabel[plan.status]}</span>
      {/* Reality moves between ticks, and fifteen minutes of not knowing whether the plan has caught up
          is exactly when a person stops trusting it. This only reads the calendar. */}
      <button type="button" className="plan-sync" disabled={syncState === "syncing"} onClick={syncNow}>
        {syncState === "syncing" ? "读取日历中…" : syncState === "error" ? "同步失败，重试" : "立即同步日历"}
      </button>
      {syncState === "done" && <span role="status" className="plan-sync-note">{syncNote}</span>}
    </div>
    {view === "B" && <div id="plan-panel-B" role="tabpanel" aria-labelledby="plan-tab-B" className="dual-timeline">
      {plan.schedule && <section className="schedule-status" role="status">
        <strong>{plan.schedule.status === "feasible" ? "建议时段已排入"
          : plan.schedule.status === "partial" ? "部分作业尚未排入" : "当前没有可行的建议时段"}</strong>
        {plan.schedule.solver === "feasible_time_limit" && <p>已显示验证过的可行安排；未证明最优。</p>}
        {plan.schedule.solver === "fallback" && <p>优化器未给出可用解；已显示验证过的保底安排。</p>}
        {plan.schedule.bufferRelaxed && <p>为守住已确认截止时间，已放宽当天的缓冲规则。</p>}
        {plan.schedule.blockers.map((blocker) => <p key={blocker.taskId}>{blocker.message}</p>)}
      </section>}{lane("human", "USER REALITY")}{lane("ai", "AI AHEAD")}</div>}
    {view === "C" && <section id="plan-panel-C" role="tabpanel" aria-labelledby="plan-tab-C" className="change-ledger">
      <header><span>KIND</span><span>CHANGE</span><span>STATUS</span></header>
      {plan.changes.map((change) => <article key={change.id}>
        <b>{changeLabel[change.kind]}</b>
        <p>{change.explanation}</p>
        <span>
          {statusLabel[change.status]}
          {/* A conflict with no way out would block approval forever, so every pending one is
              resolvable here. Excluding is a decision the ledger records, not a deletion. */}
          {change.status === "pending" && <span className="change-resolve">
            <button type="button" onClick={() => void resolve(change.id, "approved")}>采纳</button>
            <button type="button" onClick={() => void resolve(change.id, "excluded")}>排除</button>
          </span>}
        </span>
      </article>)}
      <footer>
        {plan.status === "draft" ? <Dialog.Root>
          <Dialog.Trigger asChild><button type="button">批准本批变更</button></Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-sheet">
              <span className="eyebrow">PLAN CONTROL</span>
              <Dialog.Title>批准 Plan v{plan.version}？</Dialog.Title>
              <Dialog.Description>这会把 {plan.changes.filter((change) => change.status === "pending").length} 项待定差异写入批准账本。外部日历写回仍受连接器权限与写后验证控制。</Dialog.Description>
              {approvalState === "error" && <p role="alert">批准失败：请先处理冲突中心中的阻塞项。</p>}
              <div className="dialog-actions">
                <Dialog.Close asChild><button type="button" className="secondary">返回检查</button></Dialog.Close>
                <button type="button" disabled={approvalState === "saving"} onClick={approve}>{approvalState === "saving" ? "正在落账…" : "确认批准"}</button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root> : <strong className="approved-mark">✓ 本版本已批准</strong>}
        <small>批准后才允许写入个人 Crossline 日历 · <a href="/approvals">打开全系统审批入口</a></small>
      </footer>
    </section>}
    {view === "A" && <div id="plan-panel-A" role="tabpanel" aria-labelledby="plan-tab-A"><CalendarDetail blocks={plan.blocks} today={today} workOrderMilestones={workOrderMilestones} /></div>}
  </div>;
}
