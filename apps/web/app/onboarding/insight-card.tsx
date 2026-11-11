"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";
import { Receipt } from "./receipt";

/**
 * The observation the deep stages give back (2026-10-19): two things the person said, connected, with the replies quoted under it, and
 * 准 / 不准. A rating goes to the next round and to the portrait; 「准」 in each deep stage stands for confirming the portrait.
 *
 * Rating is a one-shot step (2026-11-10): with `vanish` the card leaves a receipt for about 1.5 s with 撤销 (which clears the rating and
 * brings the card back), then is gone; its round's fold keeps it, rated, where it can be changed (`vanish` off).
 */
export function InsightCard({ sessionId, seq, insight, rating, onRated, vanish = false }: {
  sessionId: string; seq: number; insight: { text: string; refs: Array<{ replyId: string; quote: string }> };
  rating: "fits" | "off" | undefined; onRated: () => void; vanish?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(rating);
  const [receipt, setReceipt] = useState(false);
  // A rating read back from the server (after a reload, or another device) wins; the one just pressed shows until then.
  useEffect(() => { setShown(rating); }, [rating]);
  const send = async (verdict: "fits" | "off" | "clear") => {
    setBusy(true);
    const response = await fetch("/api/onboarding/insight", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, seq, verdict }) }).catch(() => undefined);
    setBusy(false);
    return Boolean(response?.ok);
  };
  const rate = async (verdict: "fits" | "off") => {
    if (!await send(verdict)) return;
    setShown(verdict);
    if (vanish) setReceipt(true); else onRated();
  };
  const undo = async () => {
    if (!await send("clear")) return;
    setShown(undefined); setReceipt(false); onRated();
  };
  if (receipt) return <Receipt text={shown === "fits" ? t("已记下，画像会用到这一条。") : t("已记下，画像不会用这一条。")}
    onUndo={() => void undo()} onDone={() => { setReceipt(false); onRated(); }} />;
  if (vanish && shown) return null;
  return <aside className="ob-insight" aria-label={t("观察")}>
    <b className="ob-insight-label">{t("观察")}</b>
    <p className="gen">{insight.text}</p>
    <ul className="ob-insight-quotes">{insight.refs.map((ref) => <li key={`${ref.replyId}:${ref.quote}`}>「{ref.quote}」</li>)}</ul>
    <div className="ob-insight-rate" role="group" aria-label={t("这条观察准不准")}>
      <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "fits"} disabled={busy} onClick={() => void rate("fits")}>{t("准")}</button>
      <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "off"} disabled={busy} onClick={() => void rate("off")}>{t("不准")}</button>
      {shown && <small className="ob-muted">{shown === "fits" ? t("已记下，画像会用到这一条。") : t("已记下，画像不会用这一条。")}</small>}
    </div>
  </aside>;
}
