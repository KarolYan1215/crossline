"use client";

import { useState } from "react";
import { planFolderUpload, type FolderUploadPlan } from "./folder-pick";

const megabytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * 「选择文件夹」: the system's folder dialog, then what would go up and what is left out and why, before anything is sent. Uploading goes
 * through the same path as 「添加文件或录音」 (`onUpload`), in batches.
 */
export function FolderPicker({ busy, onUpload }: { busy: boolean; onUpload: (files: File[]) => void }) {
  const [picked, setPicked] = useState<{ folder: string; files: Map<string, File>; plan: FolderUploadPlan }>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const choose = (list: FileList | null) => {
    const files = new Map([...(list ?? [])].map((file) => [(file.webkitRelativePath || file.name).replace(/\\/g, "/"), file] as const));
    if (!files.size) return;
    const plan = planFolderUpload([...files].map(([path, file]) => ({ path, size: file.size, modified: file.lastModified })));
    setTicked(new Set());
    setPicked({ folder: [...files.keys()][0]!.split("/")[0] ?? "", files, plan });
  };
  const chosen = picked ? [...picked.plan.upload, ...picked.plan.sensitive.map((item) => item.path).filter((path) => ticked.has(path))] : [];
  const bytes = chosen.reduce((sum, path) => sum + (picked?.files.get(path)?.size ?? 0), 0);
  return <>
    <label className="ob-drop">
      {/* `webkitdirectory` is not in React's typings; every current browser supports it. */}
      <input type="file" multiple hidden disabled={busy} {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
      <b>选择文件夹</b>
      <small>选中一个文件夹，先列出会上传哪些，确认后再传；密钥类文件不会上传</small>
    </label>
    {picked && <div className="ob-folder-plan" role="group" aria-label={`文件夹「${picked.folder}」`}>
      <p><b>「{picked.folder}」</b>：将上传 {chosen.length} 个文件（{megabytes(bytes)}）</p>
      {picked.plan.sensitive.length > 0 && <fieldset>
        <legend>像是私人文件，默认不上传；需要的勾选</legend>
        {picked.plan.sensitive.map((item) => <label key={item.path}>
          <input type="checkbox" checked={ticked.has(item.path)} onChange={() => setTicked((now) => {
            const next = new Set(now); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next; })} />
          <span>{item.path.split("/").slice(1).join("/")}</span><small>{item.reason}</small>
        </label>)}
      </fieldset>}
      <small className="ob-muted">{[
        picked.plan.credentials ? `${picked.plan.credentials} 个像密钥或密码的文件不会上传` : "",
        picked.plan.skipped ? `${picked.plan.skipped} 个是读不了的格式或在隐藏、依赖目录里，已跳过` : "",
        picked.plan.over ? `超过 ${chosen.length + picked.plan.over} 个可读文件，只传最近改过的 ${picked.plan.upload.length} 个` : ""
      ].filter(Boolean).join("；")}</small>
      <div className="ob-folder-actions">
        <button type="button" className="primary-button" disabled={busy || !chosen.length}
          onClick={() => { onUpload(chosen.map((path) => picked.files.get(path)!)); setPicked(undefined); }}>上传 {chosen.length} 个文件</button>
        <button type="button" onClick={() => setPicked(undefined)}>取消</button>
      </div>
    </div>}
  </>;
}
