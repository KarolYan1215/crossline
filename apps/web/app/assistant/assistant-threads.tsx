"use client";

import { useCallback, useEffect, useState } from "react";
import type { ThreadView } from "../../lib/threads";
import { Conversation } from "../chat/conversation";
import { useT } from "../locale-context";

const call = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((response) => response.json().catch(() => ({}))).catch(() => ({}));

/** A thread's name: its own, else today's / the day's, else 「新对话」. */
export function threadName(thread: ThreadView, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (thread.title.trim()) return thread.title;
  if (thread.today) return t("今天");
  return thread.kind === "day" ? t("{{day}} 的对话", { day: thread.day }) : t("新对话");
}

/**
 * 小帮手's threads (new / rename / continue / archive) and the one open. Kept apart from the page so another page (per-workflow threads)
 * can use `ThreadList` and `Conversation variant="thread"` without this layout.
 */
export function AssistantThreads({ initial, open: first }: { initial: ThreadView[]; open: string }) {
  const t = useT();
  const [threads, setThreads] = useState(initial);
  const [open, setOpen] = useState(first);
  const [archived, setArchived] = useState<ThreadView[] | null>(null);
  const refresh = useCallback(async () => {
    const body = await call("/api/conversation/threads", "GET") as { threads?: ThreadView[] };
    if (body.threads) setThreads(body.threads);
  }, []);
  // The address follows the open thread, so a reload or a shared link opens the same one.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("thread") === open) return;
    url.searchParams.set("thread", open);
    window.history.replaceState(null, "", url);
  }, [open]);
  const create = async () => {
    const body = await call("/api/conversation/threads", "POST", {}) as { thread?: ThreadView };
    if (!body.thread) return;
    setThreads((list) => [list[0]!, body.thread!, ...list.slice(1)]);
    setOpen(body.thread.id);
  };
  const change = async (id: string, patch: { title?: string; archived?: boolean }) => {
    const body = await call(`/api/conversation/threads/${encodeURIComponent(id)}`, "PATCH", patch) as { ok?: boolean };
    if (!body.ok) return;
    await refresh();
    if (archived) setArchived((await call("/api/conversation/threads?archived", "GET") as { threads?: ThreadView[] }).threads ?? []);
    if (patch.archived === true && id === open) setOpen(threads[0]!.id);
  };
  const current = [...threads, ...(archived ?? [])].find((thread) => thread.id === open);
  return <div className="assistant-page">
    <nav className="assistant-threads" aria-label={t("对话列表")}>
      <header><b>{t("对话")}</b><button type="button" className="ui-button" onClick={() => void create()}>{t("新对话")}</button></header>
      <ThreadList threads={threads} open={open} onOpen={setOpen} onChange={change} />
      <details onToggle={async (event) => {
        if ((event.target as HTMLDetailsElement).open && !archived) setArchived((await call("/api/conversation/threads?archived", "GET") as { threads?: ThreadView[] }).threads ?? []);
      }}>
        <summary className="muted">{t("已归档")}</summary>
        {archived && (archived.length ? <ThreadList threads={archived} open={open} onOpen={setOpen} onChange={change} />
          : <small className="muted">{t("没有归档的对话")}</small>)}
      </details>
    </nav>
    <section className="assistant-thread" aria-label={current ? threadName(current, t) : t("对话")}>
      <header><h2>{current ? threadName(current, t) : t("对话")}</h2>
        {current?.today && <small className="muted">{t("今日页的输入框和右下角的小帮手也写在这里")}</small>}
        {current?.archived && <small className="muted">{t("已归档；继续发言不会改变归档状态")}</small>}</header>
      {/* Today's conversation is addressed without an id, as every other box addresses it (its opener is said when it is first opened). */}
      <Conversation key={open} variant="thread" {...(current?.today ? {} : { threadId: open })} onSent={() => void refresh()} />
    </section>
  </div>;
}

/** The rows: open on click; 重命名 edits in place; 归档 / 恢复. Today's thread cannot be archived (every box writes to it). */
export function ThreadList({ threads, open, onOpen, onChange }: { threads: ThreadView[]; open: string; onOpen: (id: string) => void;
  onChange: (id: string, patch: { title?: string; archived?: boolean }) => void }) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  return <ul>{threads.map((thread) => <li key={thread.id} aria-current={thread.id === open ? "true" : undefined}>
    {editing === thread.id ? <form onSubmit={(event) => { event.preventDefault(); onChange(thread.id, { title: draft }); setEditing(null); }}>
      <input autoFocus aria-label={t("对话名称")} maxLength={60} value={draft} onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setEditing(null)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }} />
    </form> : <button type="button" className="thread-open" onClick={() => onOpen(thread.id)}>
      <span>{threadName(thread, t)}</span><small>{thread.today ? t("默认 · 今日") : new Date(thread.updatedAt).toLocaleDateString()}</small>
    </button>}
    {editing !== thread.id && <span className="thread-menu">
      <button type="button" className="text-button" aria-label={t("重命名「{{name}}」", { name: threadName(thread, t) })}
        onClick={() => { setDraft(thread.title); setEditing(thread.id); }}>{t("重命名")}</button>
      {!thread.today && <button type="button" className="text-button" aria-label={thread.archived ? t("恢复「{{name}}」", { name: threadName(thread, t) })
        : t("归档「{{name}}」", { name: threadName(thread, t) })} onClick={() => onChange(thread.id, { archived: !thread.archived })}>{thread.archived ? t("恢复") : t("归档")}</button>}
    </span>}
  </li>)}</ul>;
}
