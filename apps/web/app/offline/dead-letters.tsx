"use client";
import { useEffect, useState } from "react";
import type { DeadLetter } from "@crossline/core";
import { discardDeadLetter, listDeadLetters, listPending, type OfflineCommand } from "../offline-queue";

/**
 * Dead letters are captures the server permanently refused. They are shown in full, with their reason,
 * because the alternative — the old behaviour — was retrying them forever while the person believed
 * they had been saved.
 */
export function DeadLetters() {
  const [dead, setDead] = useState<Array<DeadLetter<OfflineCommand>>>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setDead(await listDeadLetters());
      setPending((await listPending()).length);
    } catch { setError("浏览器存储不可用，无法读取离线队列。"); }
  };
  useEffect(() => { void refresh(); }, []);

  if (error) return <p role="alert">{error}</p>;
  return <section className="dead-letter-list">
    <p className="micro">等待同步 {pending} 条 · 无法同步 {dead.length} 条</p>
    {dead.length === 0
      ? <p className="micro">没有无法同步的记录。</p>
      : <ul>{dead.map((entry) => <li key={entry.command.clientCommandId}>
        <b>{String(entry.command.payload.title ?? "(无标题)")}</b>
        {Boolean(entry.command.payload.context) && <small>{String(entry.command.payload.context)}</small>}
        <small>{entry.reason} · {entry.failedAt.slice(0, 16).replace("T", " ")}</small>
        {/* Copy first, then discard: discarding is the only way out, so the text must not vanish with it. */}
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(String(entry.command.payload.title ?? "")); }}>复制原文</button>
        <button type="button" onClick={async () => { await discardDeadLetter(entry.command.clientCommandId); void refresh(); }}>丢弃</button>
      </li>)}</ul>}
  </section>;
}
