"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  createCommand, enqueue, listDeadLetters, nextSequence, replayQueue, type OfflineCommand
} from "./offline-queue";
import type { DeadLetter } from "@crossline/core";

export function OfflineReplay() {
  const [dead, setDead] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  useEffect(() => {
    const replay = async () => {
      try {
        const summary = await replayQueue();
        setDead(await listDeadLetters());
        if (summary.sent > 0) location.reload();
      } catch { /* IndexedDB unavailable; the forms below still report this per submit. */ }
    };
    window.addEventListener("online", replay);
    if (navigator.onLine) void replay();
    return () => window.removeEventListener("online", replay);
  }, []);

  // A dead letter is shown where the queue lives. Silently dropping it would be the same as the old
  // behaviour of retrying it forever: either way the person never learns the capture was lost.
  if (!dead.length) return null;
  return <aside className="dead-letters" role="alert">
    <b>{dead.length} 条离线记录无法同步</b>
    <ul>{dead.map((entry) => <li key={entry.command.clientCommandId}>
      <span>{String(entry.command.payload.title ?? "(无标题)")}</span>
      <small>{entry.reason} · {entry.failedAt.slice(0, 16).replace("T", " ")}</small>
    </li>)}</ul>
    <a href="/offline">查看并处理 →</a>
  </aside>;
}

export function OfflineCaptureForm({ ownerId, workspaceId }: { ownerId: string; workspaceId: string }) {
  const [status, setStatus] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const command = createCommand(ownerId, workspaceId, await nextSequence(), "task.capture", {
      title: String(data.get("title") ?? ""),
      context: String(data.get("context") ?? "")
    });
    const save = async (message: string) => {
      try {
        await enqueue(command);
        form.reset();
        setStatus(message);
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
      location.reload();
    } catch {
      await save("网络不可用，已保存并等待同步");
    }
  };
  return <form onSubmit={submit} className="capture-form">
    <label><span className="sr-only">任务或想法</span><input name="title" required maxLength={240} placeholder="写下一项任务、想法，或粘贴一个链接…" /></label>
    <label><span className="sr-only">补充上下文</span><input name="context" maxLength={500} placeholder="可选：把需要的材料直接粘进来（只写材料在哪，AI 是拿不到的）" /></label>
    <button className="secondary-button" type="submit">CAPTURE ↗</button>
    {status && <small className="muted" role="status">{status}</small>}
  </form>;
}
