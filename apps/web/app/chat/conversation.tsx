"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ACTIONS, cardActionIndexes, type ConciergeTurn } from "@crossline/core";
import type { Card, CardChoices, MessageView, PageContext } from "../../lib/conversation";
import { CardFields, editableFields } from "./card-fields";
import { Composer, type ComposerInput } from "./composer";
import { captureLine } from "../offline-command-forms";
import { undoOperation } from "../undo-center";
import { Markdown } from "../ui/markdown";
import { ClampBlock } from "../ui/clamp";
import { announceThinking, HelperFace, useHelper } from "../helper-state";
import { OpenerCard } from "./opener-card";
import { useT } from "../locale-context";

const PENDING_EVENTS = ["crossline:pending-changed", "crossline:plan-changed"];
const ACCOUNT_KEY = "crossline-conversation-account";

/** Where the person is typing from, read from the address: a task's page, an open milestone, the plan, or another page. */
export function pageFromLocation(): PageContext {
  if (typeof window === "undefined") return { kind: "", entityId: "" };
  const { pathname, searchParams } = new URL(window.location.href);
  const task = /^\/workbench\/([^/]+)/.exec(pathname);
  if (task) return { kind: "task", entityId: decodeURIComponent(task[1]!) };
  if (pathname.startsWith("/milestones") && searchParams.get("open")) return { kind: "milestone", entityId: searchParams.get("open")! };
  // A line: its card on 主线 (the card sets `?line=` while the person works in it) or its own interview.
  if ((pathname.startsWith("/milestones") || pathname.startsWith("/onboarding")) && searchParams.get("line")) return { kind: "line", entityId: searchParams.get("line")! };
  return { kind: pathname === "/" ? "today" : pathname.slice(1).split("/")[0] ?? "", entityId: "" };
}

/**
 * The one input box (docs/one-input.md): what the person types is kept, read, and answered in place — an answer, a card of proposed
 * actions carried out on 执行 (each undoable), or one question back. Today's conversation is shared by every page and device; the
 * floating 小帮手 is the same conversation opened larger. Files are read and proposed for; offline, a line is kept as a capture the old way.
 */
