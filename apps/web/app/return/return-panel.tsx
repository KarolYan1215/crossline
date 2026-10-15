"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ReturnItem, ReturnVerdict, ReturnView } from "../../lib/return";
import type { MessageView } from "../../lib/conversation";
import { CardView, Conversation } from "../chat/conversation";
import { OpenerCard } from "../chat/opener-card";
import { Markdown } from "../ui/markdown";

type Cleaned = { orders: Array<{ id: string; title: string }>; milestones: Array<{ id: string; title: string }>; opId?: string | undefined };
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const duration = (minutes: number) => minutes >= 60 ? `${Math.round(minutes / 6) / 10} 小时` : `${minutes} 分钟`;
/** Fired when something on the page may have settled steps (an answer here, a card carried out from a box). */
const CHANGED = "crossline:pending-changed";

/** What the page says the person has been away for and what happened; exported for its test. */
export function absenceSummary(view: ReturnView): string[] {
  // The page can be opened at any time, not only after days away: under a day it says how many hours, never a rounded-up 「1 天」.
  const lines = [view.hoursAway >= 24 ? `离开了 ${view.daysAway} 天（上次操作 ${md(view.sinceDay)}）。`
    : `上次操作在${view.hoursAway >= 1 ? ` ${view.hoursAway} 小时前` : "不到 1 小时前"}（${md(view.sinceDay)}）。`];
  if (view.items.length) lines.push(`期间有 ${view.items.length} 个步骤排了时间或到了截止，下面逐项点一下，或用自己的话说。`);
  if (view.happened.deadlinesSoon.length) lines.push(`未来 7 天到期：${view.happened.deadlinesSoon.map((item) => `${item.title}（${md(item.deadline)}）`).join("、")}。`);
  if (view.happened.assistantDone) lines.push(`助手期间做完 ${view.happened.assistantDone} 项准备。`);
  if (view.happened.calendarChanges) lines.push(`日历变化 ${view.happened.calendarChanges} 次，排程已跟着调整。`);
  return lines;
}

/**
 * The small box beside one step: what the person says about it goes to the box's conversation as one turn, with the page naming this
 * task and step, and comes back as a card of actions they confirm — the same card and the same 执行 as everywhere else.
 */
