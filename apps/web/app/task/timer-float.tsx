"use client";

import { useEffect, useRef, useState } from "react";
import type { ActiveTimer } from "../../lib/timer";
import { useT } from "../locale-context";

const clock = (seconds: number) => {
  const sign = seconds < 0 ? "+" : "";
  const value = Math.abs(seconds);
  const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), s = value % 60;
  return `${sign}${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};

/** The step's first move is a way in: shown for the first five minutes of a session, then the corner is the countdown alone again. */
const FIRST_ACTION_SECONDS = 5 * 60;

/**
 * The floating countdown for a running session, on every page. It counts down from the current step's usual duration; at zero it
 * notifies once and keeps counting (shown as overtime). Closing it ends the session — the minutes are recorded as worked — and then
 * asks whether the step is done, or offers to finish the whole task (evidence and the timed minutes are handed in on the task's page;
 * without that way out a finished task kept a paused session open and nothing was ever recorded). The session itself lives in the ledger, so a reload or another device shows the same timer.
 */
export function TimerFloat() {
  const [timers, setTimers] = useState<ActiveTimer[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [closing, setClosing] = useState<ActiveTimer | null>(null);
  const [alerted, setAlerted] = useState<Set<string>>(new Set());
  const [overdue, setOverdue] = useState<ActiveTimer | null>(null);
  const loaded = useRef(false);
  const t = useT();

  const load = () => fetch("/api/executions/active", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
    .then((body: { timers?: ActiveTimer[] } | null) => { if (body?.timers) setTimers(body.timers); }).catch(() => {});
  useEffect(() => {
    if (!loaded.current) { loaded.current = true; void load(); }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => void load(), 60_000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, []);

  const running = timers.filter((timer) => !timer.paused);
  useEffect(() => {
    for (const timer of running) {
      const left = timer.targetMinutes * 60 - Math.round((now - Date.parse(timer.sessionStart)) / 1000);
      const key = `${timer.workOrderId}:${timer.sessionStart}`;
      if (left <= 0 && !alerted.has(key)) {
        setAlerted((set) => new Set(set).add(key));
        setOverdue(timer);
        try { if ("Notification" in window && Notification.permission === "granted") new Notification(t("计时已到"), { body: timer.stepTitle ?? timer.intent }); } catch { /* not allowed */ }
      }
    }
  }, [now, running, alerted, t]);

  if (!timers.length && !closing) return null;
  const post = (workOrderId: string, path: string, body: unknown) => fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.ok).catch(() => false);
  const end = async (timer: ActiveTimer) => {
    // Ending a session is a pause with its own reason: the minutes so far count as worked, the time until the next start does not.
    if (!timer.paused) await post(timer.workOrderId, "execution", { action: "pause", reason: t("本次计时结束") });
    setClosing(timer);
    void load();
  };
  const answer = async (stepDone: boolean) => {
    if (closing && stepDone && closing.stepId) await post(closing.workOrderId, "steps", { action: "progress", stepId: closing.stepId, status: "done" });
    setClosing(null);
    location.reload();
  };

  return <aside className="timer-float" aria-label={t("计时")}>
    {timers.map((timer) => {
      const elapsed = timer.paused ? 0 : Math.round((now - Date.parse(timer.sessionStart)) / 1000);
      const left = timer.targetMinutes * 60 - elapsed;
      const share = Math.min(1, elapsed / Math.max(1, timer.targetMinutes * 60));
      return <div key={timer.workOrderId} className="timer-row" data-over={left < 0 || undefined} data-paused={timer.paused || undefined}>
        <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="14" className="timer-bg" />
          <circle cx="17" cy="17" r="14" className="timer-fg" strokeDasharray={`${share * 88} 88`} transform="rotate(-90 17 17)" /></svg>
        <a href={`/workbench/${encodeURIComponent(timer.workOrderId)}`} className="timer-text">
          <b className="mono">{timer.paused ? t("已暂停") : clock(left)}</b><small>{timer.stepTitle ?? timer.intent}</small>
          {timer.firstAction && !timer.paused && elapsed < FIRST_ACTION_SECONDS && <small className="gen" title={timer.firstAction}>{t("第一步：{{action}}", { action: timer.firstAction })}</small>}</a>
        {timer.paused
          ? <button type="button" onClick={() => void post(timer.workOrderId, "execution", { action: "resume" }).then(() => void load())}>{t("继续")}</button>
          : <button type="button" onClick={() => void end(timer)} aria-label={t("结束本次计时")}>{t("结束")}</button>}
      </div>;
    })}
    {overdue && <div className="timer-alert" role="alertdialog" aria-label={t("计时已到")}>
      <p><b>{t("计时已到")}</b> · {overdue.stepTitle ?? overdue.intent}</p><small>{t("计时继续，超出部分照常记录。")}</small>
      <button type="button" onClick={() => setOverdue(null)}>{t("知道了")}</button>
    </div>}
    {closing && <div className="timer-alert" role="alertdialog" aria-label={t("本次计时已结束")}>
      <p><b>{t("本次计时已结束")}</b>{closing.stepTitle ? ` · ${closing.stepTitle}` : ""}</p>
      {closing.stepId ? <><small>{t("该步骤是否已完成？")}</small>
        <span><button type="button" className="primary-button" onClick={() => void answer(true)}>{t("已完成")}</button>
          <button type="button" onClick={() => void answer(false)}>{t("未完成")}</button></span></>
        : <button type="button" onClick={() => void answer(false)}>{t("关闭")}</button>}
      <a href={`/workbench/${encodeURIComponent(closing.workOrderId)}#complete`}>{t("整个任务已完成，去提交")}</a>
    </div>}
  </aside>;
}
