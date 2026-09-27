"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import {
  createCommand, deviceId, enqueue, listConflicts, listDeadLetters, nextSequence, rememberWorkspace,
  replayQueue, type OfflineCommand
} from "./offline-queue";
import type { DeadLetter } from "@crossline/core";

/** Renews (or first-issues) this browser's 24-hour device lease. Best-effort: a lease that fails to
 * renew only matters once it actually expires, which `POST /api/commands` would then start refusing —
 * failing this call must not block replay itself. */
async function renewDeviceLease(): Promise<void> {
  await fetch("/api/auth/device-lease", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId() })
  }).catch(() => undefined);
}

export function OfflineReplay({ workspaceId }: { workspaceId: string }) {
  const [dead, setDead] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  const [conflicts, setConflicts] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  useEffect(() => {
    // Remembered here, not only read at submit time: the `/offline` fallback page is served from the
    // service worker's precache with no server-rendered props at all, so this is the only place that
    // ever gets a chance to write it down while the app is actually online and authenticated.
    rememberWorkspace(workspaceId);
    const replay = async () => {
      try {
        await renewDeviceLease();
        const summary = await replayQueue(workspaceId);
        setDead(await listDeadLetters(workspaceId));
        setConflicts(await listConflicts(workspaceId));
        if (summary.sent > 0) location.reload();
      } catch { /* IndexedDB unavailable; the forms below still report this per submit. */ }
    };
    window.addEventListener("online", replay);
    if (navigator.onLine) void replay();
    return () => window.removeEventListener("online", replay);
  }, [workspaceId]);

  // A dead letter or conflict is shown where the queue lives. Silently dropping either would be the
  // same as the old behaviour of retrying forever: either way the person never learns what happened.
  const total = dead.length + conflicts.length;
  if (!total) return null;
  return <aside className="dead-letters" role="alert">
    <b>{dead.length > 0 && `${dead.length} 条离线记录无法同步`}{dead.length > 0 && conflicts.length > 0 && " · "}
      {conflicts.length > 0 && `${conflicts.length} 条与其他设备冲突`}</b>
    <ul>{[...dead, ...conflicts].map((entry) => <li key={entry.command.clientCommandId}>
      <span>{String(entry.command.payload.title ?? entry.command.type)}</span>
      <small>{entry.reason} · {entry.failedAt.slice(0, 16).replace("T", " ")}</small>
    </li>)}</ul>
    <a href="/offline">查看并处理 →</a>
  </aside>;
}

const ACCEPTED_ATTACHMENT_TYPES = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain";

export function OfflineCaptureForm({ ownerId, workspaceId }: { ownerId: string; workspaceId: string }) {
  const [status, setStatus] = useState("");
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The native input stays the single source of truth for what actually uploads (submit() reads it via
  // `new FormData(form)` unchanged) — drag and paste just add to its FileList through a DataTransfer
  // instead of duplicating file state next to it, which is what browsers support assigning to
  // `input.files` with.
  const addFiles = (incoming: FileList | File[]) => {
    const input = fileInputRef.current;
    if (!input) return;
    const accepted = ACCEPTED_ATTACHMENT_TYPES.split(",");
    const existing = [...(input.files ?? [])];
    const merged = new DataTransfer();
    const seen = new Set(existing.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    for (const file of [...existing, ...incoming]) {
      if (!accepted.includes(file.type)) continue;
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (seen.has(key) && !existing.includes(file)) continue;
      seen.add(key);
      merged.items.add(file);
    }
    input.files = merged.files;
    setFileNames([...merged.files].map((file) => file.name));
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };
  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    // A pasted screenshot arrives as a clipboard item, not `clipboardData.files` (that only carries an
    // actual copied file) — both paths are checked so Ctrl+V works for either source.
    const pasted = [...event.clipboardData.files,
      ...[...event.clipboardData.items].flatMap((item) => { const file = item.kind === "file" ? item.getAsFile() : null; return file ? [file] : []; })];
    if (pasted.length) addFiles(pasted);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const files = (data.getAll("attachments") as File[]).filter((file) => file.size > 0);
    const command = createCommand(ownerId, workspaceId, await nextSequence(workspaceId), "task.capture", {
      title: String(data.get("title") ?? ""),
      context: String(data.get("context") ?? "")
    });
    const save = async (message: string) => {
      try {
        await enqueue(workspaceId, command);
        form.reset();
        setFileNames([]);
        // The offline queue only carries the JSON command — a queued capture has no server-side row
        // yet for an attachment to belong to, so files picked while offline are dropped rather than
        // silently claimed as saved.
        setStatus(files.length ? `${message}（离线时选择的 ${files.length} 个附件未保存，请联网后重新上传）` : message);
      } catch {
        // Saying "saved" when the store refused would lose the capture without telling anyone.
        setStatus("无法离线保存（浏览器存储不可用），请先复制内容再重试。");
      }
    };
    if (!navigator.onLine) { await save("已离线保存，联网后自动同步"); return; }
    try {
      const response = await fetch("/api/commands", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
      });
      if (!response.ok) { setStatus("任务输入无效，请检查后重试"); return; }
      if (files.length) {
        // The command's `clientCommandId` is generated client-side and used verbatim as the capture's
        // real id (see `POST /api/commands`), so it is already known here — no need to round-trip a
        // created-id back from the response before attaching files to it.
        const upload = new FormData();
        for (const file of files) upload.append("file", file);
        const uploaded = await fetch(`/api/captures/${encodeURIComponent(command.clientCommandId)}/attachments`, {
          method: "POST", body: upload
        }).catch(() => null);
        if (!uploaded?.ok) { setStatus("任务已保存，但附件上传失败，可在作业台重试"); return; }
      }
      location.reload();
    } catch {
      await save("网络不可用，已保存并等待同步");
    }
  };
  return <form onSubmit={submit} onPaste={onPaste} className="capture-form">
    <label><span className="sr-only">任务或想法</span><input name="title" required maxLength={240} placeholder="写下一项任务、想法，或粘贴一个链接…" /></label>
    <label><span className="sr-only">补充上下文</span><input name="context" maxLength={500} placeholder="可选：把需要的材料直接粘进来（只写材料在哪，AI 是拿不到的）" /></label>
    <label className={`attachment-drop${dragOver ? " dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <span className="sr-only">附件</span>
      <input ref={fileInputRef} name="attachments" type="file" multiple accept={ACCEPTED_ATTACHMENT_TYPES}
        onChange={(event) => setFileNames([...(event.currentTarget.files ?? [])].map((file) => file.name))} />
      <small>{fileNames.length ? `已选 ${fileNames.length} 个：${fileNames.join("、")}` : "拖文件到这里，或 Ctrl+V 粘贴截图/文件"}</small>
    </label>
    <button className="secondary-button" type="submit">CAPTURE ↗</button>
    {status && <small className="muted" role="status">{status}</small>}
  </form>;
}
