"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAttachmentDrop } from "./attachment-drop";

const ACCEPTED_ATTACHMENT_TYPES = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain";
// The conversation survives moving between pages (they are full page loads); the panel being open does not —
// it used to reopen itself on every page and cover the content underneath.
const SESSION_KEY = "crossline-assistant-session";

type Message = { from: "user" | "assistant"; text: string };
type AttachmentMeta = { id: string; fileName: string; mediaType: string };

type CaptureCard = { kind: "capture"; title: string; context: string };
type TemplateCard = { identityId: string; kind: string; titleHint: string; successCriteriaDefaults: unknown[] };
type TurnResponse =
  | { state: "replied"; reply: string; quickReplies: string[]; savedMaterial?: { uri: string; fileName: string };
      proposals?: CaptureCard[]; templateProposal?: TemplateCard }
  | { state: "blocked"; code: string; message: string }
  | { ok: false; blocker: { code: string; message: string } };

function newThreadId(): string {
  // `assistant_threads`/`assistant_attachments` ids follow the same `^[a-zA-Z0-9_-]{1,128}$` shape every
  // other id in this app does — `crypto.randomUUID()` already satisfies it.
  return crypto.randomUUID();
}

/**
 * The site-wide floating assistant: a minimized bubble by default, expandable into a Codex-style panel
 * (free text + quick-reply buttons + file attachments). Mounted next to `<BottomNav />` in both
 * `subpage-shell.tsx` and `dashboard-view.tsx`, the same "every page has one" placement pattern those two
 * already share — it manages its own client-side state and talks to `/api/assistant/*` directly, exactly
 * like `OfflineCaptureForm` does for `/api/commands`.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState(newThreadId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Array<CaptureCard & { id: string; state: "new" | "saving" | "saved" | "failed" }>>([]);
  const [template, setTemplate] = useState<(TemplateCard & { state: "new" | "saving" | "saved" | "failed" }) | null>(null);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const { fileInputRef, fileNames, dragOver, setDragOver, onDrop, onPaste, onInputChange, reset } =
    useAttachmentDrop(ACCEPTED_ATTACHMENT_TYPES.split(","));
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as { threadId?: string; messages?: Message[] } | null;
      if (saved?.threadId && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.threadId)) setThreadId(saved.threadId);
      if (Array.isArray(saved?.messages)) setMessages(saved!.messages.slice(-40));
    } catch { /* private browsing, etc. */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ threadId, messages: messages.slice(-40) })); } catch { /* best-effort only */ }
  }, [threadId, messages]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, status]);

  const uploadAttachments = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setStatus("");
    try {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      const response = await fetch(`/api/assistant/${encodeURIComponent(threadId)}/attachments`, { method: "POST", body: form });
      const body = await response.json().catch(() => null) as { saved?: AttachmentMeta[]; message?: string } | null;
      if (!response.ok || !body?.saved) { setStatus(body?.message ?? "附件上传失败，请重试"); return; }
      setPendingAttachments((current) => [...current, ...body.saved!]);
    } catch { setStatus("附件上传失败，请检查网络"); }
    finally { setUploading(false); reset(); }
  };

  const sendMessage = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setStatus("");
    const history = messages.slice(-20);
    setMessages((current) => [...current, { from: "user", text: message }]);
    setQuickReplies([]);
    try {
      const response = await fetch("/api/assistant/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, message, history, attachments: pendingAttachments, workOrderId: null })
      });
      const body = await response.json().catch(() => null) as TurnResponse | null;
      setPendingAttachments([]);
      if (!body || "blocker" in body) {
        setMessages((current) => [...current, { from: "assistant", text: `（遇到问题：${body?.blocker.message ?? "助手暂时不可用"}）` }]);
        return;
      }
      if (body.state === "blocked") {
        setMessages((current) => [...current, { from: "assistant", text: `（遇到问题：${body.message}）` }]);
        return;
      }
      setMessages((current) => [...current, { from: "assistant", text: body.reply }]);
      setQuickReplies(body.quickReplies ?? []);
      setCards((body.proposals ?? []).map((card) => ({ ...card, id: crypto.randomUUID(), state: "new" as const })));
      setTemplate(body.templateProposal ? { ...body.templateProposal, state: "new" } : null);
      if (body.savedMaterial) setStatus(`已保存为任务材料：${body.savedMaterial.fileName}`);
    } catch {
      setMessages((current) => [...current, { from: "assistant", text: "（网络不可用，消息未发送）" }]);
    } finally { setSending(false); }
  };

  // A card writes nothing until the person clicks it — the assistant only proposes.
  const captureCard = async (id: string) => {
    const card = cards.find((item) => item.id === id);
    if (!card || card.state === "saving" || card.state === "saved") return;
    setCards((current) => current.map((item) => item.id === id ? { ...item, state: "saving" } : item));
    const response = await fetch("/api/assistant/capture", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId: id, title: card.title, context: card.context }) }).catch(() => null);
    setCards((current) => current.map((item) => item.id === id ? { ...item, state: response?.ok ? "saved" : "failed" } : item));
  };
  const addTemplate = async () => {
    if (!template || template.state === "saving" || template.state === "saved") return;
    setTemplate({ ...template, state: "saving" });
    const { state: _state, ...input } = template;
    void _state;
    const response = await fetch("/api/milestones/templates", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, source: "assistant" }) }).catch(() => null);
    setTemplate({ ...template, state: response?.ok ? "saved" : "failed" });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("message") as HTMLInputElement | null;
    const text = input?.value ?? "";
    if (!text.trim()) return;
    void sendMessage(text);
    form.reset();
  };

  if (!open) {
    return <button type="button" className="assistant-bubble" onClick={() => setOpen(true)} aria-label="打开问答">
      问答
    </button>;
  }

  return <section className="assistant-panel" aria-label="问答">
    <header>
      <span>问答</span>
      <button type="button" className="text-button" onClick={() => setOpen(false)} aria-label="收起问答">收起</button>
    </header>
    <div className="assistant-messages">
      {!messages.length && <p className="muted assistant-empty">问你的这周、截止日、下一步做什么都行——它看得到你的里程碑、计划和待决事项，但不会替你改任何东西；需要动手时会给你一张卡片，你点了才算。</p>}
      {messages.map((item, index) => <p key={index} className={`assistant-message assistant-message-${item.from}`}>{item.text}</p>)}
      {cards.map((card) => <div key={card.id} className="assistant-card" role="group" aria-label="建议收集">
        <span>{card.title}</span>
        <button type="button" className="secondary-button" disabled={card.state === "saving" || card.state === "saved"} onClick={() => void captureCard(card.id)}>
          {card.state === "saved" ? "已收集" : card.state === "saving" ? "收集中…" : card.state === "failed" ? "没收集上，重试" : "收集"}</button>
      </div>)}
      {template && <div className="assistant-card" role="group" aria-label="建议的里程碑模板">
        <span>里程碑模板：{template.titleHint}</span>
        <button type="button" className="secondary-button" disabled={template.state === "saving" || template.state === "saved"} onClick={() => void addTemplate()}>
          {template.state === "saved" ? "已添加" : template.state === "saving" ? "添加中…" : template.state === "failed" ? "没添加上，重试" : "添加这个模板"}</button>
      </div>}
      <div ref={messagesEndRef} />
    </div>
    {quickReplies.length > 0 && <div className="assistant-quick-replies">
      {quickReplies.map((reply) => <button key={reply} type="button" className="secondary-button" onClick={() => void sendMessage(reply)}>{reply}</button>)}
    </div>}
    <form onSubmit={submit} onPaste={onPaste} className="assistant-form">
      <label className={`attachment-drop${dragOver ? " dragging" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { onDrop(event); void uploadAttachments([...event.dataTransfer.files]); }}>
        <span className="sr-only">附件</span>
        <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_ATTACHMENT_TYPES}
          onChange={(event) => { onInputChange(); void uploadAttachments([...(event.currentTarget.files ?? [])]); }} />
        <small>
          {uploading ? "上传中…" : pendingAttachments.length ? `已附加 ${pendingAttachments.length} 个文件，随下一条消息发送`
            : fileNames.length ? fileNames.join("、") : "拖文件到这里附加，或 Ctrl+V 粘贴"}
        </small>
      </label>
      <div className="assistant-input-row">
        <label><span className="sr-only">消息</span><input name="message" maxLength={2000} placeholder="输入消息…" disabled={sending} /></label>
        <button className="primary-button" type="submit" disabled={sending}>{sending ? "发送中…" : "发送"}</button>
      </div>
      {status && <small className="muted" role="status">{status}</small>}
    </form>
  </section>;
}
