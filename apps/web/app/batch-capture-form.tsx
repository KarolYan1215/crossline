"use client";

import { useState, type FormEvent } from "react";
import { createCommand, enqueue, nextSequence } from "./offline-queue";

const MAX_LINES = 50;

/**
 * One line, one capture — looping the same `task.capture` command the single-line form already sends,
 * not a batch-shaped backend endpoint. Each line gets its own idempotency key and its own online/offline
 * handling, so a batch that is half online and half not still saves every line instead of failing atomically.
 */
export function BatchCaptureForm({ ownerId, workspaceId }: { ownerId: string; workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const lines = String(new FormData(form).get("lines") ?? "")
      .split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_LINES);
    if (!lines.length) return;
    setBusy(true);
    let created = 0;
    let queued = 0;
    for (const title of lines) {
      const command = createCommand(ownerId, workspaceId, await nextSequence(workspaceId), "task.capture",
        { title: title.slice(0, 240), context: "" });
      if (!navigator.onLine) {
        try { await enqueue(workspaceId, command); queued += 1; } catch { /* neither saved nor countable */ }
        continue;
      }
      try {
        const response = await fetch("/api/commands", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
        });
        if (response.ok) created += 1;
      } catch {
        try { await enqueue(workspaceId, command); queued += 1; } catch { /* neither saved nor countable */ }
      }
    }
    setBusy(false);
    setStatus(`已创建 ${created} 条${queued ? `，${queued} 条离线保存并等待同步` : ""}`);
    form.reset();
    if (created > 0) location.reload();
  };

  if (!open) return <button type="button" className="text-button" onClick={() => setOpen(true)}>批量输入 ↗</button>;
  return <form onSubmit={submit} className="batch-capture-form">
    <label><span className="sr-only">批量任务，一行一条</span>
      <textarea name="lines" required rows={4} placeholder={"一行一条任务，最多 " + MAX_LINES + " 条…"} />
    </label>
    <div className="batch-capture-actions">
      <button className="secondary-button" type="submit" disabled={busy}>{busy ? "创建中…" : "批量创建"}</button>
      <button className="text-button" type="button" onClick={() => setOpen(false)} disabled={busy}>取消</button>
    </div>
    {status && <small className="muted" role="status">{status}</small>}
  </form>;
}
