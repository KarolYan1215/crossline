"use client";
import { useEffect, useState } from "react";

type OutputFile = { path: string; name: string; bytes: number; href: string };
type OutputTask = { taskId: string; title: string; at: string; status: "accepted" | "needs_review"; partial: boolean; files: OutputFile[] };
type OutputLine = { id: string; label: string; tasks: OutputTask[] };
type Folder = { lines: OutputLine[]; files: number; bytes: number };

const size = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
const day = (iso: string) => iso.slice(5, 10).replace("-", "/");

/**
 * 助手产出 (2026-10-19): the folder every finished assistant run writes into — by line, then by task — with each file downloadable and a
 * task, a line or everything downloadable as one zip. The person's own files are never changed; what the assistant made from them is here.
 */
export function OutputsCard() {
  const [folder, setFolder] = useState<Folder | undefined>();
  useEffect(() => {
    void fetch("/api/outputs", { cache: "no-store" }).then((response) => response.json()).then((body: Folder) => setFolder(body.lines ? body : { lines: [], files: 0, bytes: 0 }))
      .catch(() => setFolder({ lines: [], files: 0, bytes: 0 }));
  }, []);
  return <section className="st-card outputs-card" aria-label="助手产出">
    <header><h3>助手产出</h3><small>助手每次做完交出的文件都放在这里，按主线和任务分开；不改动本人上传的原文件</small></header>
    {!folder ? <p className="muted">读取中…</p>
      : !folder.files ? <p className="muted">还没有产出。交给助手的任务、准备步骤和自动化做完后，文件会出现在这里。</p>
      : <>
        <p className="outputs-total">{folder.files} 个文件，共 {size(folder.bytes)}
          <a className="secondary-button" href="/api/outputs/zip" download>全部打包下载</a></p>
        {folder.lines.map((line) => <details key={line.id} className="st-fold outputs-line">
          <summary>{line.label} · {line.tasks.length} 个任务
            <a className="outputs-zip" href={`/api/outputs/zip?line=${encodeURIComponent(line.id)}`} download onClick={(event) => event.stopPropagation()}>打包下载</a></summary>
          <ul className="st-list">{line.tasks.map((task) => <li key={task.taskId}>
            <span className="outputs-task">{day(task.at)} {task.title}{task.status === "needs_review" ? " · 待确认" : ""}{task.partial ? " · 未做完" : ""}
              <a className="outputs-zip" href={`/api/outputs/zip?task=${encodeURIComponent(task.taskId)}`} download>打包下载</a></span>
            <ul className="outputs-files">{task.files.map((file) => <li key={file.path}>
              <a href={file.href} download>{file.name}</a> <small>{size(file.bytes)}</small></li>)}</ul>
          </li>)}</ul>
        </details>)}
      </>}
  </section>;
}