function ItemSay({ item, onChanged }: { item: ReturnItem; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<MessageView | undefined>();
  const [status, setStatus] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setStatus("");
    const response = await fetch("/api/conversation/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.trim(), mentions: [], page: { kind: "return", entityId: item.key }, files: [] }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { messages?: MessageView[] } | undefined;
    setBusy(false);
    const answer = body?.messages?.find((message) => message.role !== "person");
    if (!response?.ok || !answer) { setStatus("未能发送，请重试。"); return; }
    setReply(answer); setText("");
  };
  return <div className="return-say">
    <form className="return-say-form" onSubmit={(event) => void submit(event)}>
      <input value={text} maxLength={1000} disabled={busy} placeholder="说说这一步做到哪了" aria-label={`说说「${item.step || item.title}」做到哪了`}
        onChange={(event) => setText(event.target.value)} />
      <button type="submit" className="secondary-button" disabled={busy || !text.trim()}>{busy ? "正在理解…" : "发送"}</button>
    </form>
    {status && <small role="status">{status}</small>}
    {reply && <div className="return-say-reply">
      {reply.text && <div className="gen"><Markdown text={reply.text} /></div>}
      {reply.card && <CardView messageId={reply.id} card={reply.card} choices={null} onUpdate={(message) => { setReply(message); onChanged(); }} />}
    </div>}
  </div>;
}

function Item({ item, onDone }: { item: ReturnItem; onDone: (item: ReturnItem, verdict: ReturnVerdict, stepIds?: string[]) => void }) {
  const [open, setOpen] = useState<"done" | "partial" | undefined>();
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const send = async (verdict: ReturnVerdict, extra: { minutes?: number; stepIds?: string[] } = {}) => {
    setBusy(true);
    const response = await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "answer", orderId: item.orderId, ...(item.stepId ? { stepId: item.stepId } : {}), verdict, ...extra }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; code?: string } | undefined;
    setBusy(false);
    if (body?.ok) onDone(item, verdict, extra.stepIds);
    else setStatus(body?.code === "MATERIALS_PREPARING" ? "这项任务的材料还在准备，稍后再标完成。" : "未能记下，请重试。");
  };
  const openSteps = item.steps.filter((step) => !step.done);
  const name = item.step ? `${item.title} · ${item.step}` : item.title;
  return <li className="return-item" data-line={item.line}>
    <div className="return-item-head"><b>{item.title}{item.step && <> · <span className="return-step">{item.step}</span></>}</b>
      <small>{item.lineLabel}{item.plannedDays.length ? ` · 排在 ${item.plannedDays.map(md).join("、")}` : ""}{item.dueDay ? ` · 截止 ${md(item.dueDay)}` : ""}
        {item.step && item.lastStep && item.steps.length > 1 ? " · 最后一步" : ""}</small></div>
    <div className="return-row" role="group" aria-label={`${name} 的进展`}>
      <button type="button" className="secondary-button" aria-pressed={open === "done"} disabled={busy} onClick={() => setOpen(open === "done" ? undefined : "done")}>完成</button>
      {(item.stepId || openSteps.length > 1) && <button type="button" className="secondary-button" aria-pressed={open === "partial"} disabled={busy}
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
    {open === "partial" && <div className="return-steps" role="group" aria-label={`${item.title} 的步骤`}>
      {/* The task's own step list, in its order: what is already done stays ticked; tick what else got done. */}
      {item.steps.map((step) => <label key={step.id} data-current={step.id === item.stepId ? "" : undefined}>
        <input type="checkbox" checked={step.done || ticked.includes(step.id)} disabled={busy || step.done}
          onChange={() => setTicked(ticked.includes(step.id) ? ticked.filter((id) => id !== step.id) : [...ticked, step.id])} />
        {step.title}{step.id === item.stepId ? "（这一步）" : ""}{step.done ? "（已完成）" : ""}</label>)}
      {/* Nothing ticked: this step was begun, not finished (recorded as a quarter done). */}
      <button type="button" className="secondary-button" disabled={busy || (!ticked.length && !item.stepId)}
        onClick={() => void send("partial", { stepIds: ticked })}>{ticked.length ? "记下做完的步骤" : "记下：这一步做了一部分"}</button>
      <small className="return-hint">做到哪了，也可以在下面的小框里说一句，例如「推完了第 1 题」。</small>
    </div>}
    {status && <p role="status">{status}</p>}
    <ItemSay item={item} onChanged={() => window.dispatchEvent(new Event(CHANGED))} />
  </li>;
}

const VERDICT_TEXT: Record<ReturnVerdict, string> = { done: "已完成", partial: "已记下部分完成", rolled: "已顺延", dropped: "不做了" };

/**
 * Which items an answer settles beyond its own: 不做了 discards the whole task, finishing its last step finishes the task, and
 * 做了一部分 marks the ticked steps done wherever they are listed. Exported for its test.
 */
export function settledBy(items: ReturnItem[], item: ReturnItem, verdict: ReturnVerdict, stepIds: string[] = []): Record<string, string> {
  const out: Record<string, string> = { [item.key]: VERDICT_TEXT[verdict] };
  for (const other of items) {
    if (other.orderId !== item.orderId || other.key === item.key) continue;
    if (verdict === "dropped") out[other.key] = VERDICT_TEXT.dropped;
    else if ((verdict === "done" && item.lastStep) || (verdict === "partial" && stepIds.includes(other.stepId))) out[other.key] = VERDICT_TEXT.done;
  }
  return out;
}