export function Conversation({ variant, placeholder, page }: {
  /**
   * `inline`: Today's box with the latest exchange under it; `panel`: the whole day's conversation, with search; `task`: a task's own
   * entry — the box first, then only what was said from this task's page.
   */
  variant: "inline" | "panel" | "task"; placeholder?: string;
  /** Fixed for an entry that belongs to one object (a task dialog); otherwise read from the address. */
  page?: PageContext;
}) {
  const t = useT();
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [choices, setChoices] = useState<CardChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  // Who is signed in, for the offline queue; remembered so a box opened without a connection can still keep a line.
  const [account, setAccount] = useState<{ ownerId: string; workspaceId: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null") as { ownerId: string; workspaceId: string } | null; } catch { return null; }
  });

  const load = (withChoices = false) => fetch(`/api/conversation${withChoices ? "?choices" : ""}`).then((response) => response.ok ? response.json() : null)
    .then((body: { messages?: MessageView[]; ownerId?: string; workspaceId?: string; choices?: CardChoices } | null) => {
      if (body?.messages) setMessages(body.messages);
      if (body?.choices) setChoices(body.choices);
      if (body?.ownerId && body.workspaceId) {
        const ids = { ownerId: body.ownerId, workspaceId: body.workspaceId };
        setAccount(ids);
        try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(ids)); } catch { /* private browsing */ }
      }
    }).catch(() => {});
  useEffect(() => {
    void load(true);
    // Another page or device may have added to today's conversation, and the system speaks first now and then (docs/one-input.md §4).
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => { document.removeEventListener("visibilitychange", refresh); clearInterval(timer); };
  }, []);
  useEffect(() => { if (variant === "panel") endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, variant]);
  // A card the stronger model is looking at again is fetched until it comes back (a few seconds to half a minute).
  const reviewing = messages.some((message) => message.card?.reviewing);
  useEffect(() => {
    if (!reviewing) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [reviewing]); // eslint-disable-line react-hooks/exhaustive-deps

  const keepAsCapture = async (input: ComposerInput, failure: string) => {
    const kept = account ? await captureLine(account.ownerId, account.workspaceId, input, t) : null;
    setStatus(kept ?? t(failure));
    return kept !== null;
  };
  const submit = async (input: ComposerInput): Promise<boolean> => {
    setStatus("");
    if (!navigator.onLine) return keepAsCapture(input, "未能保存，请复制内容后重试");
    setBusy(true);
    try {
      // Files are stored and read first, then sent with the line by id: the box says what each one is and what to do with it.
      let files: string[] = [];
      if (input.files.length) {
        setStatus(t("正在读取文件…"));
        const form = new FormData();
        for (const file of input.files) form.append("file", file);
        const uploaded = await fetch("/api/conversation/files", { method: "POST", body: form });
        const result = await uploaded.json().catch(() => null) as { ok?: boolean; documents?: Array<{ id: string }>; message?: string } | null;
        if (!uploaded.ok || !result?.documents) { setStatus(result?.message ?? t("文件未能保存，请重试")); return false; }
        files = result.documents.map((doc) => doc.id);
        setStatus("");
      }
      announceThinking(true);
      const response = await fetch("/api/conversation/turn", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input.text, mentions: input.mentions, page: page ?? pageFromLocation(), files }) });
      const body = await response.json().catch(() => null) as { messages?: MessageView[] } | null;
      if (!response.ok || !body?.messages) { setStatus(t("未能发送，请重试")); return false; }
      setMessages((list) => [...list, ...body.messages!]);
      return true;
    } catch {
      return keepAsCapture(input, "未能发送，请复制内容后重试");
    } finally { setBusy(false); announceThinking(false); }
  };

  const update = (message: MessageView) => {
    setMessages((list) => list.map((item) => item.id === message.id ? message : item));
    for (const name of PENDING_EVENTS) window.dispatchEvent(new Event(name));
  };

  // Today's box shows the latest exchange only; the panel shows the day; a task's entry shows what was said from its page.
  const shown = variant === "inline" ? lastExchange(messages) : variant === "task" && page ? fromPage(messages, page) : messages;
  // On a page (Today, the return page) a long reply is held to three lines; the full conversation shows it whole.
  const item = (message: MessageView) => <MessageItem key={message.id} message={message} onUpdate={update} choices={choices} compact={variant === "inline"} />;
  if (variant === "task") return <div className="conversation" data-variant={variant}>
    <Composer mode="capture" busy={busy} placeholder={t(placeholder ?? "对该任务的指令或问题：改截止、这一步做完了、记进度、推迟、讲解某一步…")} onSubmit={submit}>
      {busy && <small className="muted composer-status" role="status">{t("正在理解…")}</small>}
      {status && <small className="muted composer-status" role="status">{status}</small>}
    </Composer>
    {shown.length > 0 && <ol className="conversation-log" aria-label={t("关于该任务的对话")}>{shown.slice(-6).map(item)}</ol>}
  </div>;
  return <div className="conversation" data-variant={variant}>
    {variant === "panel" && <ConversationSearch />}
    {variant === "panel" && <ol className="conversation-log" aria-label={t("今天的对话")}>
      {shown.map(item)}
      <div ref={endRef} />
    </ol>}
    <Composer mode="capture" busy={busy} placeholder={t(placeholder ?? "任务、改期、回答待决、撤销、日程、问题……一句话即可")} onSubmit={submit}
      takeShare={variant === "inline"}>
      {busy && <small className="muted composer-status" role="status">{t("正在理解…")}</small>}
      {status && <small className="muted composer-status" role="status">{status}</small>}
    </Composer>
    {variant === "inline" && shown.length > 0 && <ol className="conversation-log" aria-label={t("最近一次对话")}>
      {shown.map(item)}
    </ol>}
  </div>;
}

