"use client";

import { useEffect, useRef, useState } from "react";
import { ACTIONS, cardActionIndexes, type ConciergeTurn } from "@crossline/core";
import type { Card, MessageView, PageContext } from "../../lib/conversation";
import { Composer, type ComposerInput } from "./composer";
import { captureLine } from "../offline-command-forms";
import { undoOperation } from "../undo-center";
import { Markdown } from "../ui/markdown";

const PENDING_EVENTS = ["crossline:pending-changed", "crossline:plan-changed"];
const ACCOUNT_KEY = "crossline-conversation-account";

/** Where the person is typing from, read from the address: a task's page, an open milestone, the plan, or another page. */
export function pageFromLocation(): PageContext {
  if (typeof window === "undefined") return { kind: "", entityId: "" };
  const { pathname, searchParams } = new URL(window.location.href);
  const task = /^\/workbench\/([^/]+)/.exec(pathname);
  if (task) return { kind: "task", entityId: decodeURIComponent(task[1]!) };
  if (pathname.startsWith("/milestones") && searchParams.get("open")) return { kind: "milestone", entityId: searchParams.get("open")! };
  return { kind: pathname === "/" ? "today" : pathname.slice(1).split("/")[0] ?? "", entityId: "" };
}

/**
 * The one input box (docs/one-input.md): what the person types is kept, read, and answered in place — an answer, a card of proposed
 * actions carried out on 执行 (each undoable), or one question back. Today's conversation is shared by every page and device; the
 * floating 小助手 is the same conversation opened larger. Offline, and for attached files, a line is kept as a capture the old way.
 */
export function Conversation({ variant, placeholder }: {
  /** `inline`: Today's box with the latest exchange under it; `panel`: the whole day's conversation, with search. */
  variant: "inline" | "panel"; placeholder?: string;
}) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  // Who is signed in, for the offline queue; remembered so a box opened without a connection can still keep a line.
  const [account, setAccount] = useState<{ ownerId: string; workspaceId: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null") as { ownerId: string; workspaceId: string } | null; } catch { return null; }
  });

  const load = () => fetch("/api/conversation").then((response) => response.ok ? response.json() : null)
    .then((body: { messages?: MessageView[]; ownerId?: string; workspaceId?: string } | null) => {
      if (body?.messages) setMessages(body.messages);
      if (body?.ownerId && body.workspaceId) {
        const ids = { ownerId: body.ownerId, workspaceId: body.workspaceId };
        setAccount(ids);
        try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(ids)); } catch { /* private browsing */ }
      }
    }).catch(() => {});
  useEffect(() => {
    void load();
    // Another page or device may have added to today's conversation.
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  useEffect(() => { if (variant === "panel") endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, variant]);

  const keepAsCapture = async (input: ComposerInput, failure: string) => {
    const kept = account ? await captureLine(account.ownerId, account.workspaceId, input) : null;
    setStatus(kept ?? failure);
    return kept !== null;
  };
  const submit = async (input: ComposerInput): Promise<boolean> => {
    setStatus("");
    if (!navigator.onLine || input.files.length) return keepAsCapture(input, "未能保存，请复制内容后重试");
    setBusy(true);
    try {
      const response = await fetch("/api/conversation/turn", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input.text, mentions: input.mentions, page: pageFromLocation() }) });
      const body = await response.json().catch(() => null) as { messages?: MessageView[] } | null;
      if (!response.ok || !body?.messages) { setStatus("未能发送，请重试"); return false; }
      setMessages((list) => [...list, ...body.messages!]);
      return true;
    } catch {
      return keepAsCapture(input, "未能发送，请复制内容后重试");
    } finally { setBusy(false); }
  };

  const update = (message: MessageView) => {
    setMessages((list) => list.map((item) => item.id === message.id ? message : item));
    for (const name of PENDING_EVENTS) window.dispatchEvent(new Event(name));
  };

  // Today's box shows the latest exchange only; the panel shows the day.
  const shown = variant === "inline" ? lastExchange(messages) : messages;
  return <div className="conversation" data-variant={variant}>
    {variant === "panel" && <ConversationSearch />}
    {variant === "panel" && <ol className="conversation-log" aria-label="今天的对话">
      {shown.map((message) => <MessageItem key={message.id} message={message} onUpdate={update} />)}
      <div ref={endRef} />
    </ol>}
    <Composer mode="capture" busy={busy} placeholder={placeholder ?? "任务、改期、回答待决、撤销、日程、问题……一句话即可"} onSubmit={submit}>
      {busy && <small className="muted composer-status" role="status">正在理解…</small>}
      {status && <small className="muted composer-status" role="status">{status}</small>}
    </Composer>
    {variant === "inline" && shown.length > 0 && <ol className="conversation-log" aria-label="最近一次对话">
      {shown.map((message) => <MessageItem key={message.id} message={message} onUpdate={update} />)}
    </ol>}
  </div>;
}

