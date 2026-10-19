"use client";

import { useState } from "react";

/**
 * The observation the deep stages give back (2026-10-19): two things the person said, connected, with the replies quoted under it, and
 * 准 / 不准. A rating goes to the next round and to the portrait; 「准」 in each deep stage stands for confirming the portrait.
 */
export function InsightCard({ sessionId, seq, insight, rating, onRated }: {
  sessionId: string; seq: number; insight: { text: string; refs: Array<{ replyId: string; quote: string }> };
  rating: "fits" | "off" | undefined; onRated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(rating);
  const rate = async (verdict: "fits" | "off") => {
    setBusy(true);
    const response = await fetch("/api/onboarding/insight", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, seq, verdict }) }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { setShown(verdict); onRated(); }
  };
  return <aside className="ob-insight" aria-label="观察">
    <b className="ob-insight-label">观察</b>
    <p className="gen">{insight.text}</p>
    <ul className="ob-insight-quotes">{insight.refs.map((ref) => <li key={`${ref.replyId}:${ref.quote}`}>「{ref.quote}」</li>)}</ul>
    <div className="ob-insight-rate" role="group" aria-label="这条观察准不准">
      <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "fits"} disabled={busy} onClick={() => void rate("fits")}>准</button>
      <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "off"} disabled={busy} onClick={() => void rate("off")}>不准</button>
      {shown && <small className="ob-muted">{shown === "fits" ? "已记下，画像会用到这一条。" : "已记下，画像不会用这一条。"}</small>}
    </div>
  </aside>;
}