/** What was said from one page: each message typed there, with the answers that followed it. */
function fromPage(messages: MessageView[], page: PageContext): MessageView[] {
  const out: MessageView[] = [];
  let keep = false;
  for (const message of messages) {
    if (message.role === "person") keep = message.page?.entityId === page.entityId && message.page.kind === page.kind;
    if (keep) out.push(message);
  }
  return out;
}

/** The person's last message and everything after it. */
function lastExchange(messages: MessageView[]): MessageView[] {
  const index = messages.map((message) => message.role).lastIndexOf("person");
  return index < 0 ? messages.slice(-1) : messages.slice(index);
}

function MessageItem({ message, onUpdate, choices, compact = false }: { message: MessageView; onUpdate: (message: MessageView) => void; choices: CardChoices | null; compact?: boolean }) {
  const { avatar } = useHelper();
  if (message.role === "person") return <li className="conversation-person"><p>{message.text}</p></li>;
  // The 小帮手 speaks with the upper half of the person's figure (the 分身); the person's own lines carry no face.
  return <li className={message.role === "nudge" ? "conversation-reply conversation-nudge" : "conversation-reply"} data-face={avatar ? "" : undefined}>
    {avatar && <HelperFace src={avatar} size="reply" />}
    {message.text && (compact ? <div className="gen"><ClampBlock><Markdown text={message.text} /></ClampBlock></div> : <div className="gen"><Markdown text={message.text} /></div>)}
    {message.card && <CardView messageId={message.id} card={message.card} onUpdate={onUpdate} choices={choices}
      {...(message.opener ? { body: <OpenerCard opener={message.opener} /> } : {})} />}
  </li>;
}

/**
 * A turn's card: the actions proposed (执行 carries out every pending one), and the question back when there is one. `body` draws the
 * question instead of its text (the day's opener, as a card). Exported for its test and for the return page.
 */