/** The person's last message and everything after it. */
function lastExchange(messages: MessageView[]): MessageView[] {
  const index = messages.map((message) => message.role).lastIndexOf("person");
  return index < 0 ? messages.slice(-1) : messages.slice(index);
}

function MessageItem({ message, onUpdate }: { message: MessageView; onUpdate: (message: MessageView) => void }) {
  if (message.role === "person") return <li className="conversation-person"><p>{message.text}</p></li>;
  return <li className="conversation-reply">
    {message.text && <div className="gen"><Markdown text={message.text} /></div>}
    {message.card && <CardView messageId={message.id} card={message.card} onUpdate={onUpdate} />}
  </li>;
}

/** A turn's card: the actions proposed (执行 carries out every pending one), and the question back when there is one. */
function CardView({ messageId, card, onUpdate }: { messageId: string; card: Card; onUpdate: (message: MessageView) => void }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const decide = async (decision: { option?: number; dismiss?: boolean; indexes?: number[] }) => {
    setWorking(true); setError("");
    try {
      const response = await fetch("/api/conversation/decide", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, ...decision }) });
      const body = await response.json().catch(() => null) as { ok?: boolean; message?: MessageView } | null;
      if (body?.ok && body.message) onUpdate(body.message); else setError("未能执行，请刷新后重试");
    } finally { setWorking(false); }
  };
  const visible = cardActionIndexes({ actions: card.actions, clarify: card.clarify } as ConciergeTurn);
  const chosen = card.clarify.chosen !== undefined ? card.clarify.options[card.clarify.chosen] : undefined;
  const ran = [...visible, ...(chosen?.actions ?? [])];
  const pending = visible.filter((index) => card.items[index]?.state === "pending");
  return <div className="conversation-card" data-error={card.error ? "" : undefined}>
    {ran.length > 0 && <ul>{ran.map((index) => <ActionRow key={index} card={card} index={index} />)}</ul>}
    {card.clarify.question && <div className="conversation-clarify">
      <p>{card.clarify.question}</p>
      {chosen ? <small className="muted">已选：{chosen.label}</small>
        : <div className="conversation-options">{card.clarify.options.map((option, index) =>
          <button type="button" key={index} disabled={working} onClick={() => option.actions.length
            ? void decide({ option: index })
            // Nothing to carry out: the person says more in the box.
            : document.querySelector<HTMLTextAreaElement>(".conversation textarea")?.focus()}>{option.label}</button>)}</div>}
    </div>}
    {pending.length > 0 && <div className="conversation-actions">
      <button type="button" className="primary-button" disabled={working} onClick={() => void decide({ indexes: pending })}>
        {working ? "执行中…" : pending.length > 1 ? `全部执行（${pending.length}）` : "执行"}</button>
      <button type="button" className="text-button" disabled={working} onClick={() => void decide({ indexes: pending, dismiss: true })}>不用了</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

const STATE_WORD: Record<string, string> = { pending: "待执行", done: "已执行", failed: "未执行", dismissed: "已取消" };

function ActionRow({ card, index }: { card: Card; index: number }) {
  const action = card.actions[index]!;
  const item = card.items[index] ?? { state: "pending" };
  const [undone, setUndone] = useState("");
  return <li data-state={item.state} data-risk={ACTIONS[action.action].risk}>
    <b>{ACTIONS[action.action].label}</b><span className="gen">{action.summary}</span>
    <small className="conversation-state">{undone || STATE_WORD[item.state]}</small>
    {item.message && <small className="muted">{item.message}</small>}
    {item.state === "done" && <span className="conversation-links">
      {item.href && <a href={item.href}>查看 →</a>}
      {item.opId && !undone && <button type="button" className="text-button" onClick={async () => {
        const result = await undoOperation(item.opId!);
        setUndone(result.ok ? "已撤销" : result.message);
      }}>撤销</button>}
    </span>}
  </li>;
}

/** Notes jotted in the box live only in the conversation; this finds them, and anything else said, on any day. */
function ConversationSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<MessageView & { day: string }>>([]);
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/conversation/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : { results: [] })
        .then((body: { results?: Array<MessageView & { day: string }> }) => setResults(body.results ?? [])).catch(() => {});
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  return <div className="conversation-search">
    <input type="search" value={query} placeholder="搜索对话记录" aria-label="搜索对话记录" onChange={(event) => setQuery(event.target.value)} />
    {query.trim() && <ul>{results.length ? results.map((item) => <li key={item.id}><small className="mono">{item.day}</small> {item.text.slice(0, 120)}</li>)
      : <li className="muted">无匹配</li>}</ul>}
  </div>;
}
