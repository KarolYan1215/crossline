"use client";

import { useEffect, useState } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import type { TimelineItem } from "./model";
import type { LineLabels } from "./views";
import { BlockOverview } from "./block-overview";
import { dayLoad, hoursLabel, nextBlock } from "./panel-model";
import "./day-panel.css";

export type QuickProposal = { id: string; title: string };

const post = async (url: string, body: unknown) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return response?.ok ?? false;
};

/**
 * The column beside the day. Fixed on top: the day's load. Below it, one thing at a time — the block the person picked on the timeline
 * (its task, step, due date, duration, the person's part, its next block, and what can be done from here), or, with nothing picked, the
 * next block to start. At the bottom, one row of ways out: the waiting proposals (with 全部批准), the decisions waiting, the hours.
 * The detail strip that used to sit under the calendar is gone; this is the one place a block is looked at and acted on.
 */
export function DayQuickActions({ day, today, items, proposals, nowMinute, selected, onDeselect, labels = {}, details }: {
  day: string; today: string; items: TimelineItem[]; proposals: QuickProposal[]; nowMinute: number | undefined;
  /** The block picked on the timeline; without one the panel shows the next block. */
  selected?: TimelineItem | undefined; onDeselect?: (() => void) | undefined;
  labels?: LineLabels;
  /** Task details read with the page, by work order id; a task missing here is read on demand. */
  details?: Record<string, TaskDetail> | undefined;
}) {
  const [asks, setAsks] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/pending").then((response) => response.json()).then((body: { asks?: number }) => setAsks(body.asks ?? 0)).catch(() => setAsks(null));
  }, []);
  const load = dayLoad(items, day);
  const total = Math.max(1, load.planned + load.pencilled + load.fixed);
  const next = nextBlock(items, day, today, nowMinute);

  return <div className="dq">
    <section className="dq-load" aria-label="当日负荷">
      <h3>当日负荷</h3>
      <span className="dq-meter" aria-hidden="true">
        <i style={{ width: `${(load.planned / total) * 100}%` }} />
        <i data-kind="optional" style={{ width: `${(load.pencilled / total) * 100}%` }} />
        <i data-kind="fixed" style={{ width: `${(load.fixed / total) * 100}%` }} />
      </span>
      <small>已排 {hoursLabel(load.planned)}{load.pencilled ? ` · 预排 ${hoursLabel(load.pencilled)}` : ""}{load.fixed ? ` · 固定日程 ${hoursLabel(load.fixed)}` : ""}
        {load.allDay.length ? ` · 全天：${load.allDay.join("、")}` : ""}</small>
    </section>
    <section className="dq-switch" aria-live="polite" aria-label={selected ? "选中的日程" : "下一项"}>
      {selected ? <BlockOverview key={selected.id} item={selected} items={items} today={today} labels={labels} details={details} heading="选中的日程" onClose={onDeselect} />
        : next ? <BlockOverview key={next.id} item={next} items={items} today={today} labels={labels} details={details} compact
          heading={next.kind === "optional" ? "下一项（预排）" : "下一项"} />
        : <p className="dq-empty">{day === today ? "今天没有待开始的任务。" : "当日没有排入任务。"}点选时间轴上的日程查看详情。</p>}
    </section>
    <nav className="dq-links" aria-label="当日入口">
      {proposals.length > 0 && <span className="dq-link">
        <a href="/approvals#proposals" title={proposals.slice(0, 6).map((item) => item.title).join("\n")}>待批准任务 · <b className="mono">{proposals.length}</b></a>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setStatus("");
          if (await post("/api/work-orders/approve-batch", { ids: proposals.map((item) => item.id) })) { location.reload(); return; }
          setBusy(false); setStatus("未能批准，请到待确认页处理");
        }}>全部批准</button>
      </span>}
      {asks !== null && asks > 0 && <a className="dq-link" href="/approvals#asks">待决事项 · <b className="mono">{asks}</b></a>}
      <a className="dq-link" href="/plan#time">调整可用时段</a>
    </nav>
    {status && <small role="status">{status}</small>}
  </div>;
}
