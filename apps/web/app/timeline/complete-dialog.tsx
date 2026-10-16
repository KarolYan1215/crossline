"use client";

import { useRef, useState, type DragEvent } from "react";
import { Sheet } from "../ui/overlay";
import { useT } from "../locale-context";

const MAX_FILES = 5;
/** What `evidence-attachments` keeps (`ALLOWED_ATTACHMENT_TYPES`): images, PDF, plain text, Markdown, CSV and JSON. */
const ACCEPT = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"];
const acceptable = (file: File) => ACCEPT.includes(file.type) || (!file.type && /\.(txt|md|markdown|csv|json)$/i.test(file.name));
/** Kept in Chinese (they are the keys); translated where shown. */
const FAILURE: Record<string, string> = {
  MATERIALS_PREPARING: "任务已转入材料准备，准备完成后再提交。",
  EXECUTION_NOT_STARTABLE: "当前状态不能提交，请刷新。",
  EXECUTION_NOT_ACTIVE: "当前状态不能提交，请刷新。",
  INVALID_EVIDENCE_CLAIM: "说明或文件不完整，请检查后重试。",
  ATTACHMENT_COUNT_INVALID: "一次最多上传 5 个文件。"
};

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; code?: string; message?: string }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const result = await response?.json().catch(() => ({})) as { ok?: boolean; code?: string; message?: string } | undefined;
  return { ok: Boolean(response?.ok) && result?.ok !== false, ...(result?.code ? { code: result.code } : {}), ...(result?.message ? { message: result.message } : {}) };
}

/**
 * 完成并提交材料, from a block on the day view: one line saying what was done and the files that show it, dropped or chosen. It goes
 * through the same two endpoints the task page uses — files to `evidence-attachments`, then `complete` with them as evidence — after
 * starting the timer if the task was not running (both endpoints need a running task). With nothing to hand in, 「完成（记为无证据）」.
 * When the block is one step of several, 「只完成本步」 marks that step done and leaves the task open.
 */
export function CompleteDialog({ open, onOpenChange, workOrderId, title, state, stepId, stepTitle, otherSteps }: {
  open: boolean; onOpenChange: (open: boolean) => void; workOrderId: string; title: string; state: string;
  stepId?: string | undefined; stepTitle?: string | undefined; otherSteps: number;
}) {
  const t = useT();
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const base = `/api/work-orders/${encodeURIComponent(workOrderId)}`;

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
  const submit = async (withEvidence: boolean) => {
    if (!navigator.onLine) { setStatus(t("网络不可用，联网后再提交。")); return; }
    setBusy(true); setStatus("");
    if (state !== "active") {
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
    if (withEvidence && note.trim()) evidence.push({ kind: "record", uri: `note:${workOrderId}`, description: note.trim().slice(0, 500) });
    const done = await postJson(`${base}/execution`, { action: "complete", evidence });
    if (!done.ok) { fail(done.code, done.message); return; }
    location.reload();
  };
  const finishStep = async () => {
    if (!stepId) return;
    setBusy(true); setStatus("");
    const done = await postJson(`${base}/steps`, { action: "progress", stepId, status: "done" });
    if (!done.ok) { fail(done.code, done.message); return; }
    if (note.trim()) await postJson(`${base}/steps`, { action: "report", text: `${stepTitle ? t("「{{step}}」：", { step: stepTitle }) : ""}${note.trim()}`.slice(0, 2000) });
    location.reload();
  };
  const hasEvidence = Boolean(note.trim() || files.length);

  return <Sheet title={t("完成并提交材料")} open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <div className="dq-complete">
      <p className="dq-complete-task"><b>{title}</b>{stepTitle ? <small> · {stepTitle}</small> : null}</p>
      <label className="dq-complete-note"><span>{t("完成说明")}</span>
        <input value={note} maxLength={500} placeholder={t("例如：完成第 3 章习题 12 道，附手写解答")} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label>
      <div className="dq-drop" data-over={over || undefined} onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <span>{t("拖入文件，或")}</span>
        <button type="button" onClick={() => input.current?.click()} disabled={busy || files.length >= MAX_FILES}>{t("选择文件")}</button>
        <input ref={input} type="file" multiple hidden accept={[...ACCEPT, ".txt", ".pdf"].join(",")} aria-label={t("选择材料文件")}
          onChange={(event) => { if (event.currentTarget.files) add(event.currentTarget.files); event.currentTarget.value = ""; }} />
        <small>{t("PDF、文本或图片，最多 {{n}} 个；文件交给里程碑验收", { n: MAX_FILES })}</small>
      </div>
      {files.length > 0 && <ul className="dq-files">{files.map((file) => <li key={`${file.name}:${file.size}`}>
        <span>{file.name}</span><small className="mono">{Math.max(1, Math.round(file.size / 1024))} KB</small>
        <button type="button" aria-label={t("移除 {{name}}", { name: file.name })} disabled={busy} onClick={() => setFiles((current) => current.filter((item) => item !== file))}>×</button>
      </li>)}</ul>}
      {otherSteps > 0 && stepId && <p className="dq-complete-hint">{t("提交即整个任务完成，进入验收；本任务还有 {{count}} 个未完成步骤。", { count: otherSteps })}</p>}
      <div className="dq-complete-actions">
        <button type="button" className="primary-button" disabled={busy || !hasEvidence} onClick={() => void submit(true)}>{t("提交")}</button>
        <button type="button" disabled={busy} onClick={() => void submit(false)}>{t("完成（记为无证据）")}</button>
        {otherSteps > 0 && stepId && <button type="button" disabled={busy} onClick={() => void finishStep()}>{t("只完成本步")}</button>}
      </div>
      {status && <small role="status">{status}</small>}
    </div>
  </Sheet>;
}
