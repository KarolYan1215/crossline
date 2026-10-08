"use client";
import { useState } from "react";
import type { EvidenceQuestionTemplate } from "@crossline/core";
import { EnergyProbe } from "./energy-probe";
import { createCommand, enqueue, nextSequence, type OfflineCommandType } from "./offline-queue";

/** The only four actions the offline outbox can carry — everything else (approve, materials retry/ready,
 * archive) stays online-only, matching the plan's stated scope for the offline workbench. */
const OFFLINE_ACTION_TYPES: Record<string, OfflineCommandType> = {
  start: "work_order.start", pause: "work_order.pause", resume: "work_order.resume", complete: "work_order.complete"
};

const codes: Record<string, string> = {
  MATERIALS_PREPARING: "已转入材料准备，完成后即可开始。",
  MATERIALS_NOT_PREPARING: "该任务不在材料准备阶段，请刷新。",
  EXECUTION_NOT_STARTABLE: "当前状态不能开始计时，请刷新。",
  EXECUTION_NOT_ACTIVE: "没有正在进行的执行，请刷新。",
  NO_ACTIVE_EXECUTION: "没有正在进行的执行，请刷新。",
  INTERRUPTION_REASON_REQUIRED: "需要中断原因；中断时间与工作时间分开记录。",
  INVALID_EVIDENCE_CLAIM: "证据声明不完整：类型、位置和说明均为必填。",
  ARCHIVE_REASON_REQUIRED: "归档需要一句原因，原因保留在账本中。",
  WORK_ORDER_ALREADY_ACCEPTED: "已验收的任务不能归档；撤销验收后可归档。"
};

