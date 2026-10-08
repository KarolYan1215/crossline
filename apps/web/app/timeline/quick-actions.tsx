"use client";

import { useEffect, useState } from "react";
import { toMinutes, type TimelineItem } from "./model";

export type QuickProposal = { id: string; title: string };

const post = async (url: string, body: unknown) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return response?.ok ?? false;
};
const hours = (minutes: number) => `${Math.round(minutes / 6) / 10} 小时`;

/**
 * The column beside the day: what can be done from here in one click, not a second list of the blocks the timeline already shows.
 * Approve the waiting proposals together, go to the decisions, start the next block, and the day's load as a bar.
 */
export function DayQuickActions({ day, today, items, proposals, nowMinute }: {
  day: string; today: string; items: TimelineItem[]; proposals: QuickProposal[]; nowMinute: number | undefined;
}) {
  const [asks, setAsks] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/pending").then((response) => response.json()).then((body: { asks?: number }) => setAsks(body.asks ?? 0)).catch(() => setAsks(null));
  }, []);
  const ofDay = items.filter((item) => item.day === day);
  const minutes = (kind: TimelineItem["kind"]) => ofDay.filter((item) => item.kind === kind).reduce((sum, item) => sum + toMinutes(item.end) - toMinutes(item.start), 0);
  const planned = minutes("scheduled"), pencilled = minutes("optional"), fixed = minutes("calendar") + minutes("import");
  const after = day === today ? nowMinute ?? 0 : 0;
  const next = ofDay.filter((item) => (item.kind === "scheduled" || item.kind === "optional") && item.workOrderId && toMinutes(item.end) > after)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))[0];
  const total = Math.max(1, planned + pencilled + fixed);

  const start = async (item: TimelineItem) => {
    setBusy(true); setStatus("");
    // A pencilled-in block becomes formal at the time it shows; then the timer starts as from the task card.
    if (item.kind === "optional" && !(await post("/api/plan/pin", { blockId: item.id, day: item.day, start: item.start, end: item.end }))) {
      setBusy(false); setStatus("未能转为正式排程"); return;
    }
    if (await post(`/api/work-orders/${encodeURIComponent(item.workOrderId!)}/execution`, { action: "start" })) { location.href = `/workbench/${encodeURIComponent(item.workOrderId!)}`; return; }
    setBusy(false); setStatus("未能开始计时，请从任务卡开始");
  };

  return <div className="dq">
    <div className="dq-row">
      <h3>当日负荷</h3>
      <span className="dq-meter" aria-hidden="true"><i style={{ width: `${(planned / total) * 100}%` }} /></span>
      <small>已排 {hours(planned)}{pencilled ? ` · 预排 ${hours(pencilled)}` : ""}{fixed ? ` · 固定日程 ${hours(fixed)}` : ""}</small>
    </div>
    {next && <div className="dq-row">
      <h3>{next.kind === "optional" ? "下一项（预排）" : "下一项"}</h3>
      <small>{next.start}–{next.end} · {next.title}{next.step ? ` · ${next.step}` : ""}</small>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void start(next)}>开始计时</button>
    </div>}
    {proposals.length > 0 && <div className="dq-row">
      <h3>待批准任务 · {proposals.length}</h3>
      <ul className="dq-list">{proposals.slice(0, 4).map((item) => <li key={item.id} title={item.title}>{item.title}</li>)}</ul>
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true);
        if (await post("/api/work-orders/approve-batch", { ids: proposals.map((item) => item.id) })) { location.reload(); return; }
        setBusy(false); setStatus("未能批准，请到待确认页处理");
      }}>全部批准</button>
    </div>}
    {asks !== null && asks > 0 && <div className="dq-row">
      <h3>待决事项 · {asks}</h3>
      <a href="/approvals#asks">逐项处理 →</a>
    </div>}
    <div className="dq-row">
      <a href="/plan#time">调整可用时段 →</a>
    </div>
    {status && <small role="status">{status}</small>}
  </div>;
}