export function CardView({ messageId, card, onUpdate, choices, body }: { messageId: string; card: Card; onUpdate: (message: MessageView) => void;
  choices: CardChoices | null; body?: ReactNode }) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // Fields changed on the card, by action index; sent with 执行 and checked again on the server.
  const [edits, setEdits] = useState<Record<number, Record<string, unknown>>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const decide = async (decision: { option?: number; dismiss?: boolean; indexes?: number[] }) => {
    setWorking(true); setError("");
    try {
      const response = await fetch("/api/conversation/decide", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, ...decision, ...(Object.keys(edits).length && !decision.dismiss ? { edits } : {}) }) });
      const body = await response.json().catch(() => null) as { ok?: boolean; message?: MessageView; code?: string } | null;
      if (body?.ok && body.message) { onUpdate(body.message); setEdits({}); setEditing(null); }
      else setError(body?.code === "CARD_REVIEWING" ? t("仍在核对，稍候再执行") : t("未能执行，请刷新后重试"));
    } finally { setWorking(false); }
  };
  const visible = cardActionIndexes({ actions: card.actions, clarify: card.clarify } as ConciergeTurn);
  const chosen = card.clarify.chosen !== undefined ? card.clarify.options[card.clarify.chosen] : undefined;
  const ran = [...visible, ...(chosen?.actions ?? [])];
  const pending = visible.filter((index) => card.items[index]?.state === "pending");
  // An answer with nothing to carry out, ask or report has no card: an empty one drew a grey bar under every plain reply.
  if (!card.reviewing && !(card.reviewed && card.revised) && !ran.length && !card.clarify.question && !error) return null;
  return <div className="conversation-card" data-error={card.error ? "" : undefined} aria-busy={card.reviewing || undefined}>
    {card.reviewing && <small className="conversation-reviewing" role="status">{t("正在用更强的模型仔细核对…")}</small>}
    {card.reviewed && card.revised && <small className="muted">{t("已核对并修改")}</small>}
    {ran.length > 0 && <ul>{ran.map((index) => <ActionRow key={index} card={card} index={index}
      {...(card.items[index]?.state === "pending" && !card.reviewing && editableFields(card.actions[index]!).length ? {
        editing: editing === index, onEdit: () => setEditing(editing === index ? null : index),
        fields: <CardFields item={card.actions[index]!} value={edits[index] ?? {}} choices={choices}
          onChange={(field, next) => setEdits((all) => ({ ...all, [index]: { ...(all[index] ?? {}), [field]: next } }))} />,
        changed: Boolean(edits[index] && Object.keys(edits[index]!).length) } : {})} />)}</ul>}
    {card.clarify.question && <div className="conversation-clarify">
      {body ?? (card.nudgeKind ? <Markdown text={card.clarify.question} /> : <p>{card.clarify.question}</p>)}
      {chosen ? <small className="muted">{t("已选：{{label}}", { label: chosen.label })}</small>
        : <div className="conversation-options">{card.clarify.options.map((option, index) =>
          <button type="button" key={index} disabled={working} onClick={async () => {
            const focusBox = () => document.querySelector<HTMLTextAreaElement>(".conversation textarea")?.focus();
            // A turn's option with nothing to carry out: the person says more in the box (nothing to record yet).
            if (!option.kind && !option.actions.length) { focusBox(); return; }
            // A nudge's button is the answer whatever it does: recorded first, then the page opens or the box takes focus.
            await decide({ option: index });
            if (option.kind === "href" && option.href) window.location.assign(option.href);
            if (option.kind === "say") focusBox();
          }}>{option.label}</button>)}</div>}
    </div>}
    {pending.length > 0 && <div className="conversation-actions">
      <button type="button" className="primary-button" disabled={working || card.reviewing} onClick={() => void decide({ indexes: pending })}>
        {working ? t("执行中…") : pending.length > 1 ? t("全部执行（{{count}}）", { count: pending.length }) : t("执行")}</button>
      <button type="button" className="text-button" disabled={working} onClick={() => void decide({ indexes: pending, dismiss: true })}>{t("不用了")}</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

const STATE_WORD: Record<string, string> = { pending: "待执行", done: "已执行", failed: "未执行", dismissed: "已取消" };

function ActionRow({ card, index, editing, onEdit, fields, changed }: { card: Card; index: number; editing?: boolean; onEdit?: () => void;
  fields?: ReactNode; changed?: boolean }) {
  const t = useT();
  const action = card.actions[index]!;
  const item = card.items[index] ?? { state: "pending" };
  const [undone, setUndone] = useState("");
  return <li data-state={item.state} data-risk={ACTIONS[action.action].risk}>
    <b>{t(ACTIONS[action.action].label)}</b><span className="gen">{action.summary}</span>
    <small className="conversation-state">{undone || (changed && item.state === "pending" ? t("已修改，待执行") : STATE_WORD[item.state] ? t(STATE_WORD[item.state]!) : "")}</small>
    {onEdit && <button type="button" className="text-button" aria-expanded={editing} onClick={onEdit}>{editing ? t("收起") : t("修改")}</button>}
    {editing && fields}
    {item.message && <small className="muted">{item.message}</small>}
    {item.state === "done" && <span className="conversation-links">
      {item.href && <a href={item.href}>{t("查看 →")}</a>}
      {item.opId && !undone && <button type="button" className="text-button" onClick={async () => {
        const result = await undoOperation(item.opId!, t);
        setUndone(result.ok ? t("已撤销") : result.message);
      }}>{t("撤销")}</button>}
    </span>}
  </li>;
}

/** Notes jotted in the box live only in the conversation; this finds them, and anything else said, on any day. */
function ConversationSearch() {
  const t = useT();
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
    <input type="search" value={query} placeholder={t("搜索对话记录")} aria-label={t("搜索对话记录")} onChange={(event) => setQuery(event.target.value)} />
    {query.trim() && <ul>{results.length ? results.map((item) => <li key={item.id}><small className="mono">{item.day}</small> {item.text.slice(0, 120)}</li>)
      : <li className="muted">{t("无匹配")}</li>}</ul>}
  </div>;
}
