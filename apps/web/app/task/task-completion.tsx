"use client";

import { useRef, useState, type DragEvent } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import { Sheet } from "../ui/overlay";
import { createCommand, enqueue, nextSequence } from "../offline-queue";
import { useT } from "../locale-context";
import { useWholeDetail } from "./whole-detail";

/** What finishing reads off a task. A card's copy (`cardView`) is enough to start; the sheet reads the whole detail for the checklist. */
export type CompletionTask = Pick<TaskDetail, "id" | "title" | "intent" | "state" | "viewerId" | "workspaceId" | "evidenceChecklist" | "estimate" | "stepPlan">
  & Partial<Pick<TaskDetail, "suggestedMinutes" | "partial">>;

const MAX_FILES = 5;
/** What `evidence-attachments` keeps (`ALLOWED_ATTACHMENT_TYPES`): images, PDF, plain text, Markdown, CSV and JSON. */
const ACCEPT = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"];
const acceptable = (file: File) => ACCEPT.includes(file.type) || (!file.type && /\.(txt|md|markdown|csv|json)$/i.test(file.name));
/** Kept in Chinese (they are the keys); translated where shown. */
const FAILURE: Record<string, string> = {
  MATERIALS_PREPARING: "任务已转入材料准备，准备完成后再提交。",
  EXECUTION_NOT_STARTABLE: "当前状态不能提交，请刷新。",
  EXECUTION_NOT_ACTIVE: "当前状态不能提交，请刷新。",
  NO_ACTIVE_EXECUTION: "当前状态不能提交，请刷新。",
  INVALID_EVIDENCE_CLAIM: "说明或文件不完整，请检查后重试。",
  ATTACHMENT_COUNT_INVALID: "一次最多上传 5 个文件。"
};
/** The states completion can start from: approved work is started first (the endpoint needs a running session), running work is finished. */
export const COMPLETABLE = ["approved", "ready_for_human", "active"];

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; code?: string; message?: string; offline?: boolean }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!response) return { ok: false, offline: true };
  const result = await response.json().catch(() => ({})) as { ok?: boolean; code?: string; message?: string };
  return { ok: response.ok && result.ok !== false, ...(result.code ? { code: result.code } : {}), ...(result.message ? { message: result.message } : {}) };
}

/**
 * 完成并提交 — the one way a task is finished, wherever it is pressed (the task's page and dialog are its home; Today's block panel and
 * the task cards open the same form in a sheet, `TaskCompletionSheet`). One line saying what was done, an optional link, files dropped or
 * chosen, the milestone's completion questions when it has them, and how long it really took in one tap (what the estimate calibration
 * learns from). It goes through the task's own endpoints: files to `evidence-attachments`, then `execution` `complete` with them as
 * evidence, after starting the session when the task was not running. With nothing to hand in, 「完成（记为无证据）」; when `stepId` is
 * one of several open steps, 「只完成本步」 marks that step done and leaves the task open. Offline, a completion without files is queued on
 * the device and replayed when the connection is back, like start and pause.
 */
