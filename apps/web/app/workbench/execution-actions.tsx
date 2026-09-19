"use client";
import { useState } from "react";
import { EnergyProbe } from "../energy-probe";

const codes: Record<string, string> = {
  MATERIALS_PREPARING: "已转入材料准备。准备完成后即可开始人工执行。",
  MATERIALS_NOT_PREPARING: "该作业当前不在材料准备阶段，请刷新。",
  EXECUTION_NOT_STARTABLE: "当前状态不能开始执行，请刷新查看真实状态。",
  EXECUTION_NOT_ACTIVE: "没有正在进行的执行，请刷新。",
  NO_ACTIVE_EXECUTION: "没有正在进行的执行，请刷新。",
  INTERRUPTION_REASON_REQUIRED: "请填写中断原因；中断时间会与真实工作时间分开记录。",
  INVALID_EVIDENCE_CLAIM: "证据声明不完整：类型、位置和说明都需要填写。",
  ARCHIVE_REASON_REQUIRED: "请写一句为什么丢弃；这条会留在账本里。",
  WORK_ORDER_ALREADY_ACCEPTED: "已验收的作业不能丢弃；如需退回请到复盘页撤销验收。"
};

export function ExecutionActions({ workOrderId, state, paused }: { workOrderId: string; state: string; paused: boolean }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [discardReason, setDiscardReason] = useState("");
  const [uri, setUri] = useState("");
  const [description, setDescription] = useState("");

  const send = async (body: Record<string, unknown>, endpoint = "execution") => {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      if (response.ok) { location.reload(); return; }
      const failure = await response.json().catch(() => ({})) as { code?: string };
      setStatus(codes[failure.code ?? ""] ?? "操作未生效，请刷新查看真实状态。");
    } catch { setStatus("连接中断；请刷新查看真实状态。"); }
    setBusy(false);
  };

  return <div className="execution-actions">
    {/* Without this the loop stopped dead here: a freshly analysed capture landed in
        `awaiting_plan_approval` and the Workbench offered no way to advance it, even though the API has
        always accepted the transition. Every successful analysis was a dead end. */}
    {state === "awaiting_plan_approval" &&
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send({}, "approve")}>批准这份提案</button>}
    {state === "blocked" &&
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send({}, "approve")}>重新批准并恢复</button>}
    {state === "preparing" && <>
      <span className="micro">材料准备中</span>
      <button type="button" disabled={busy} onClick={() => void send({ action: "materials_retry" })}>重新准备材料</button>
      <button type="button" disabled={busy} onClick={() => void send({ action: "materials_ready" })}>材料我已备好</button>
    </>}
    {(state === "approved" || state === "ready_for_human") &&
      <><span className="micro">开始前精力</span><EnergyProbe context="before_task" workOrderId={workOrderId} />
        <button className="primary-button" type="button" disabled={busy} onClick={() => void send({ action: "start" })}>开始执行</button></>}
    {state === "active" && !paused && <>
      <label><span className="sr-only">中断原因</span>
        <input value={reason} maxLength={200} placeholder="中断原因（必填）" onChange={(event) => setReason(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void send({ action: "pause", reason })}>暂停</button>
    </>}
    {state === "active" && paused &&
      <button type="button" disabled={busy} onClick={() => void send({ action: "resume" })}>继续</button>}
    {state === "active" && <>
      <label><span className="sr-only">证据位置</span>
        <input value={uri} maxLength={500} placeholder="证据位置（可留空）" onChange={(event) => setUri(event.target.value)} /></label>
      <label><span className="sr-only">证据说明</span>
        <input value={description} maxLength={500} placeholder="证据说明" onChange={(event) => setDescription(event.target.value)} /></label>
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send({
        action: "complete",
        evidence: uri.trim() && description.trim() ? [{ kind: "record", uri: uri.trim(), description: description.trim() }] : []
      })}>{uri.trim() && description.trim() ? "提交完成与证据" : "完成（记为无证据）"}</button>
    </>}
    {(state === "evidence_review" || state === "accepted") && <>
      <span className="micro">完成后精力与实际负荷</span>
      <EnergyProbe context="after_task" workOrderId={workOrderId} />
    </>}
    {/* A proposal the analysis got wrong had no exit: approve it or look at it forever. The reason is
        required because a board that quietly loses items is worse than one that keeps bad ones. */}
    {state !== "accepted" && state !== "archived" && (discarding
      ? <>
          <label><span className="sr-only">丢弃原因</span>
            <input value={discardReason} maxLength={200} placeholder="为什么丢弃（必填）"
              onChange={(event) => setDiscardReason(event.target.value)} /></label>
          <button type="button" disabled={busy} onClick={() => void send({ action: "archive", reason: discardReason })}>确认丢弃</button>
          <button type="button" disabled={busy} onClick={() => setDiscarding(false)}>取消</button>
        </>
      : <button type="button" disabled={busy} onClick={() => setDiscarding(true)}>丢弃</button>)}
    {status && <p role="status">{status}</p>}
  </div>;
}
