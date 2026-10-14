"use client";
import { useState } from "react";
import type { ReturnItem, ReturnVerdict, ReturnView } from "../../lib/return";
import { Conversation } from "../chat/conversation";

type Cleaned = { orders: Array<{ id: string; title: string }>; milestones: Array<{ id: string; title: string }>; opId?: string | undefined };
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const duration = (minutes: number) => minutes >= 60 ? `${Math.round(minutes / 6) / 10} 小时` : `${minutes} 分钟`;

/** What the page says the person has been away for and what happened; exported for its test. */
export function absenceSummary(view: ReturnView): string[] {
  // The page can be opened at any time, not only after days away: under a day it says how many hours, never a rounded-up 「1 天」.
  const lines = [view.hoursAway >= 24 ? `离开了 ${view.daysAway} 天（上次操作 ${md(view.sinceDay)}）。`
    : `上次操作在${view.hoursAway >= 1 ? ` ${view.hoursAway} 小时前` : "不到 1 小时前"}（${md(view.sinceDay)}）。`];
  if (view.items.length) lines.push(`期间有 ${view.items.length} 项任务排了时间或到了截止，下面逐项点一下就能更新。`);
  if (view.happened.deadlinesSoon.length) lines.push(`未来 7 天到期：${view.happened.deadlinesSoon.map((item) => `${item.title}（${md(item.deadline)}）`).join("、")}。`);
  if (view.happened.assistantDone) lines.push(`助手期间做完 ${view.happened.assistantDone} 项准备。`);
  if (view.happened.calendarChanges) lines.push(`日历变化 ${view.happened.calendarChanges} 次，排程已跟着调整。`);
  return lines;
}

function Item({ item, onDone }: { item: ReturnItem; onDone: (id: string, verdict: ReturnVerdict) => void }) {
  const [open, setOpen] = useState<"done" | "partial" | undefined>();
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const send = async (verdict: ReturnVerdict, extra: { minutes?: number; stepIds?: string[] } = {}) => {
    setBusy(true);
    const response = await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "answer", orderId: item.orderId, verdict, ...extra }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; code?: string } | undefined;
    setBusy(false);
    if (body?.ok) onDone(item.orderId, verdict);
    else setStatus(body?.code === "MATERIALS_PREPARING" ? "这项任务的材料还在准备，稍后再标完成。" : "未能记下，请重试。");
  };
  const open_steps = item.steps.filter((step) => !step.done);
  return <li className="return-item" data-line={item.line}>
    <div className="return-item-head"><b>{item.title}</b>
      <small>{item.lineLabel}{item.plannedDays.length ? ` · 排在 ${item.plannedDays.map(md).join("、")}` : ""}{item.dueDay ? ` · 截止 ${md(item.dueDay)}` : ""}</small></div>
    <div className="return-row" role="group" aria-label={`${item.title} 的进展`}>
      <button type="button" className="secondary-button" aria-pressed={open === "done"} disabled={busy} onClick={() => setOpen(open === "done" ? undefined : "done")}>完成</button>
      {open_steps.length > 1 && <button type="button" className="secondary-button" aria-pressed={open === "partial"} disabled={busy}
        onClick={() => setOpen(open === "partial" ? undefined : "partial")}>做了一部分</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("rolled")}>没做，顺延</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("dropped")}>不做了</button>
    </div>
    {open === "done" && <div className="return-row" role="group" aria-label="用了多久">
      <span>用了多久：</span>
      {[["约等于估时", item.p50Minutes], ["一半", Math.round(item.p50Minutes / 2)], ["一倍半", Math.round(item.p50Minutes * 1.5)], ["两倍", item.p50Minutes * 2]]
        .map(([label, minutes]) => <button key={label} type="button" className="secondary-button" disabled={busy}
          onClick={() => void send("done", { minutes: minutes as number })}>{label}（{duration(minutes as number)}）</button>)}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("done")}>不记得</button>
    </div>}
    {open === "partial" && <div className="return-steps">
      {open_steps.map((step) => <label key={step.id}><input type="checkbox" checked={ticked.includes(step.id)} disabled={busy}
        onChange={() => setTicked(ticked.includes(step.id) ? ticked.filter((id) => id !== step.id) : [...ticked, step.id])} /> {step.title}</label>)}
      <button type="button" className="secondary-button" disabled={busy || !ticked.length} onClick={() => void send("partial", { stepIds: ticked })}>记下做完的步骤</button>
    </div>}
    {status && <p role="status">{status}</p>}
  </li>;
}