export function TaskCompletion({ task, stepId, onDone }: {
  task: CompletionTask;
  /** The step this completion was opened from (a block on Today); offers 「只完成本步」 when other steps are still open. */
  stepId?: string | undefined;
  /** Called after a successful submit instead of reloading the page. */
  onDone?: (() => void) | undefined;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [reported, setReported] = useState<{ minutes: number; source: "one_tap" | "activity" } | null>(
    task.suggestedMinutes ? { minutes: task.suggestedMinutes, source: "activity" } : null);
  const [ownMinutes, setOwnMinutes] = useState("");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const base = `/api/work-orders/${encodeURIComponent(task.id)}`;
  const steps = task.stepPlan?.steps ?? [];
  const step = stepId ? steps.find((item) => item.id === stepId) : undefined;
  const otherSteps = steps.filter((item) => item.status === "planned" && item.schedulable && item.id !== stepId).length;
  const estimateP50 = task.estimate.p50Minutes;
  const finished = () => { if (onDone) onDone(); else location.reload(); };

  const add = (incoming: FileList | File[]) => {
    const usable = [...incoming].filter(acceptable);
    setStatus(usable.length < [...incoming].length ? t("只接受 PDF、文本或图片文件。") : "");
    setFiles((current) => {
      const seen = new Set(current.map((file) => `${file.name}:${file.size}`));
      return [...current, ...usable.filter((file) => !seen.has(`${file.name}:${file.size}`))].slice(0, MAX_FILES);
    });
  };
  const onDrop = (event: DragEvent<HTMLElement>) => { event.preventDefault(); setOver(false); if (event.dataTransfer.files.length) add(event.dataTransfer.files); };
  const fail = (code?: string, message?: string) => { setBusy(false); setStatus(FAILURE[code ?? ""] ? t(FAILURE[code ?? ""]!) : message ?? t("未能提交，请刷新后重试。")); };

  const record = () => note.trim() ? [{ kind: "record", uri: link.trim() || `note:${task.id}`, description: note.trim().slice(0, 500) }] : [];
  const extras = () => ({
    checklistAnswers: Object.entries(answers).filter(([, answer]) => answer.trim()).map(([questionId, answer]) => ({ questionId, answer: answer.trim() })),
    ...(reported ? { reportedMinutes: reported.minutes, reportedSource: reported.source } : {})
  });
  /** Queued on the device: only without files, which cannot wait in the outbox. */
  const queue = async (withEvidence: boolean) => {
    if (withEvidence && files.length) { setStatus(t("网络不可用，联网后再提交。")); return; }
    const command = createCommand(task.viewerId, task.workspaceId, await nextSequence(task.workspaceId), "work_order.complete",
      { workOrderId: task.id, title: task.intent, evidence: withEvidence ? record() : [], ...extras() });
    try { await enqueue(task.workspaceId, command); setStatus(t("已离线保存，联网后自动同步")); } catch { setStatus(t("网络不可用，联网后再提交。")); }
  };

  const submit = async (withEvidence: boolean) => {
    if (!navigator.onLine) { if (task.state === "active") await queue(withEvidence); else setStatus(t("网络不可用，联网后再提交。")); return; }
    setBusy(true); setStatus("");
    if (task.state !== "active") {
      const started = await postJson(`${base}/execution`, { action: "start" });
      if (!started.ok) { fail(started.code, started.message); return; }
    }
    const evidence: Array<{ kind: string; uri: string; description: string }> = [];
    if (withEvidence && files.length) {
      setStatus(t("上传中…"));
      const form = new FormData();
      for (const file of files) form.append("file", file);
      const response = await fetch(`${base}/evidence-attachments`, { method: "POST", body: form }).catch(() => null);
      const body = await response?.json().catch(() => null) as { saved?: Array<{ uri: string; fileName: string }>; code?: string; message?: string } | null;
      if (!response?.ok || !body?.saved?.length) { fail(body?.code, body?.message); return; }
      evidence.push(...body.saved.map((file) => ({ kind: "file", uri: file.uri, description: file.fileName })));
    }
    if (withEvidence) evidence.push(...record());
    const done = await postJson(`${base}/execution`, { action: "complete", evidence, ...extras() });
    if (done.offline) { setBusy(false); await queue(withEvidence); return; }
    if (!done.ok) { fail(done.code, done.message); return; }
    finished();
  };
  const finishStep = async () => {
    if (!stepId) return;
    setBusy(true); setStatus("");
    const done = await postJson(`${base}/steps`, { action: "progress", stepId, status: "done" });
    if (!done.ok) { fail(done.code, done.message); return; }
    if (note.trim()) await postJson(`${base}/steps`, { action: "report", text: `${step ? t("「{{step}}」：", { step: step.title }) : ""}${note.trim()}`.slice(0, 2000) });
    finished();
  };
  const hasEvidence = Boolean(note.trim() || files.length);

  return <div className="tk-complete" id="complete">
    <p className="tk-complete-task"><b>{task.title}</b>{step ? <small> · {step.title}</small> : null}</p>
    <label className="tk-complete-field"><span>{t("完成说明")}</span>
      <input value={note} maxLength={500} placeholder={t("例如：完成第 3 章习题 12 道，附手写解答")} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label>
    <label className="tk-complete-field"><span>{t("链接（选填）")}</span>
      <input value={link} maxLength={500} inputMode="url" placeholder={t("成果所在的地址，例如文档或仓库链接")} onChange={(event) => setLink(event.target.value)} disabled={busy} /></label>
    <div className="tk-drop" data-over={over || undefined} onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <span>{t("拖入文件，或")}</span>
      <button type="button" onClick={() => input.current?.click()} disabled={busy || files.length >= MAX_FILES}>{t("选择文件")}</button>
      <input ref={input} type="file" multiple hidden accept={[...ACCEPT, ".txt", ".pdf", ".md", ".csv", ".json"].join(",")} aria-label={t("选择材料文件")}
        onChange={(event) => { if (event.currentTarget.files) add(event.currentTarget.files); event.currentTarget.value = ""; }} />
      <small>{t("PDF、文本或图片，最多 {{n}} 个；文件交给里程碑验收", { n: MAX_FILES })}</small>
    </div>
    {files.length > 0 && <ul className="tk-files">{files.map((file) => <li key={`${file.name}:${file.size}`}>
      <span>{file.name}</span><small className="mono">{Math.max(1, Math.round(file.size / 1024))} KB</small>
      <button type="button" aria-label={t("移除 {{name}}", { name: file.name })} disabled={busy} onClick={() => setFiles((current) => current.filter((item) => item !== file))}>×</button>
    </li>)}</ul>}
    {/* Pre-generated at milestone approval (工作块 E): one click or the specifics, recorded as the person's answer. */}
    {task.evidenceChecklist.length > 0 && <fieldset className="evidence-checklist">
      <legend>{t("完成情况（可选）")}</legend>
      {task.evidenceChecklist.map((question) => <div key={question.id} className="evidence-question">
        <span>{question.prompt}</span>
        {question.kind === "checkbox"
          ? <div className="evidence-question-options">{question.options.map((option) => <label key={option}>
              <input type="radio" name={`checklist-${task.id}-${question.id}`} checked={answers[question.id] === option}
                onChange={() => setAnswers((current) => ({ ...current, [question.id]: option }))} />
              <span>{option}</span>
            </label>)}</div>
          : <input value={answers[question.id] ?? ""} maxLength={2000} placeholder={t("输入具体情况")} aria-label={question.prompt}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
      </div>)}
    </fieldset>}
    {/* 「实际花了多久」 in one tap: the only number for work done away from the timer, and what the estimate calibration learns from. */}
    {estimateP50 > 0 && <fieldset className="reported-minutes">
      <legend>{t("实际用时（用于校准估时）")}</legend>
      {task.suggestedMinutes ? <button type="button" aria-pressed={reported?.source === "activity"} onClick={() => setReported({ minutes: task.suggestedMinutes!, source: "activity" })}>
        {t("屏幕记录约 {{minutes}} 分", { minutes: task.suggestedMinutes })}</button> : null}
      {([["≈估时", 1], ["一半", 0.5], ["多一半", 1.5], ["两倍", 2]] as const).map(([label, factor]) => {
        const minutes = Math.max(5, Math.round(estimateP50 * factor / 5) * 5);
        return <button key={label} type="button" aria-pressed={reported?.source === "one_tap" && reported.minutes === minutes}
          onClick={() => setReported({ minutes, source: "one_tap" })}>{t("{{label}} {{minutes}} 分", { label: t(label), minutes })}</button>;
      })}
      <label><span className="sr-only">{t("自己填分钟数")}</span>
        <input inputMode="numeric" value={ownMinutes} placeholder={t("分钟数")} maxLength={4} onChange={(event) => {
          setOwnMinutes(event.target.value);
          const minutes = Number(event.target.value);
          setReported(Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 ? { minutes, source: "one_tap" } : null);
        }} /></label>
    </fieldset>}
    {otherSteps > 0 && stepId && <p className="tk-complete-hint">{t("提交即整个任务完成，进入验收；本任务还有 {{count}} 个未完成步骤。", { count: otherSteps })}</p>}
    <div className="tk-complete-actions">
      <button type="button" className="primary-button" disabled={busy || !hasEvidence} onClick={() => void submit(true)}>{t("提交")}</button>
      <button type="button" disabled={busy} onClick={() => void submit(false)}>{t("完成（记为无证据）")}</button>
      {otherSteps > 0 && stepId && <button type="button" disabled={busy} onClick={() => void finishStep()}>{t("只完成本步")}</button>}
    </div>
    {status && <small role="status">{status}</small>}
  </div>;
}

/**
 * The same form in a sheet titled 「完成并提交材料」, for every place that is not the task itself (Today's block panel, a task card).
 * A card's copy of the task is completed with the whole detail once it is read (the milestone's questions, the screen record's minutes).
 */
export function TaskCompletionSheet({ task, stepId, open, onOpenChange }: {
  task: TaskDetail; stepId?: string | undefined; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const whole = useWholeDetail(task, open);
  return <Sheet title={t("完成并提交材料")} open={open} onOpenChange={onOpenChange}>
    <TaskCompletion key={whole && whole !== "failed" ? "whole" : "card"} task={whole && whole !== "failed" ? whole : task} stepId={stepId} />
  </Sheet>;
}
