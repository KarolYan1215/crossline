"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "../locale-context";
import type { Completeness } from "./interview-contract";

/** Where the reminder that the interview is complete is remembered, per session, so it is shown once. */
const REMINDED_KEY = "crossline.interview.fullReminded:";

/**
 * What the 「结束并出报告」 button shows (decision 27): pressable only once the lower bound (the start standard) stands, the score drawn as
 * a thin bar on it, and what is still missing said beside it while it cannot be pressed.
 */
export function finishView(completeness: Completeness | undefined): { disabled: boolean; percent: number; missing: string[] } {
  if (!completeness) return { disabled: true, percent: 0, missing: [] };
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(completeness.score) ? completeness.score : 0)) * 100);
  return { disabled: !completeness.lowerBound, percent, missing: completeness.lowerBound ? [] : completeness.missing };
}

/** Whether to say 「访谈已经很完整」 now: the first time `full` is true in this session, and never again once said. */
export function shouldRemindFull(full: boolean | undefined, alreadyReminded: boolean): boolean {
  return Boolean(full) && !alreadyReminded;
}

const readReminded = (sessionId: string) => { try { return window.localStorage.getItem(REMINDED_KEY + sessionId) === "1"; } catch { return false; } };
const writeReminded = (sessionId: string) => { try { window.localStorage.setItem(REMINDED_KEY + sessionId, "1"); } catch { /* the session's own state still holds it */ } };

/**
 * The interview ends only when the person presses this (decision 13 and 27): `POST /api/onboarding/finish`, then the portrait page, where
 * the report is being written. Below the lower bound the server answers 409 `INTERVIEW_BELOW_LOWER_BOUND` with what is missing.
 */
export function FinishButton({ sessionId, completeness, disabled: busy = false, onFinished }: {
  sessionId: string; completeness: Completeness | undefined; disabled?: boolean;
  /** Called after the server accepted the end; navigates to the portrait page by default. */
  onFinished?: () => void;
}) {
  const t = useT();
  const view = finishView(completeness);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [reminder, setReminder] = useState(false);
  // Remembered in the page too, for a browser whose storage throws: the reminder is still said once a visit.
  const reminded = useRef(false);
  useEffect(() => {
    if (!sessionId || !shouldRemindFull(completeness?.full, reminded.current || readReminded(sessionId))) return;
    reminded.current = true; writeReminded(sessionId); setReminder(true);
  }, [completeness?.full, sessionId]);

  const finish = async () => {
    setSending(true); setError(""); setRefused(null);
    const response = await fetch("/api/onboarding/finish", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; code?: string; missing?: unknown; message?: string; blocker?: { message?: string } } | undefined;
    setSending(false);
    if (response?.ok && body?.ok !== false) { if (onFinished) onFinished(); else location.assign("/portrait"); return; }
    if (response?.status === 409 && body?.code === "INTERVIEW_BELOW_LOWER_BOUND") {
      setRefused(Array.isArray(body.missing) ? body.missing.filter((item): item is string => typeof item === "string") : view.missing);
      return;
    }
    setError(body?.message ?? body?.blocker?.message ?? t("没有结束成功，请重试。"));
  };
  const missing = refused ?? view.missing;
  return <div className="ob-finish">
    <button type="button" className="ob-btn ob-finish-button" disabled={view.disabled || busy || sending || !sessionId} onClick={() => void finish()}
      aria-describedby={missing.length ? "ob-finish-missing" : undefined}>
      <span>{sending ? t("正在结束…") : t("结束并出报告")}</span>
      <span className="ob-finish-track" role="meter" aria-label={t("访谈完善度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent}
        aria-valuetext={t("完善度 {{percent}}%", { percent: view.percent })}><i style={{ width: `${view.percent}%` }} /></span>
    </button>
    {missing.length > 0 && <small id="ob-finish-missing" className="ob-finish-missing">
      {t("开始使用前还差：{{items}}", { items: missing.slice(0, 4).join(t("、")) })}{missing.length > 4 ? t(" 等 {{count}} 项", { count: missing.length }) : ""}</small>}
    {error && <small className="ob-finish-missing" role="alert">{error}</small>}
    {reminder && <p className="ob-finish-reminder" role="status">
      <span>{t("访谈已经很完整，可以结束出报告；也可以继续聊")}</span>
      <button type="button" className="ob-btn ob-quiet" onClick={() => setReminder(false)}>{t("知道了")}</button>
    </p>}
  </div>;
}
