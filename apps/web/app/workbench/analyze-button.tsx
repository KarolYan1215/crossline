"use client";
import { useState } from "react";

// Named after the blocker codes `apps/web/app/api/captures/[id]/analyze/route.ts` actually returns —
// an unknown code falls back to a generic message rather than showing raw text a model or RPC produced.
const blockerText: Record<string, string> = {
  CODEX_SUPERVISOR_UNAVAILABLE: "Codex 未连接，AI 分类暂时用不了。这条已保留，可以下面改为手工创建。",
  CAPABILITY_SECRET_MISSING: "Codex 支撑服务配置不完整，AI 分类暂时用不了。可以下面改为手工创建。",
  CODEX_SUPERVISOR_URL_NOT_LOOPBACK: "Codex 支撑服务配置不对，AI 分类暂时用不了。可以下面改为手工创建。",
  ANALYSIS_REQUEST_FORBIDDEN: "这次请求被拒绝，请刷新重试。",
  CAPTURE_NOT_FOUND: "这条收集已经不存在了，请刷新。",
  ANALYSIS_PROTOCOL_INVALID: "分析服务返回的结果读不懂，可重试或改为手工创建。",
  ANALYSIS_RUNTIME_FAILED: "分析没有跑完；这条已保留，可重试或改为手工创建。"
};

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
      if (response.ok) { location.reload(); return; }
      const body = await response.json().catch(() => ({})) as { blocker?: { code?: string; message?: string } };
      setStatus(blockerText[body.blocker?.code ?? ""] ?? body.blocker?.message ?? "分析未完成；这条已保留，可继续人工处理。");
      setPending(false);
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
    <button type="button" disabled={pending} onClick={() => void send("POST")}>{retry ? "重新分析" : "分析"}</button>
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