export function ExecutionActions({ workOrderId, intent, state, paused, ownerId, workspaceId, evidenceChecklist = [], showEnergyProbe = true,
  estimateP50, suggestedMinutes }: {
  workOrderId: string; intent: string; state: string; paused: boolean; ownerId: string; workspaceId: string;
  /** The estimate's typical value, for the one-tap 「实际花了多久」 choices. */
  estimateP50?: number;
  /** What the screen record says this session took (work-like apps since it started); only with the detail consent. */
  suggestedMinutes?: number;
  /** Pre-generated completion-time questions copied from the bound milestone — see 工作块 E. Empty is
   * normal (no template behind the milestone, or no milestone at all); the free-text/file fields below
   * stay available regardless. */
  evidenceChecklist?: EvidenceQuestionTemplate[];
  /** Today's homepage already has its own dedicated energy probe in the CARE/CAPACITY section — embedding
   * this component's own before/after-task probe there too would put two identically-labelled "记录中精力"
   * controls on one page. Workbench and the task detail page have no such section, so they keep it on. */
  showEnergyProbe?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [discardReason, setDiscardReason] = useState("");
  const [uri, setUri] = useState("");
  const [description, setDescription] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<{ uri: string; fileName: string } | null>(null);
  const [uploadStatus, setUploadStatus] = useState("");
  // 「实际花了多久」: chosen at completion in one tap (or confirmed from the screen record) — the only number there is
  // for work done away from the timer, and what the estimate calibration learns from.
  const [reported, setReported] = useState<{ minutes: number; source: "one_tap" | "activity" } | null>(
    suggestedMinutes ? { minutes: suggestedMinutes, source: "activity" } : null);
  const [ownMinutes, setOwnMinutes] = useState("");

  // Offline is queued, not just reported: the person's decision to start, pause, resume or complete
  // their own work order must survive a dead connection the same way a capture already does, and the
  // server already accepts these four as `work_order.*` commands (`apps/web/app/api/commands/route.ts`).
  // Everything else here (approve, materials retry/ready, archive) is deliberately online-only.
  const queueOffline = async (action: string, body: Record<string, unknown>) => {
    const type = OFFLINE_ACTION_TYPES[action];
    if (!type) return false;
    // `title` matches the field name a capture command already uses for display, so the offline/conflict
    // list (`apps/web/app/offline/dead-letters.tsx`) shows the work order's own intent instead of a bare
    // command type string, with no extra display logic needed there.
    const payload = action === "complete"
      ? { workOrderId, title: intent, evidence: body.evidence }
      : action === "pause" ? { workOrderId, title: intent, reason: body.reason } : { workOrderId, title: intent };
    const command = createCommand(ownerId, workspaceId, await nextSequence(workspaceId), type, payload);
    try {
      await enqueue(workspaceId, command);
      setStatus("已离线保存，联网后自动同步");
      return true;
    } catch { return false; }
  };

  const send = async (body: Record<string, unknown>, endpoint = "execution") => {
    setBusy(true);
    setStatus("");
    const action = String(body.action ?? "");
    if (endpoint === "execution" && !navigator.onLine) {
      if (await queueOffline(action, body)) { setBusy(false); return; }
    }
    try {
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      });
      if (response.ok) { location.reload(); return; }
      const failure = await response.json().catch(() => ({})) as { code?: string };
      setStatus(codes[failure.code ?? ""] ?? "操作未生效，请刷新查看真实状态。");
    } catch {
      if (endpoint === "execution" && await queueOffline(action, body)) { setBusy(false); return; }
      setStatus("连接中断；请刷新查看真实状态。");
    }
    setBusy(false);
  };

  const uploadEvidenceFile = async (file: File) => {
    setUploading(true);
    setUploadStatus("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/evidence-attachments`, { method: "POST", body: form });
      const body = await response.json().catch(() => null) as { saved?: Array<{ uri: string; fileName: string }>; message?: string } | null;
      if (!response.ok || !body?.saved?.[0]) { setUploadStatus(body?.message ?? "文件上传失败，请重试"); return; }
      setUploadedFile(body.saved[0]);
    } catch { setUploadStatus("网络不可用，文件未上传"); }
    finally { setUploading(false); }
  };

  const completeEvidence = () => {
    const evidence = [
      ...(uri.trim() && description.trim() ? [{ kind: "record", uri: uri.trim(), description: description.trim() }] : []),
      ...(uploadedFile ? [{ kind: "file", uri: uploadedFile.uri, description: uploadedFile.fileName }] : [])
    ];
    const checklistAnswers = Object.entries(answers)
      .filter(([, answer]) => answer.trim())
      .map(([questionId, answer]) => ({ questionId, answer: answer.trim() }));
    return { action: "complete", evidence, checklistAnswers, ...(reported ? { reportedMinutes: reported.minutes, reportedSource: reported.source } : {}) };
  };
  const hasEvidence = Boolean((uri.trim() && description.trim()) || uploadedFile);

  return <div className="execution-actions">
    {/* Without this the loop stopped dead here: a freshly analysed capture landed in
        `awaiting_plan_approval` and the Workbench offered no way to advance it, even though the API has
        always accepted the transition. Every successful analysis was a dead end. */}
    {state === "awaiting_plan_approval" &&
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send({}, "approve")}>批准</button>}
    {state === "blocked" &&
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send({}, "approve")}>恢复</button>}
    {state === "preparing" && <>
      <span className="micro">材料准备中</span>
      <button type="button" disabled={busy} onClick={() => void send({ action: "materials_retry" })}>重新准备材料</button>
      <button type="button" disabled={busy} onClick={() => void send({ action: "materials_ready" })}>材料已备好</button>
    </>}
    {(state === "approved" || state === "ready_for_human") && <>
      {showEnergyProbe && <><span className="micro">开始前精力</span><EnergyProbe context="before_task" workOrderId={workOrderId} /></>}
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send({ action: "start" })}>开始计时</button>
    </>}
    {state === "active" && !paused && <>
      <label><span className="sr-only">中断原因</span>
        <input value={reason} maxLength={200} placeholder="中断原因（必填）" onChange={(event) => setReason(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void send({ action: "pause", reason })}>暂停</button>
    </>}
    {state === "active" && paused &&
      <button type="button" disabled={busy} onClick={() => void send({ action: "resume" })}>继续</button>}
    {state === "active" && <>
      {/* Pre-generated at milestone approval time (see 工作块 E) — the person just clicks a checkbox
          option or types the specifics, AI records the exact answer rather than asking them to write
          free-form evidence prose from scratch. */}
      {evidenceChecklist.length > 0 && <fieldset className="evidence-checklist">
        <legend className="micro">完成情况（可选）</legend>
        {evidenceChecklist.map((question) => <div key={question.id} className="evidence-question">
          <span>{question.prompt}</span>
          {question.kind === "checkbox"
            ? <div className="evidence-question-options">{question.options.map((option) => <label key={option}>
                <input type="radio" name={`checklist-${question.id}`} checked={answers[question.id] === option}
                  onChange={() => setAnswers((current) => ({ ...current, [question.id]: option }))} />
                <span>{option}</span>
              </label>)}</div>
            : <input value={answers[question.id] ?? ""} maxLength={2000} placeholder="输入具体情况"
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
        </div>)}
      </fieldset>}
      <label><span className="sr-only">证据位置</span>
        <input value={uri} maxLength={500} placeholder="证据位置（可留空）" onChange={(event) => setUri(event.target.value)} /></label>
      <label><span className="sr-only">证据说明</span>
        <input value={description} maxLength={500} placeholder="证据说明" onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="evidence-file-upload">
        <span className="sr-only">上传证据文件，由 AI 审阅</span>
        <input type="file" disabled={uploading || busy}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void uploadEvidenceFile(file); }} />
        <small>
          {uploading ? "上传中…" : uploadedFile ? `已上传：${uploadedFile.fileName}` : "可选：上传证据文件"}
        </small>
      </label>
      {uploadStatus && <small className="muted" role="status">{uploadStatus}</small>}
      {estimateP50 ? <fieldset className="reported-minutes">
        <legend className="micro">实际用时（用于校准估时）</legend>
        {suggestedMinutes ? <button type="button" aria-pressed={reported?.source === "activity"} onClick={() => setReported({ minutes: suggestedMinutes, source: "activity" })}>
          屏幕记录约 {suggestedMinutes} 分</button> : null}
        {([["≈估时", 1], ["一半", 0.5], ["多一半", 1.5], ["两倍", 2]] as const).map(([label, factor]) => {
          const minutes = Math.max(5, Math.round(estimateP50 * factor / 5) * 5);
          return <button key={label} type="button" aria-pressed={reported?.source === "one_tap" && reported.minutes === minutes}
            onClick={() => setReported({ minutes, source: "one_tap" })}>{label} {minutes} 分</button>;
        })}
        <label><span className="sr-only">自己填分钟数</span>
          <input inputMode="numeric" value={ownMinutes} placeholder="分钟数" maxLength={4} onChange={(event) => {
            setOwnMinutes(event.target.value);
            const minutes = Number(event.target.value);
            setReported(Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 ? { minutes, source: "one_tap" } : null);
          }} /></label>
      </fieldset> : null}
      <button className="primary-button" type="button" disabled={busy} onClick={() => void send(completeEvidence())}>
        {hasEvidence ? "提交完成与证据" : "完成（记为无证据）"}
      </button>
    </>}
    {(state === "evidence_review" || state === "accepted") && showEnergyProbe && <>
      <span className="micro">完成后精力与实际负荷</span>
      <EnergyProbe context="after_task" workOrderId={workOrderId} />
    </>}
    {/* A proposal the analysis got wrong had no exit: approve it or look at it forever. The reason is
        required because a board that quietly loses items is worse than one that keeps bad ones. */}
    {state !== "accepted" && state !== "archived" && (discarding
      ? <>
          <label><span className="sr-only">归档原因</span>
            <input value={discardReason} maxLength={200} placeholder="为什么归档（必填）"
              onChange={(event) => setDiscardReason(event.target.value)} /></label>
          <button type="button" disabled={busy} onClick={() => void send({ action: "archive", reason: discardReason })}>确认归档</button>
          <button type="button" disabled={busy} onClick={() => setDiscarding(false)}>取消</button>
        </>
      : <button type="button" disabled={busy} onClick={() => setDiscarding(true)}>归档</button>)}
    {status && <p role="status">{status}</p>}
  </div>;
}
