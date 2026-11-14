"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";
import { Receipt } from "./receipt";
import type { TurnInsightView } from "./onboarding-types";

/**
 * The falsifier's condition alone, so the card's line 「如果{{falsifier}}，这条就不准」 is said once: the model may already write the
 * whole sentence, or start with 如果 / 假如 / 若 / "If", or end with 「这条就不准」. Empty when nothing is left.
 */
export function falsifierCondition(falsifier: string | undefined): string {
  let text = (falsifier ?? "").trim();
  // i18n-ignore-start: patterns matched against what the model wrote
  text = text.replace(/[。.！!；;\s]+$/u, "");
  text = text.replace(/[，,、\s]*(那么|则|那)?(这条(观察|推断|判断)?|这个(推断|判断)?|它)(就|便)?(不准|不成立|是错的|错了)$/u, "");
  text = text.replace(/[,\s]*(then\s+)?(this|it)\s+(would\s+be|is)\s+(wrong|off)$/iu, "");
  text = text.replace(/^(如果|假如|要是|倘若|若)\s*/u, "").replace(/^if\s+/iu, "");
  // i18n-ignore-end
  return text.replace(/[，,、；;\s]+$/u, "").trim();
}

/**
 * The observation the deep stages give back (2026-10-19): two things the person said, connected, with the replies quoted under it, and
 * 准 / 不准. A rating goes to the next round and to the portrait; 「准」 in each deep stage stands for confirming the portrait. Under the
 * points rules (2026-11-12) there is a third answer, 「部分对」, with a line in the person's own words saying what is right.
 *
 * Rating is a one-shot step (2026-11-10): with `vanish` the card leaves a receipt for about 1.5 s with 撤销 (which clears the rating and
 * brings the card back), then is gone; its round's fold keeps it, rated, where it can be changed (`vanish` off).
 */
export function InsightCard({ sessionId, seq, index = 0, insight, rating, onRated, vanish = false }: {
  /** Which of the round's cards it is (0 the first; cards ready together come in one round, 2026-11-14). */
  sessionId: string; seq: number; index?: number; insight: TurnInsightView;
  rating: "fits" | "off" | "partial" | undefined; onRated: () => void; vanish?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(rating);
  const [receipt, setReceipt] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  // A rating read back from the server (after a reload, or another device) wins; the one just pressed shows until then.
  useEffect(() => { setShown(rating); }, [rating]);
  const send = async (verdict: "fits" | "off" | "partial" | "clear") => {
    setBusy(true);
    const response = await fetch("/api/onboarding/insight", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, seq, ...(index ? { index } : {}), verdict, ...(verdict === "partial" ? { correction: correction.trim() } : {}) }) }).catch(() => undefined);
    setBusy(false);
    return Boolean(response?.ok);
  };
  const rate = async (verdict: "fits" | "off" | "partial") => {
    if (!await send(verdict)) return;
    setShown(verdict); setCorrecting(false);
    if (vanish) setReceipt(true); else onRated();
  };
  const undo = async () => {
    if (!await send("clear")) return;
    setShown(undefined); setReceipt(false); onRated();
  };
  const noted = shown === "fits" ? t("已记下，画像会用到这一条。") : shown === "partial" ? t("已记下你的更正，画像按你说的写。") : t("已记下，画像不会用这一条。");
  if (receipt) return <Receipt text={noted}
    onUndo={() => void undo()} onDone={() => { setReceipt(false); onRated(); }} />;
  if (vanish && shown) return null;
  const condition = falsifierCondition(insight.falsifier);
  return <aside className="ob-insight" aria-label={t("观察")}>
    <b className="ob-insight-label">{t("观察")}</b>
    <p className="gen">{insight.text}</p>
    <ul className="ob-insight-quotes">{insight.refs.map((ref) => <li key={`${ref.replyId}:${ref.quote}`}>「{ref.quote}」</li>)}</ul>
    {(insight.external?.length ?? 0) > 0 && <ul className="ob-insight-external" aria-label={t("外部来源")}>{insight.external!.map((item) =>
      <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer noopener" className="gen">{item.text || item.url}</a></li>)}</ul>}
    {condition && <small className="ob-insight-falsifier">{t("如果{{falsifier}}，这条就不准", { falsifier: condition })}</small>}
    <div className="ob-insight-rate" role="group" aria-label={t("这条观察准不准")}>
      <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "fits"} disabled={busy} onClick={() => void rate("fits")}>{t("准")}</button>
      <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "off"} disabled={busy} onClick={() => void rate("off")}>{t("不准")}</button>
      {insight.hypothesisId && <button type="button" className="ob-btn ob-quiet" aria-pressed={shown === "partial" || correcting} aria-expanded={correcting}
        disabled={busy} onClick={() => setCorrecting((open) => !open)}>{t("部分对")}</button>}
      {shown && !correcting && <small className="ob-muted">{noted}</small>}
    </div>
    {correcting && <form className="ob-insight-correction" onSubmit={(event) => { event.preventDefault(); if (correction.trim()) void rate("partial"); }}>
      <label>{t("哪部分对？用你的话说一句")}<textarea value={correction} maxLength={300} onChange={(event) => setCorrection(event.target.value)} /></label>
      <button type="submit" className="ob-btn" disabled={busy || !correction.trim()}>{t("记下更正")}</button>
    </form>}
  </aside>;
}
