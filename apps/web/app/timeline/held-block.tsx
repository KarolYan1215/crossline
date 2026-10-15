"use client";

import { useState } from "react";
import { ImpactCard, useImpact } from "../task/impact";
import { overlapping, toClock, toMinutes, type TimelineItem } from "./model";

const HELD_TEXT = { pinned: "本人开始后锁定", locked: "本人锁定" } as const;

const send = (method: "POST" | "DELETE", body: unknown) => fetch("/api/plan/pin", { method, headers: { "content-type": "application/json" },
  body: JSON.stringify(body) }).then((response) => response.ok).catch(() => false);

/**
 * A held block (started or locked) on the day panel: why it keeps its time, what it shares time with, and how the person changes it —
 * 改时间 (previewed, then locked at the new time), 解锁 (the scheduler places it again), 保留重叠 when it overlaps something they have not
 * accepted, and 留言: their words about this block go to the one input box's conversation with this task as the page, so it is read
 * with the same context and answered with the same actions as anything typed there.
 */
export function HeldBlock({ item, items, title }: { item: TimelineItem; items: TimelineItem[]; title: string }) {
  const impact = useImpact();
  const [mode, setMode] = useState<"" | "move" | "note">("");
  const [day, setDay] = useState(item.day);
  const [start, setStart] = useState(item.start);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reply, setReply] = useState("");
  if (item.kind !== "scheduled" || !item.workOrderId || (item.frozen !== "pinned" && item.frozen !== "locked")) return null;
  const workOrderId = item.workOrderId;
  const length = toMinutes(item.end) - toMinutes(item.start);
  const end = toClock(Math.min(toMinutes(start) + length, 24 * 60 - 1));
  const others = overlapping(items, item);
  const reason = item.lockedVia === "calendar" ? "在日历里拖动后锁定" : HELD_TEXT[item.frozen];

  const unlock = async () => {
    setBusy(true); setStatus("");
    if (await send("DELETE", { blockId: item.id })) { location.reload(); return; }
    setBusy(false); setStatus("未能解锁，请重试");
  };
  const keepOverlap = async () => {
    setBusy(true); setStatus("");
    if (await send("POST", { blockId: item.id, day: item.day, start: item.start, end: item.end, reason: item.frozen, overlapOk: true })) { location.reload(); return; }
    setBusy(false); setStatus("未能保存，请重试");
  };
  const leaveNote = async () => {
    const text = note.trim();
    if (!text) return;
    setBusy(true); setStatus(""); setReply("");
    const line = `关于已锁定的时间块「${title}」（${item.day} ${item.start}–${item.end}）：${text}`;
    const response = await fetch("/api/conversation/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: line, mentions: [{ kind: "task", id: workOrderId, title }], page: { kind: "task", entityId: workOrderId } }) }).catch(() => null);
    const body = response?.ok ? await response.json().catch(() => null) as { messages?: Array<{ role: string; text: string; card?: unknown }> } | null : null;
    setBusy(false);
    if (!body) { setStatus("未能送出，请重试"); return; }
    setNote("");
    const answer = [...(body.messages ?? [])].reverse().find((message) => message.role !== "user");
    // A proposed change is a card the person confirms in the conversation (小帮手), never carried out from here.
    setReply(`${answer?.text || "已交给小帮手。"}${answer?.card ? " 需要确认的改动在小帮手对话里。" : ""}`);
  };

  return <div className="dq-held" aria-label="锁定的时间块">
    <p><b>已锁定</b> · {reason}。重新排程不会移动它。</p>
    {others.length > 0 && <div>
      <p>{item.overlapOk ? "已允许与以下日程重叠：" : "与以下日程时间冲突："}</p>
      <ul>{others.map((other) => <li key={other.id}><span className="mono">{other.start}–{other.end}</span> {other.title}</li>)}</ul>
    </div>}
    <div className="dq-held-row">
      <button type="button" aria-expanded={mode === "move"} disabled={busy} onClick={() => setMode(mode === "move" ? "" : "move")}>改时间</button>
      <button type="button" disabled={busy} onClick={() => void unlock()}>解锁</button>
      {others.length > 0 && !item.overlapOk && <button type="button" disabled={busy} onClick={() => void keepOverlap()}>保留重叠</button>}
      <button type="button" aria-expanded={mode === "note"} disabled={busy} onClick={() => setMode(mode === "note" ? "" : "note")}>留言</button>
    </div>
    {mode === "move" && <div className="dq-held-row" role="group" aria-label="改到">
      <label><span>日期</span><input type="date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
      <label><span>开始</span><input type="time" step={300} value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <small className="mono">至 {end}（{length} 分钟）</small>
      <button type="button" disabled={impact.busy || !day || !start || (day === item.day && start === item.start)}
        onClick={() => void impact.propose({ kind: "move_block", workOrderId, blockId: item.id, day, start, end })}>预览</button>
      {impact.busy && !impact.pending && <small role="status">计算影响…</small>}
    </div>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
    {impact.error && <small role="status">{impact.error}</small>}
    {mode === "note" && <div className="dq-held-row" role="group" aria-label="留言">
      <textarea value={note} maxLength={500} placeholder="对这段时间的意见，例如：这段时间要开会，挪到下午" onChange={(event) => setNote(event.target.value)} />
      <button type="button" disabled={busy || !note.trim()} onClick={() => void leaveNote()}>送出</button>
    </div>}
    {reply && <p className="dq-held-reply gen" role="status">{reply}</p>}
    {status && <small role="status">{status}</small>}
  </div>;
}
