"use client";
import { useState } from "react";

export function AnalyzeButton({ captureId, analyzing, retry }: { captureId: string; analyzing: boolean; retry: boolean }) {
  const [pending, setPending] = useState(analyzing);
  const [status, setStatus] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState("");
  const send = async (method: "POST" | "DELETE") => {
    setPending(true);
    setStatus(method === "POST" ? "正在分析；完成后仍需人工审批" : "正在取消");
    try {
      const response = await fetch(`/api/captures/${encodeURIComponent(captureId)}/analyze`, { method });
      if (response.ok) location.reload();
      else { setStatus("分析服务不可用；Capture 已保留，可继续人工处理。"); setPending(false); }
    } catch { setStatus("连接中断；请刷新查看分析状态，重试不会重复启动。"); setPending(false); }
  };
  const discard = async () => {
    setPending(true);
    const response = await fetch(`/api/captures/${encodeURIComponent(captureId)}/discard`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason })
    }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    const failure = await response?.json().catch(() => ({})) as { code?: string } | undefined;
    setStatus(failure?.code === "DISCARD_REASON_REQUIRED"
      ? "请写一句为什么丢弃；这条会留在账本里。"
      : "现在不能丢弃这条，请刷新查看真实状态。");
    setPending(false);
  };

  return <>
    <button type="button" disabled={pending} onClick={() => void send("POST")}>{retry ? "重新分析" : "Analyze · 分析"}</button>
    {pending && <button type="button" onClick={() => void send("DELETE")}>取消分析</button>}
    {/* A capture had exactly one exit — 分析 — so a duplicate or a note that turned out not to be a task
        could only be removed by spending a real Codex turn on it first. */}
    {!pending && (discarding
      ? <>
          <label><span className="sr-only">丢弃原因</span>
            <input value={reason} maxLength={200} placeholder="为什么丢弃（必填）"
              onChange={(event) => setReason(event.target.value)} /></label>
          <button type="button" onClick={() => void discard()}>确认丢弃</button>
          <button type="button" onClick={() => setDiscarding(false)}>取消</button>
        </>
      : <button type="button" onClick={() => setDiscarding(true)}>丢弃</button>)}
    {status && <p role="status">{status}</p>}
  </>;
}
