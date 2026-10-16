"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PROGRESS_LEVELS, type ProgressLevelId } from "@crossline/core";
import type { ReturnItem, ReturnVerdict, ReturnView } from "../../lib/return";
import type { MessageView } from "../../lib/conversation";
import { CardView, Conversation } from "../chat/conversation";
import { OpenerCard } from "../chat/opener-card";
import { Markdown } from "../ui/markdown";
import { Clamp } from "../ui/clamp";

type Cleaned = { orders: Array<{ id: string; title: string }>; milestones: Array<{ id: string; title: string }>; opId?: string | undefined };
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const duration = (minutes: number) => minutes >= 60 ? `${Math.round(minutes / 6) / 10} 小时` : `${minutes} 分钟`;
/** Fired when something on the page may have settled steps (an answer here, a card carried out from a box). */
const CHANGED = "crossline:pending-changed";

/** The next seven days' deadlines, soonest first. */
const dueSoon = (view: ReturnView) => [...view.happened.deadlinesSoon].sort((a, b) => a.deadline.localeCompare(b.deadline));
/** How many of them are listed before 「另 N 项」. */
const DUE_SHOWN = 5;

/** The deadlines under the summary: one line each, the name cut to one line, the day beside it. Exported for its test. */
export function DueSoon({ view }: { view: ReturnView }) {
  const due = dueSoon(view);
  if (!due.length) return null;
  return <ul className="return-due" aria-label="未来 7 天到期">
    {due.slice(0, DUE_SHOWN).map((item) => <li key={`${item.title}:${item.deadline}`}><Clamp lines={1} text={item.title} /><small>{md(item.deadline)}</small></li>)}
    {due.length > DUE_SHOWN && <li className="return-due-more"><small>另 {due.length - DUE_SHOWN} 项</small></li>}
  </ul>;
}

/** What the page says the person has been away for and what happened; exported for its test. */
export function absenceSummary(view: ReturnView): string[] {
  // The page can be opened at any time, not only after days away: under a day it says how many hours, never a rounded-up 「1 天」.
  const lines = [view.hoursAway >= 24 ? `离开了 ${view.daysAway} 天（上次操作 ${md(view.sinceDay)}）。`
    : `上次操作在${view.hoursAway >= 1 ? ` ${view.hoursAway} 小时前` : "不到 1 小时前"}（${md(view.sinceDay)}）。`];
  if (view.items.length) lines.push(`期间有 ${view.items.length} 个步骤排了时间或到了截止，下面逐项点一下，或用自己的话说。`);
  // The count and the first day in a line; the items themselves are a short list below it (`DueSoon`), not one run-on sentence.
  if (view.happened.deadlinesSoon.length) lines.push(`未来 7 天有 ${view.happened.deadlinesSoon.length} 项到期，最早 ${md(dueSoon(view)[0]!.deadline)}：`);
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
    const answer = await sayTurn(item, text.trim());
    setBusy(false);
    if (!answer) { setStatus("未能发送，请重试。"); return; }
    setReply(answer); setText("");
  };
  return <div className="return-say">
    <form className="return-say-form" onSubmit={(event) => void submit(event)}>
      <input value={text} maxLength={1000} disabled={busy} placeholder="说说这一步做到哪了" aria-label={`说说「${item.step || item.title}」做到哪了`}
        onChange={(event) => setText(event.target.value)} />
      <button type="submit" className="secondary-button" disabled={busy || !text.trim()}>{busy ? "正在理解…" : "发送"}</button>
    </form>
    {status && <small role="status">{status}</small>}
    {reply && <Reply key={reply.id} reply={reply} onChanged={onChanged} />}
  </div>;
}

/** One line to the box's conversation, the page naming this task and step; the box's answer (with its card), or undefined. */
async function sayTurn(item: ReturnItem, text: string): Promise<MessageView | undefined> {
  const response = await fetch("/api/conversation/turn", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mentions: [], page: { kind: "return", entityId: item.key }, files: [] }) }).catch(() => undefined);
  const body = await response?.json().catch(() => undefined) as { messages?: MessageView[] } | undefined;
  return response?.ok ? body?.messages?.find((message) => message.role !== "person") : undefined;
}

/** The box's answer: its words and the card of actions the person confirms. */
function Reply({ reply, onChanged }: { reply: MessageView; onChanged: () => void }) {
  const [message, setMessage] = useState(reply);
  return <div className="return-say-reply">
    {message.text && <div className="gen"><Markdown text={message.text} /></div>}
    {message.card && <CardView messageId={message.id} card={message.card} choices={null} onUpdate={(next) => { setMessage(next); onChanged(); }} />}
  </div>;
}

/** A level as four cells, as many filled as the quarters it records. */
const Quarters = ({ quarter }: { quarter: number }) => <span className="return-quarters" aria-hidden="true">
  {[0, 1, 2, 3].map((index) => <i key={index} data-on={index < quarter || undefined} />)}</span>;

export type PartialAnswer = { level?: ProgressLevelId; note?: string; stepIds: string[] };

