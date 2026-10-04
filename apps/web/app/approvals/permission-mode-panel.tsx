"use client";

import { useEffect, useRef, useState } from "react";
import type { PermissionCandidate } from "../../lib/permission-mode";

export function PermissionModePanel({ initialEnabled, initialCandidates }: {
  initialEnabled: boolean; initialCandidates: PermissionCandidate[]
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
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
      setCandidates(result.candidates);
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

  return <section ref={panelRef} className="permission-mode-panel" aria-label="默认批准">
    <p>默认关闭。开启后，下面符合条件的提案在本摘要持续前台可见累计 5 分钟、期间未拒绝，才由服务端批准。离线或后台暂停；高风险、目标约束和现实冲突仍须你明确决定。</p>
    <button type="button" onClick={async () => {
      const response = await fetch("/api/permission-mode", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) }).catch(() => undefined);
      if (!response?.ok) { setMessage("设置未保存"); return; }
      const result = await response.json() as { enabled: boolean; candidates: PermissionCandidate[] };
      setEnabled(result.enabled); setCandidates(result.candidates); setMessage(result.enabled ? "已开启" : "已关闭");
    }}>{enabled ? "关闭默认批准" : "开启默认批准"}</button>
    {message && <span role="status">{message}</span>}
    <ul>{candidates.map((candidate) => <li key={candidate.key}>
      <strong>{candidate.title}</strong> · {candidate.reason}
      {enabled && candidate.eligible && <small>前台累计 {Math.floor(candidate.elapsedMs / 1000)} / 300 秒</small>}
      {candidate.kind === "insight" && <button type="button" onClick={async () => {
        const response = await fetch("/api/permission-mode/approve", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ key: candidate.key }) }).catch(() => undefined);
        if (response?.ok) location.reload(); else setMessage("洞察未批准，请刷新核对状态");
      }}>明确批准洞察</button>}
      <button type="button" onClick={async () => {
        const response = await fetch("/api/permission-mode/reject", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ key: candidate.key }) }).catch(() => undefined);
        if (response?.ok) location.reload(); else setMessage("拒绝未生效，请刷新核对状态");
      }}>拒绝</button>
    </li>)}</ul>
    {!candidates.length && <p>当前没有待批提案。</p>}
  </section>;
}
