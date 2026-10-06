"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAttachmentDrop } from "./attachment-drop";

const ACCEPTED_ATTACHMENT_TYPES = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain";
const OPEN_STORAGE_KEY = "crossline-assistant-open";

type Message = { from: "user" | "assistant"; text: string };
type AttachmentMeta = { id: string; fileName: string; mediaType: string };

type TurnResponse =
  | { state: "replied"; reply: string; quickReplies: string[]; savedMaterial?: { uri: string; fileName: string } }
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
  const [threadId] = useState(newThreadId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const { fileInputRef, fileNames, dragOver, setDragOver, onDrop, onPaste, onInputChange, reset } =
    useAttachmentDrop(ACCEPTED_ATTACHMENT_TYPES.split(","));
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { setOpen(localStorage.getItem(OPEN_STORAGE_KEY) === "1"); } catch { /* private browsing, etc. */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(OPEN_STORAGE_KEY, open ? "1" : "0"); } catch { /* best-effort only */ }
  }, [open]);
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
      if (body.savedMaterial) setStatus(`已保存为任务材料：${body.savedMaterial.fileName}`);
    } catch {
      setMessages((current) => [...current, { from: "assistant", text: "（网络不可用，消息未发送）" }]);
    } finally { setSending(false); }
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
      {!messages.length && <p className="muted assistant-empty">问点什么，或贴一段代码需求——不会读写这个仓库本身，只回答问题、生成的脚本会存成任务材料。</p>}
      {messages.map((item, index) => <p key={index} className={`assistant-message assistant-message-${item.from}`}>{item.text}</p>)}
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
