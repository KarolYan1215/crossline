"use client";

import { useEffect, useState } from "react";
import {
  createCommand, deviceId, enqueue, listConflicts, listDeadLetters, nextSequence, rememberWorkspace,
  replayQueue, type OfflineCommand
} from "./offline-queue";
import type { DeadLetter } from "@crossline/core";
import type { ComposerInput } from "./chat/composer";

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

/**
 * Keeps a line as a capture: queued offline without a connection (replayed by `OfflineReplay`), with its files uploaded when online.
 * The one input box (`chat/conversation.tsx`) uses it only where the conversation cannot run — offline, and for files until the box
 * reads them itself. Returns the words shown under the box, or null when nothing could be kept.
 */
export async function captureLine(ownerId: string, workspaceId: string, { text, files, mentions }: ComposerInput): Promise<string | null> {
  const [title, ...rest] = text.split("\n");
  const linked = mentions.length ? `关联：${mentions.map((item) => `${{ material: "资料", task: "任务", milestone: "里程碑" }[item.kind]}「${item.title}」`).join("；")}` : "";
  const command = createCommand(ownerId, workspaceId, await nextSequence(workspaceId), "task.capture", {
    title: (title || files[0]?.name || "附件").slice(0, 240), context: [rest.join("\n").trim(), linked].filter(Boolean).join("\n").slice(0, 500) });
  const save = async (message: string) => {
    try {
      await enqueue(workspaceId, command);
      // A queued capture has no server row yet for a file to belong to, so files picked offline are not claimed as saved.
      return files.length ? `${message}；离线时选择的 ${files.length} 个附件未保存，联网后需重新上传` : message;
    } catch { return null; }
  };
  if (!navigator.onLine) return save("已离线保存，联网后自动同步");
  try {
    const response = await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    if (!response.ok) return null;
    if (files.length) {
      // The command's client id is the capture's real id, so files attach to it directly.
      const upload = new FormData();
      for (const file of files) upload.append("file", file);
      const uploaded = await fetch(`/api/captures/${encodeURIComponent(command.clientCommandId)}/attachments`, { method: "POST", body: upload }).catch(() => null);
      if (!uploaded?.ok) return "已收集，附件上传失败，可在任务页重试";
    }
    return "已收集 · 约 1 分钟后完成分类与估时，结果进入「待确认」";
  } catch { return save("网络不可用，已保存并等待同步"); }
}
