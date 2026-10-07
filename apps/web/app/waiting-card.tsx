"use client";

import { useState } from "react";

type Item = { id: string; title: string; who: string; expectedAt: string; approximate: boolean; blocks: string[] };

/**
 * 「师兄的数据到了吗？」 — asked on the day something the person is waiting for was expected. Nothing assumes it
 * arrived: until they say so, the work it holds up stays off the schedule, and this card comes back each day.
 */
export function WaitingCard({ item }: { item: Item }) {
  const [state, setState] = useState("");
  const [later, setLater] = useState("");
  const answer = async (body: Record<string, unknown>) => {
    setState("保存中…");
    const response = await fetch(`/api/waiting/${encodeURIComponent(item.id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (response?.ok) { location.reload(); return; }
    setState("没保存上，请重试");
  };
  return <section className="panel waiting-card" role="group" aria-label="等待中的事">
    <h2>{item.who ? `${item.who}的` : ""}「{item.title}」到了吗？</h2>
    <p className="muted">原定{item.approximate ? "大约" : ""} {item.expectedAt.slice(5)}；在它到之前，依赖它的 {item.blocks.length} 项工作不会排进日历。</p>
    <div className="execution-actions">
      <button type="button" className="primary-button" onClick={() => void answer({ kind: "arrived" })}>到了，排上</button>
      <label>还没，推迟到 <input type="date" value={later} onChange={(event) => setLater(event.target.value)} /></label>
      <button type="button" disabled={!later} onClick={() => void answer({ kind: "deferred", followUpAt: later })}>推迟</button>
      <button type="button" onClick={() => void answer({ kind: "cancelled" })}>不等了</button>
    </div>
    {state && <small role="status">{state}</small>}
  </section>;
}
