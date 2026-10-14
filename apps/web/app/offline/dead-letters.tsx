"use client";
import { useEffect, useState } from "react";
import { localStamp, type DeadLetter } from "@crossline/core";
import {
  currentWorkspaceId, discardConflict, discardDeadLetter, listConflicts, listDeadLetters,
  listPending, type OfflineCommand
} from "../offline-queue";

/**
 * Dead letters are captures the server permanently refused; conflicts are commands the server refused
 * because the work order they named moved on before this one arrived (see `classifyReplay`'s `"conflict"`
 * outcome). Both are shown in full, with their reason, because the alternative — the old dead-letter-only
 * behaviour — was retrying forever or silently discarding while the person believed the action had gone
 * through either way.
 *
 * `currentWorkspaceId()`, not a prop: this page is the service worker's offline fallback, served from
 * the precache with no server-rendered props at all — `OfflineReplay` is the one place, while the app is
 * actually online, that writes the workspace id down for this page to read back with no network.
 */
export function DeadLetters() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [dead, setDead] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  const [conflicts, setConflicts] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");

  const refresh = async (id: string) => {
    try {
      setDead(await listDeadLetters(id));
      setConflicts(await listConflicts(id));
      setPending((await listPending(id)).length);
    } catch { setError("浏览器存储不可用，无法读取离线队列。"); }
  };
  useEffect(() => {
    const id = currentWorkspaceId();
    setWorkspaceId(id);
    if (id) void refresh(id);
  }, []);

  if (!workspaceId) return <p className="micro">尚未记录当前账号，请先在联网时打开一次首页。</p>;
  if (error) return <p role="alert">{error}</p>;

  const row = (entry: DeadLetter<OfflineCommand>, kind: "dead" | "conflict") => <li key={entry.command.clientCommandId}>
    <b>{String(entry.command.payload.title ?? entry.command.type)}</b>
    {Boolean(entry.command.payload.context) && <small>{String(entry.command.payload.context)}</small>}
    <small>{entry.reason} · {localStamp(entry.failedAt)}</small>
    {/* Copy first, then discard: discarding is the only way out, so the text must not vanish with it. */}
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(String(entry.command.payload.title ?? "")); }}>复制原文</button>
    <button type="button" onClick={async () => {
      if (kind === "dead") await discardDeadLetter(workspaceId, entry.command.clientCommandId);
      else await discardConflict(workspaceId, entry.command.clientCommandId);
      void refresh(workspaceId);
    }}>丢弃</button>
  </li>;

  return <>
    <section className="dead-letter-list">
      <p className="micro">等待同步 {pending} 条 · 无法同步 {dead.length} 条</p>
      {dead.length === 0
        ? <p className="micro">没有无法同步的记录。</p>
        : <ul>{dead.map((entry) => row(entry, "dead"))}</ul>}
    </section>
    <section className="dead-letter-list">
      <p className="micro">与其他设备冲突 {conflicts.length} 条</p>
      {conflicts.length === 0
        ? <p className="micro">没有冲突记录。</p>
        : <ul>{conflicts.map((entry) => row(entry, "conflict"))}</ul>}
    </section>
  </>;
}