export function ReturnPanel({ view, cleaned, opener }: { view: ReturnView; cleaned?: Cleaned | undefined; opener?: MessageView | undefined }) {
  // The page's list as it was opened, kept in place as items get settled here or by a card carried out from a box.
  const [items, setItems] = useState(view.items);
  const [open, setOpen] = useState(() => new Set(view.items.map((item) => item.key)));
  const [settled, setSettled] = useState<Record<string, string>>({});
  const [undone, setUndone] = useState(false);
  const [openerMessage, setOpenerMessage] = useState(opener);
  const left = items.filter((item) => open.has(item.key) && !settled[item.key]);
  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ since: view.since, ...(view.until ? { until: view.until } : {}) });
    const body = await fetch(`/api/return?${query}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as
      { items?: ReturnItem[] } | null;
    if (!body?.items) return;
    const fresh = body.items;
    setOpen(new Set(fresh.map((item) => item.key)));
    setItems((list) => [...list.map((item) => fresh.find((next) => next.key === item.key) ?? item), ...fresh.filter((next) => !list.some((item) => item.key === next.key))]);
  }, [view.since, view.until]);
  useEffect(() => {
    const onChange = () => { void refresh(); };
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [refresh]);
  const answered = (item: ReturnItem, verdict: ReturnVerdict, stepIds?: string[]) => {
    setSettled((all) => ({ ...all, ...settledBy(items, item, verdict, stepIds) }));
    void refresh();
  };
  const undo = async () => {
    if (!cleaned?.opId) return;
    const response = await fetch("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cleaned.opId }) }).catch(() => undefined);
    if (response?.ok) setUndone(true);
  };
  const [rolling, setRolling] = useState(false);
  // 「其余都没做，顺延」: what is left, one request each (each is undoable on its own, like a single tap).
  const rollRest = async () => {
    setRolling(true);
    const next: Record<string, string> = {};
    for (const item of left) {
      const response = await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "answer", orderId: item.orderId, ...(item.stepId ? { stepId: item.stepId } : {}), verdict: "rolled" }) }).catch(() => undefined);
      if (response?.ok) next[item.key] = VERDICT_TEXT.rolled;
    }
    setSettled((all) => ({ ...all, ...next }));
    setRolling(false);
  };
  const skip = async () => {
    await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) }).catch(() => undefined);
    location.href = "/";
  };
  return <div className="return-page">
    {openerMessage?.card && <section className="return-card return-opener" aria-label="今天">
      <CardView messageId={openerMessage.id} card={openerMessage.card} choices={null} onUpdate={setOpenerMessage}
        {...(openerMessage.opener ? { body: <OpenerCard opener={openerMessage.opener} /> } : {})} />
    </section>}
    <section className="return-card" aria-label="离开期间">
      {absenceSummary(view).map((line) => <p key={line}>{line}</p>)}
      {cleaned && (cleaned.orders.length + cleaned.milestones.length) > 0 && <p className="return-cleaned">
        {undone ? "已恢复刚才归档的项目。" : `已归档超过 14 天无人处理的 ${cleaned.orders.length} 个任务提议、${cleaned.milestones.length} 个里程碑草稿（可在「已丢弃」与主线页恢复）。`}
        {!undone && cleaned.opId && <button type="button" className="secondary-button" onClick={() => void undo()}>撤销</button>}</p>}
    </section>
    {items.length > 0 && <section className="return-card" aria-label="期间的步骤">
      <h2>期间的步骤（还有 {left.length} 项）</h2>
      {left.length > 1 && <div className="return-row"><button type="button" className="secondary-button" disabled={rolling}
        onClick={() => void rollRest()}>{rolling ? "顺延中…" : `其余 ${left.length} 项都没做，顺延`}</button></div>}
      <ul className="return-list">
        {items.map((item) => settled[item.key] || !open.has(item.key)
          ? <li key={item.key} className="return-item return-item-settled" data-line={item.line}><b>{item.title}{item.step ? ` · ${item.step}` : ""}</b>
            <small>{settled[item.key] ?? "已更新"}</small></li>
          : <Item key={item.key} item={item} onDone={answered} />)}
      </ul>
    </section>}
    <section className="return-card" aria-label="其他进展">
      <h2>还有别的进展？</h2>
      <p className="return-hint">直接说，例如「作业 2 周一交了」；输入 @ 可指定任务、材料、里程碑或长期目标，系统整理成要确认的改动。</p>
      <Conversation variant="task" page={{ kind: "return", entityId: "" }} placeholder="说说这几天的进展，可用 @ 指定" />
    </section>
    <div className="return-actions">
      <a className="primary-button" href="/">{left.length ? "先到这里，去今日" : "去今日"}</a>
      <button type="button" className="secondary-button" onClick={() => void skip()}>这次先跳过</button>
    </div>
  </div>;
}
