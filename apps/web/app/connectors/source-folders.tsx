"use client";
import { useCallback, useEffect, useState } from "react";
import type { SourceFolder } from "@crossline/core";

type Preview = { state: "preview"; path: string; label: string; files: number; nameOnly: number; bytes: number; skippedDirectories: number; capped: boolean; sample: string[] };
const megabytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/**
 * Authorized folders (docs/onboarding-v3.md 「文件夹授权」, decided 2026-10-14). The person gives a folder's path; before anything is read
 * the card says how many files would be read and how large they are, then the folder is read in the background and kept up to date. Each
 * folder shows the lines it serves — the model's proposal until the person changes it — and can be revoked (what was read stays).
 */
export function SourceFolders({ onChanged }: { onChanged?: () => void }) {
  const [folders, setFolders] = useState<SourceFolder[] | undefined>();
  const [lines, setLines] = useState<Array<{ id: string; label: string }>>([]);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/sources/folders", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { folders?: SourceFolder[]; lines?: Array<{ id: string; label: string }> } | undefined;
    setFolders(body?.folders ?? []);
    setLines(body?.lines ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While a folder is being read for the first time, look again every few seconds.
  const reading = folders?.some((folder) => !folder.lastScanAt) ?? false;
  // 「正在后台读取」 is said only while it is true.
  useEffect(() => { if (!reading) setMessage((now) => now.startsWith("已授权") ? "" : now); }, [reading, folders]);
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void load().then(() => onChanged?.()), 4000);
    return () => clearInterval(timer);
  }, [reading, load, onChanged]);

  const post = async (body: object) => {
    const response = await fetch("/api/sources/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    return await response?.json().catch(() => undefined) as ({ state?: string; message?: string } & Partial<Omit<Preview, "state">>) | undefined;
  };
  const look = async () => {
    setBusy(true); setMessage(""); setPreview(undefined);
    const answer = await post({ action: "preview", path: draft });
    if (answer?.state === "preview") setPreview(answer as Preview); else setMessage(answer?.message ?? "后台服务没有连上，稍后再试。");
    setBusy(false);
  };
  const authorize = async () => {
    if (!preview) return;
    setBusy(true);
    const answer = await post({ action: "add", path: preview.path });
    if (answer?.state === "added") { setPreview(undefined); setDraft(""); setMessage("已授权，正在后台读取。"); }
    else setMessage(answer?.message ?? "没能授权这个文件夹。");
    await load();
    onChanged?.();
    setBusy(false);
  };
  const toggleLine = async (folder: SourceFolder, lineId: string) => {
    const next = folder.lines.includes(lineId) ? folder.lines.filter((id) => id !== lineId) : [...folder.lines, lineId];
    setFolders((all) => all?.map((item) => item.id === folder.id ? { ...item, lines: next, linesBy: "person" } : item));
    await post({ action: "lines", id: folder.id, lines: next });
    await load();
  };
  const revoke = async (id: string) => {
    setBusy(true);
    await fetch(`/api/sources/folders?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    await load();
    setBusy(false);
  };

  return <section className="st-card source-folders" aria-label="授权文件夹">
    <header><h3>授权文件夹</h3><small>读取文件夹里所有能读的文件（PDF、Word、文本），之后有新文件或改动会自动重读</small></header>
    {folders?.map((folder) => <div className="source-folder" key={folder.id}>
      <div className="st-row">
        <span className="st-row-label">{folder.label}
          <small>{folder.lastError ? folder.lastError
            : !folder.lastScanAt ? "正在读取…"
            : `已读 ${folder.files ?? 0} 个文件${folder.nameOnly ? `，${folder.nameOnly} 个只记文件名` : ""}${folder.capped ? "（超过上限，只读了前 1000 个）" : ""}`}</small>
        </span>
        <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => void revoke(folder.id)}>取消授权</button>
      </div>
      {lines.length > 0 && folder.lastScanAt && <div className="source-folder-lines" role="group" aria-label={`${folder.label} 属于哪些主线`}>
        <small>{folder.linesBy === "person" ? "属于" : folder.linesBy === "model" ? "推测属于" : "还没归到主线"}</small>
        {lines.map((line) => <button key={line.id} type="button" className="ob-chip" data-line={line.id} aria-pressed={folder.lines.includes(line.id)}
          onClick={() => void toggleLine(folder, line.id)}>{line.label}</button>)}
        {folder.linesBy === "model" && folder.linesWhy && <small className="gen">{folder.linesWhy}</small>}
      </div>}
    </div>)}
    <form className="source-folders-form" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void look(); }}>
      <input value={draft} onChange={(event) => { setDraft(event.target.value); setPreview(undefined); }} placeholder="文件夹完整路径，如 D:\课程资料"
        aria-label="文件夹路径" disabled={busy} spellCheck={false} />
      <button type="submit" className="ob-btn secondary-button" disabled={busy || !draft.trim()}>{busy && !preview ? "查看中…" : "查看"}</button>
    </form>
    {preview && <div className="source-folders-preview" role="status">
      <p>将读取 <b>{preview.files}</b> 个文件（共 {megabytes(preview.bytes)}）{preview.nameOnly ? `，另有 ${preview.nameOnly} 个只记文件名` : ""}
        {preview.skippedDirectories ? `；跳过 ${preview.skippedDirectories} 个依赖、缓存或隐藏文件夹` : ""}{preview.capped ? "；文件太多，只读前 1000 个" : ""}。</p>
      {preview.sample.length > 0 && <ul>{preview.sample.map((name) => <li key={name}>{name}</li>)}</ul>}
      <button type="button" className="ob-btn primary-button" disabled={busy || preview.files + preview.nameOnly === 0} onClick={() => void authorize()}>授权并读取</button>
    </div>}
    {message && <p role="status" className="muted">{message}</p>}
  </section>;
}
