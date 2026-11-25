"use client";
import { useState } from "react";
import { useT } from "../locale-context";

export type FrontPick = { eventId: string; task: string; title: string; costOfDelay: string; minutes: number };

/**
 * J4 (docs/plans/execution-gates-1124.md §四 J4): today's one small outside gate, first on Today, with what one more day of delay costs.
 * 「不是这件」 turns the pick over (recorded, counted in the weekly review) and the card goes.
 */
export function FrontCard({ pick }: { pick: FrontPick }) {
  const t = useT();
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (gone) return null;
  const dismiss = async () => {
    setBusy(true);
    const response = await fetch("/api/gates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "not_front", eventId: pick.eventId }) }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) setGone(true);
  };
  return <section className="td-card td-front" aria-labelledby="front-title">
    <header className="td-card-head"><h2 id="front-title" className="ds-serif">{t("今日首件")}</h2>
      {pick.minutes > 0 && <small className="mono">{t("约 {{minutes}} 分钟", { minutes: Math.round(pick.minutes) })}</small>}</header>
    <p className="td-front-title"><b>{pick.title}</b></p>
    {pick.costOfDelay && <p className="td-front-cost">{pick.costOfDelay}</p>}
    <button type="button" className="td-front-dismiss" disabled={busy} onClick={() => void dismiss()}>{t("不是这件")}</button>
  </section>;
}
