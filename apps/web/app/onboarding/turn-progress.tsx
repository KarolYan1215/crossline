"use client";

import { useEffect, useState } from "react";
import type { OnboardingProgress } from "@crossline/core";

/** The line that says what the turn is doing now, from the worker's progress record (or nothing yet). */
export function progressHeadline(progress: OnboardingProgress | null): string {
  if (!progress) return "正在准备这一轮…";
  if (progress.phase === "queued") return `排队中，前面还有 ${progress.ahead ?? 1} 个`;
  if (progress.stalls > 0 && progress.phase === "thinking") return "上一次没有回音，已重新发送";
  if (progress.repairs > 0 && progress.phase !== "checking") return `第一次的回答有一处没过核对，正在修正（第 ${progress.repairs} 次）`;
  if (progress.phase === "checking") return "写完了，正在核对引文和日期";
  if (progress.phase === "writing") return "正在写回答";
  if (progress.files.length) {
    const named = progress.files.slice(0, 2).join("、");
    return `正在读 ${progress.files.length} 个文件：${named}${progress.files.length > 2 ? " 等" : ""}`;
  }
  return "正在想下一组问题";
}

const clock = (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;

/**
 * The wait for an interview turn (docs/onboarding-v3.md 「等待」, decided 2026-10-14): what is being read, the reply as it is written, and
 * how many facts, dates and questions the answer holds so far — all unvalidated, replaced by the real round when it lands. The person can
 * keep working on the left meanwhile, or leave: the round calls them back (a desktop notification once allowed here, the tab's title, and
 * the tray on the installed copy).
 */
export function TurnProgress({ sessionId, resumed = false, onEnded, onRunning, onRetry }: { sessionId: string;
  /** Opened on a page that was reloaded mid-turn: shown only while the worker says a turn runs, and `onEnded` when it stops. */
  resumed?: boolean; onEnded?: () => void; onRunning?: (running: boolean) => void;
  /** A reply is waiting but no turn runs for it (the background was restarted): send it again. */
  onRetry?: () => void }) {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [seen, setSeen] = useState(false);
  // Reads that found no running turn: after a few, a resumed page says the round was lost instead of showing nothing at all.
  const [empty, setEmpty] = useState(0);
  const [shownFrom] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [notify, setNotify] = useState<NotificationPermission | "unsupported">("unsupported");
  useEffect(() => { setNotify(typeof Notification === "undefined" ? "unsupported" : Notification.permission); }, []);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const response = await fetch(`/api/onboarding/progress${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { cache: "no-store" }).catch(() => undefined);
      const body = await response?.json().catch(() => undefined) as { progress?: OnboardingProgress | null } | undefined;
      if (!live || !body) return;
      setProgress(body.progress ?? null);
      if (body.progress) setSeen(true); else setEmpty((count) => count + 1);
    };
    void read();
    const poll = setInterval(() => void read(), 1500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(poll); clearInterval(tick); };
  }, [sessionId]);
  useEffect(() => { if (resumed && seen && !progress) onEnded?.(); }, [resumed, seen, progress, onEnded]);
  useEffect(() => { onRunning?.(Boolean(progress)); }, [progress, onRunning]);
  // The answer was sent but nothing is answering it: a worker restart drops a turn that was waiting or running (2026-10-15 walkthrough,
  // where the page showed the answer and nothing else, with no way on).
  if (resumed && !progress && !seen && empty >= 3 && onRetry) return <div className="ob-turn ob-assistant ob-progress" role="alert">
    <p className="ob-progress-head">这一轮没有在后台运行（后台服务重启过），回答已保存。</p>
    <button type="button" className="ob-btn ob-primary" onClick={onRetry}>重新发送这一轮</button>
  </div>;
  if (resumed && !progress) return null;
  const started = progress ? Date.parse(progress.startedAt) : shownFrom;
  const elapsed = Math.max(0, Math.round((now - (Number.isFinite(started) ? started : shownFrom)) / 1000));
  const counted = progress && progress.facts + progress.dates + progress.questions > 0;
  return <div className="ob-turn ob-assistant ob-progress" role="status" aria-label="这一轮的进度">
    <p className="ob-progress-head"><span className="ob-progress-dot" aria-hidden="true" />{progressHeadline(progress)}</p>
    {progress?.reply && <p className="gen ob-progress-reply">{progress.reply}</p>}
    {counted && <p className="ob-progress-counts">已整理 <b>{progress.facts}</b> 条事实 · <b>{progress.dates}</b> 个日期 · <b>{progress.questions}</b> 个问题</p>}
    <small className="ob-muted">已用 {clock(elapsed)}，通常 1–4 分钟。可以先在左边确认日期、采用长期目标，或者离开本页，好了会提醒。</small>
    {notify === "default" && <button type="button" className="ob-btn ob-quiet" onClick={() => void Notification.requestPermission().then(setNotify)}>好了用桌面通知提醒我</button>}
  </div>;
}

/** Called when a round lands: a desktop notification if the page is out of sight and the person allowed them here. */
export function announceRound(): void {
  if (typeof document === "undefined" || document.visibilityState === "visible") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const note = new Notification("访谈下一轮已就绪", { body: "新的一组问题已经生成，可以回到访谈继续。", tag: "onboarding-round" });
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* some browsers only allow notifications from a service worker; the tab title still says it */ }
}
