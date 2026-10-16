"use client";

import { useEffect, useRef, useState } from "react";
import type { PermissionCandidate } from "../../lib/permission-mode";
import { useT } from "../locale-context";

/**
 * Proposals the default-approval mode (switched on in 设置 → 自动化与助手) will approve once this panel has been in view for five
 * minutes in total without a rejection.
 */
export function PermissionModePanel({ initialCandidates }: { initialCandidates: PermissionCandidate[] }) {
  const enabled = true;
  const t = useT();
  const [candidates, setCandidates] = useState(initialCandidates);
  const [message, setMessage] = useState("");
  const visibleRef = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const eligibleKeys = candidates.filter((item) => item.eligible).map((item) => item.key).join(",");
  useEffect(() => {
    if (!enabled) return;
    const element = panelRef.current;
    if (!element) return;
    const keys = eligibleKeys ? eligibleKeys.split(",") : [];
    const pulse = async (visible: boolean) => {
      const response = await fetch("/api/permission-mode/heartbeat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys, visible }), keepalive: true
      }).catch(() => undefined);
      if (!response?.ok) return;
      const result = await response.json() as { candidates: PermissionCandidate[]; applied: string[] };
      if (result.applied.length) { location.reload(); return; }
      setCandidates(result.candidates.filter((item) => item.kind !== "insight"));
    };
    const observer = new IntersectionObserver(([entry]) => {
      visibleRef.current = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5);
      void pulse(visibleRef.current && document.visibilityState === "visible");
    }, { threshold: 0.5 });
    observer.observe(element);
    const onVisibility = () => void pulse(visibleRef.current && document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (visibleRef.current && document.visibilityState === "visible") void pulse(true);
    }, 10_000);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer); visibleRef.current = false; void pulse(false); };
  }, [enabled, eligibleKeys]);

  if (!candidates.length) return null;
  return <section ref={panelRef} className="pending-block permission-mode-panel" aria-label={t("默认批准中")}>
    <h2>{t("默认批准中 · {{count}}", { count: candidates.length })}</h2>
    <p className="review-note">{t("本区域在前台累计显示 5 分钟且未拒绝的提案将被批准；高风险、截止约束与日历冲突不在此列。")}</p>
    {message && <span role="status">{message}</span>}
    <ul>{candidates.map((candidate) => <li key={candidate.key}>
      <strong>{candidate.title}</strong> · {candidate.reason}
      {enabled && candidate.eligible && <small>{t("前台累计 {{seconds}} / 300 秒", { seconds: Math.floor(candidate.elapsedMs / 1000) })}</small>}
      <button type="button" onClick={async () => {
        const response = await fetch("/api/permission-mode/reject", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ key: candidate.key }) }).catch(() => undefined);
        if (response?.ok) location.reload(); else setMessage(t("拒绝未生效，请刷新核对状态"));
      }}>{t("拒绝")}</button>
    </li>)}</ul>
  </section>;
}