/**
 * 「做了一部分」 (the owner's decision of 2026-10-15): how much, as one of three levels (1/4, 2/4, 3/4 of this step), and where it got to,
 * in words — the words go to the box with this step named and come back as a card to confirm. Other steps already finished can be
 * ticked. Sending with nothing chosen is allowed; the 小帮手 then asks once, at an idle moment, how far it got. Exported for its test.
 */
export function PartialForm({ item, busy, onSend }: { item: ReturnItem; busy: boolean; onSend: (answer: PartialAnswer) => void }) {
  const [level, setLevel] = useState<ProgressLevelId | undefined>();
  const [where, setWhere] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const others = item.steps.filter((step) => step.id !== item.stepId);
  const empty = !level && !where.trim() && !ticked.length;
  return <div className="return-partial" role="group" aria-label={`${item.step || item.title} 做到哪了`}>
    <div className="return-row" role="radiogroup" aria-label="大约做了多少">
      {PROGRESS_LEVELS.map((option) => <button key={option.id} type="button" role="radio" className="secondary-button return-level" aria-checked={level === option.id}
        disabled={busy} onClick={() => setLevel(level === option.id ? undefined : option.id)}><Quarters quarter={option.quarter} />{option.label}</button>)}
    </div>
    <label className="return-where"><span>做到哪了</span>
      <input value={where} maxLength={1000} disabled={busy} placeholder="例如：推完了第 1 题，第 2 题写了一半" onChange={(event) => setWhere(event.target.value)} /></label>
    {others.some((step) => !step.done) && <details className="return-steps">
      <summary>其他已做完的步骤</summary>
      {others.map((step) => <label key={step.id}>
        <input type="checkbox" checked={step.done || ticked.includes(step.id)} disabled={busy || step.done}
          onChange={() => setTicked(ticked.includes(step.id) ? ticked.filter((id) => id !== step.id) : [...ticked, step.id])} />
        {step.title}{step.done ? "（已完成）" : ""}</label>)}
    </details>}
    <div className="return-row">
      <button type="button" className="secondary-button" disabled={busy}
        onClick={() => onSend({ ...(level ? { level } : {}), ...(where.trim() ? { note: where.trim() } : {}), stepIds: ticked })}>
        {busy ? "记下中…" : empty ? "先记下，之后再说" : "记下"}</button>
      {empty && <small className="return-hint">不选也可以记下，小帮手之后会在空闲时问一次做到哪了。</small>}
    </div>
  </div>;
}

type Settle = { item: ReturnItem; verdict: ReturnVerdict; stepIds?: string[] | undefined; reply?: MessageView | undefined; label?: string | undefined };

function Item({ item, onDone }: { item: ReturnItem; onDone: (settle: Settle) => void }) {
  const [open, setOpen] = useState<"done" | "partial" | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const send = async (verdict: ReturnVerdict, extra: { minutes?: number; stepIds?: string[]; level?: string; note?: string } = {},
    settle: { reply?: MessageView | undefined; label?: string | undefined } = {}) => {
    setBusy(true);
    const response = await fetch("/api/return", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "answer", orderId: item.orderId, ...(item.stepId ? { stepId: item.stepId } : {}), verdict, ...extra }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; code?: string } | undefined;
    setBusy(false);
    if (body?.ok) onDone({ item, verdict, stepIds: extra.stepIds, ...settle });
    else setStatus(body?.code === "MATERIALS_PREPARING" ? "这项任务的材料还在准备，稍后再标完成。" : "未能记下，请重试。");
  };
  // Words about where it got to go to the box first, so the card that comes back can be confirmed under the settled item.
  const sendPartial = async (answer: PartialAnswer) => {
    let reply: MessageView | undefined;
    if (answer.note) {
      setBusy(true); setStatus("");
      reply = await sayTurn(item, `做到哪了：${answer.note}`);
      if (!reply) { setBusy(false); setStatus("未能发送，请重试。"); return; }
    }
    const level = PROGRESS_LEVELS.find((option) => option.id === answer.level);
    const empty = !answer.level && !answer.note && !answer.stepIds.length;
    await send("partial", { stepIds: answer.stepIds, ...(answer.level ? { level: answer.level } : {}), ...(answer.note ? { note: answer.note } : {}) },
      { reply, label: empty ? "已记下部分完成，之后再问做到哪" : level ? `已记下：${level.label}（${level.quarter}/4）` : undefined });
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
    {open === "partial" && <PartialForm item={item} busy={busy} onSend={(answer) => void sendPartial(answer)} />}
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
  const [replies, setReplies] = useState<Record<string, MessageView>>({});
  const answered = ({ item, verdict, stepIds, reply, label }: Settle) => {
    setSettled((all) => ({ ...all, ...settledBy(items, item, verdict, stepIds), ...(label ? { [item.key]: label } : {}) }));
    if (reply) setReplies((all) => ({ ...all, [item.key]: reply }));
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
      <DueSoon view={view} />
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
            <small>{settled[item.key] ?? "已更新"}</small>
            {replies[item.key] && <Reply reply={replies[item.key]!} onChanged={() => window.dispatchEvent(new Event(CHANGED))} />}</li>
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