const VERDICT_TEXT: Record<ReturnVerdict, string> = { done: "已完成", partial: "已记下部分完成", rolled: "已顺延", dropped: "不做了" };

export function ReturnPanel({ view, cleaned }: { view: ReturnView; cleaned?: Cleaned | undefined }) {
  const [settled, setSettled] = useState<Record<string, ReturnVerdict>>({});
  const [undone, setUndone] = useState(false);
  const left = view.items.filter((item) => !settled[item.orderId]);
  const undo = async () => {
    if (!cleaned?.opId) return;
    const response = await fetch("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cleaned.opId }) }).catch(() => undefined);
    if (response?.ok) setUndone(true);
  };
  const [rolling, setRolling] = useState(false);
  // 「其余都没做，顺延」: what is left, one request each (each is undoable on its own, like a single tap).
  const rollRest = async () => {
    setRolling(true);
    const next = { ...settled };
    for (const item of left) {
      const response = await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "answer", orderId: item.orderId, verdict: "rolled" }) }).catch(() => undefined);
      if (response?.ok) next[item.orderId] = "rolled";
    }
    setSettled(next);
    setRolling(false);
  };
  const skip = async () => {
    await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) }).catch(() => undefined);
    location.href = "/";
  };
  return <div className="return-page">
    <section className="return-card" aria-label="离开期间">
      {absenceSummary(view).map((line) => <p key={line}>{line}</p>)}
      {cleaned && (cleaned.orders.length + cleaned.milestones.length) > 0 && <p className="return-cleaned">
        {undone ? "已恢复刚才归档的项目。" : `已归档超过 14 天无人处理的 ${cleaned.orders.length} 个任务提议、${cleaned.milestones.length} 个里程碑草稿（可在「已丢弃」与主线页恢复）。`}
        {!undone && cleaned.opId && <button type="button" className="secondary-button" onClick={() => void undo()}>撤销</button>}</p>}
    </section>
    {view.items.length > 0 && <section className="return-card" aria-label="期间的任务">
      <h2>期间的任务（还有 {left.length} 项）</h2>
      {left.length > 1 && <div className="return-row"><button type="button" className="secondary-button" disabled={rolling}
        onClick={() => void rollRest()}>{rolling ? "顺延中…" : `其余 ${left.length} 项都没做，顺延`}</button></div>}
      <ul className="return-list">
        {view.items.map((item) => settled[item.orderId]
          ? <li key={item.orderId} className="return-item return-item-settled"><b>{item.title}</b><small>{VERDICT_TEXT[settled[item.orderId]!]}</small></li>
          : <Item key={item.orderId} item={item} onDone={(id, verdict) => setSettled({ ...settled, [id]: verdict })} />)}
      </ul>
    </section>}
    <section className="return-card" aria-label="其他进展">
      <h2>还有别的进展？</h2>
      <p className="return-hint">直接说，例如「作业 2 周一交了」「和导师约到下周三」，系统会整理成要确认的改动。</p>
      <Conversation variant="inline" placeholder="说说这几天的进展" />
    </section>
    <div className="return-actions">
      <a className="primary-button" href="/">{left.length ? "先到这里，去今日" : "去今日"}</a>
      <button type="button" className="secondary-button" onClick={() => void skip()}>这次先跳过</button>
    </div>
  </div>;
}
