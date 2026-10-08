"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAttachmentDrop } from "../attachment-drop";

const ACCEPTED_ATTACHMENT_TYPES = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain";

type Message = { from: "user" | "assistant"; text: string };
type AttachmentMeta = { id: string; fileName: string; mediaType: string };
type CaptureCard = { kind: "capture"; title: string; context: string };
type TemplateCard = { identityId: string; kind: string; titleHint: string; successCriteriaDefaults: unknown[] };
type TurnResponse =
  | { state: "replied"; reply: string; quickReplies: string[]; savedMaterial?: { uri: string; fileName: string };
      proposals?: CaptureCard[]; templateProposal?: TemplateCard }
  | { state: "blocked"; code: string; message: string }
  | { ok: false; blocker: { code: string; message: string } };

/**
 * The assistant's conversation, scoped: site-wide (the floating 小助手) or to one task (`workOrderId`, the task dialog's 对话 tab,
 * where the assistant sees that task first). The thread and its last 40 messages survive page loads in sessionStorage under
 * `storageKey`. Nothing the assistant proposes is written until the person clicks its card.
 */
export function AssistantChat({ workOrderId = null, storageKey, emptyText }: { workOrderId?: string | null; storageKey: string; emptyText: string }) {
  const [threadId, setThreadId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Array<CaptureCard & { id: string; state: "new" | "saving" | "saved" | "failed" }>>([]);
  const [template, setTemplate] = useState<(TemplateCard & { state: "new" | "saving" | "saved" | "failed" }) | null>(null);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const { fileInputRef, fileNames, dragOver, setDragOver, onDrop, onPaste, onInputChange, reset } = useAttachmentDrop(ACCEPTED_ATTACHMENT_TYPES.split(","));
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { threadId?: string; messages?: Message[] } | null;
      if (saved?.threadId && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.threadId)) setThreadId(saved.threadId);
      if (Array.isArray(saved?.messages)) setMessages(saved!.messages.slice(-40));
    } catch { /* private browsing */ }
  }, [storageKey]);
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify({ threadId, messages: messages.slice(-40) })); } catch { /* best effort */ } }, [storageKey, threadId, messages]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, status]);

  const uploadAttachments = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true); setStatus("");
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
    setSending(true); setStatus("");
    const history = messages.slice(-20);
    setMessages((current) => [...current, { from: "user", text: message }]);
    setQuickReplies([]);
    try {
      const response = await fetch("/api/assistant/turn", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, message, history, attachments: pendingAttachments, workOrderId }) });
      const body = await response.json().catch(() => null) as TurnResponse | null;
      setPendingAttachments([]);
      if (!body || "blocker" in body) { setMessages((current) => [...current, { from: "assistant", text: `暂时无法回复：${body?.blocker.message ?? "小助手不可用"}` }]); return; }
      if (body.state === "blocked") { setMessages((current) => [...current, { from: "assistant", text: `暂时无法回复：${body.message}` }]); return; }
      setMessages((current) => [...current, { from: "assistant", text: body.reply }]);
      setQuickReplies(body.quickReplies ?? []);
      setCards((body.proposals ?? []).map((card) => ({ ...card, id: crypto.randomUUID(), state: "new" as const })));
      setTemplate(body.templateProposal ? { ...body.templateProposal, state: "new" } : null);
      if (body.savedMaterial) setStatus(`已保存为任务材料：${body.savedMaterial.fileName}`);
    } catch { setMessages((current) => [...current, { from: "assistant", text: "网络不可用，消息未发送" }]); }
    finally { setSending(false); }
  };

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
    const input = event.currentTarget.elements.namedItem("message") as HTMLInputElement | null;
    if (!input?.value.trim()) return;
    void sendMessage(input.value);
    event.currentTarget.reset();
  };

  return <div className="assistant-chat">
    <div className="assistant-messages">
      {!messages.length && <p className="muted assistant-empty">{emptyText}</p>}
      {messages.map((item, index) => <p key={index} className={`assistant-message assistant-message-${item.from}${item.from === "assistant" ? " gen" : ""}`}>{item.text}</p>)}
      {cards.map((card) => <div key={card.id} className="assistant-card" role="group" aria-label="建议收集">
        <span className="gen">{card.title}</span>
        <button type="button" className="secondary-button" disabled={card.state === "saving" || card.state === "saved"} onClick={() => void captureCard(card.id)}>
          {card.state === "saved" ? "已收集" : card.state === "saving" ? "收集中…" : card.state === "failed" ? "重试" : "收集"}</button>
      </div>)}
      {template && <div className="assistant-card" role="group" aria-label="建议的里程碑模板">
        <span className="gen">里程碑模板：{template.titleHint}</span>
        <button type="button" className="secondary-button" disabled={template.state === "saving" || template.state === "saved"} onClick={() => void addTemplate()}>
          {template.state === "saved" ? "已添加" : template.state === "saving" ? "添加中…" : template.state === "failed" ? "重试" : "添加"}</button>
      </div>}
      <div ref={endRef} />
    </div>
    {quickReplies.length > 0 && <div className="assistant-quick-replies">
      {quickReplies.map((reply) => <button key={reply} type="button" className="secondary-button" onClick={() => void sendMessage(reply)}>{reply}</button>)}
    </div>}
    <form onSubmit={submit} onPaste={onPaste} className="assistant-form">
      <label className={`attachment-drop${dragOver ? " dragging" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { onDrop(event); void uploadAttachments([...event.dataTransfer.files]); }}>
        <span className="sr-only">附件</span>
        <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_ATTACHMENT_TYPES}
          onChange={(event) => { onInputChange(); void uploadAttachments([...(event.currentTarget.files ?? [])]); }} />
        <small>{uploading ? "上传中…" : pendingAttachments.length ? `已附加 ${pendingAttachments.length} 个文件` : fileNames.length ? fileNames.join("、") : "拖入或粘贴文件"}</small>
      </label>
      <div className="assistant-input-row">
        <label><span className="sr-only">消息</span><input name="message" maxLength={2000} placeholder="输入消息" disabled={sending} /></label>
        <button className="primary-button" type="submit" disabled={sending}>{sending ? "发送中" : "发送"}</button>
      </div>
      {status && <small className="muted" role="status">{status}</small>}
    </form>
  </div>;
}
